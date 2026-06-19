import { type ExecException, execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { remark } from "remark";
import remarkFrontmatter from "remark-frontmatter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import remarkLintFrontmatterValidation from "../src/plugin.js";
import { validateMarkdown } from "../src/validate.js";

const execFileAsync = promisify(execFile);

interface FailedCommand {
    readonly code: number | undefined;
    readonly stdout: string;
}

interface RemoteFixture {
    readonly close: () => Promise<void>;
    readonly requests: () => number;
    readonly url: string;
}

async function createRemoteSchema(schema: unknown): Promise<RemoteFixture> {
    let requests = 0;
    const server = createServer((request, response) => {
        if (request.url === "/schema.json") {
            requests += 1;
            response.setHeader("content-type", "application/schema+json");
            response.end(JSON.stringify(schema));
            return;
        }

        response.statusCode = 404;
        response.end("not found");
    });

    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Expected an IPv4 test server address.");
    }

    return {
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.close((error) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            }),
        requests: () => requests,
        url: `http://127.0.0.1:${address.port}/schema.json`,
    };
}

async function expectCliFailure(
    command: readonly string[]
): Promise<FailedCommand> {
    try {
        await execFileAsync(process.execPath, command);
    } catch (error) {
        const cliError = error as ExecException & { readonly stdout?: string };

        return {
            code: typeof cliError.code === "number" ? cliError.code : undefined,
            stdout: cliError.stdout ?? "",
        };
    }

    throw new Error("Expected CLI command to fail.");
}

async function tempDirectory(): Promise<string> {
    return mkdtemp(path.join(tmpdir(), "frontmatter-validation-"));
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe(validateMarkdown, () => {
    let cwd: string;

    beforeEach(async () => {
        cwd = await tempDirectory();
    });

    afterEach(async () => {
        await rm(cwd, { force: true, recursive: true });
    });

    it("validates YAML frontmatter from an in-file local schema directive", async () => {
        const schemaPath = path.join(cwd, "schema.json");
        const markdownPath = path.join(cwd, "post.md");

        await writeJson(schemaPath, {
            additionalProperties: false,
            properties: {
                title: { type: "string" },
            },
            required: ["title"],
            type: "object",
        });

        const result = await validateMarkdown(
            `---\n$schema: ./schema.json\ntitle: 42\n---\n\n# Hello\n`,
            markdownPath,
            { cwd }
        );

        expect(result.findings).not.toHaveLength(0);
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]?.reason).toContain("Must be string");
        expect(result.findings[0]?.line).toBe(3);
    });

    it("validates TOML frontmatter", async () => {
        const markdownPath = path.join(cwd, "post.markdown");

        const result = await validateMarkdown(
            `+++\ntitle = 42\n+++\n\n# Hello\n`,
            markdownPath,
            {
                cwd,
                embed: {
                    properties: {
                        title: { type: "string" },
                    },
                    required: ["title"],
                    type: "object",
                },
            }
        );

        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]?.line).toBe(2);
    });

    it("uses configured schema associations when no in-file directive exists", async () => {
        const schemaPath = path.join(cwd, "schema.yaml");
        const markdownPath = path.join(cwd, "docs", "post.mdx");

        await writeFile(
            schemaPath,
            "type: object\nrequired:\n  - title\nproperties:\n  title:\n    type: string\n",
            "utf8"
        );

        const result = await validateMarkdown(
            `---\ndescription: Missing title\n---\n`,
            markdownPath,
            {
                cwd,
                schemas: {
                    "./schema.yaml": ["docs/**/*.mdx"],
                },
            }
        );

        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]?.note).toContain("Missing property: title");
    });

    it("blocks in-file remote schema URLs by default", async () => {
        const remote = await createRemoteSchema({ type: "object" });

        try {
            const result = await validateMarkdown(
                `---\n$schema: ${remote.url}\ntitle: Hello\n---\n`,
                path.join(cwd, "post.md"),
                { cwd }
            );

            expect(result.findings).toHaveLength(1);
            expect(result.findings[0]?.reason).toContain(
                "In-file remote schema URLs are disabled"
            );
        } finally {
            await remote.close();
        }
    });

    it("fetches configured remote schemas", async () => {
        const remote = await createRemoteSchema({
            properties: {
                title: { const: "Expected" },
            },
            required: ["title"],
            type: "object",
        });

        try {
            const result = await validateMarkdown(
                `---\ntitle: Actual\n---\n`,
                path.join(cwd, "post.md"),
                {
                    cwd,
                    schemas: {
                        [remote.url]: ["*.md"],
                    },
                }
            );

            expect(result.findings).toHaveLength(1);
            expect(result.findings[0]?.expected).toEqual(["Expected"]);
        } finally {
            await remote.close();
        }
    });
});

describe("remark plugin", () => {
    it("reports findings through remark-lint messages", async () => {
        const file = await remark()
            .use(remarkFrontmatter, ["yaml", "toml"])
            .use(remarkLintFrontmatterValidation, {
                embed: {
                    properties: { title: { type: "string" } },
                    required: ["title"],
                    type: "object",
                },
            })
            .process("---\ntitle: 1\n---\n\n# Hello\n");

        expect(file.messages).not.toHaveLength(0);
        expect(file.messages).toHaveLength(1);
        expect(file.messages[0]?.line).toBe(2);
    });
});

describe("command line interface", () => {
    let cwd: string;

    beforeEach(async () => {
        cwd = await tempDirectory();
    });

    afterEach(async () => {
        await rm(cwd, { force: true, recursive: true });
    });

    it("returns JSON findings for schema validation failures", async () => {
        const schemaPath = path.join(cwd, "schema.json");
        const markdownPath = path.join(cwd, "post.md");

        await writeJson(schemaPath, {
            properties: { title: { type: "string" } },
            required: ["title"],
            type: "object",
        });
        await writeFile(markdownPath, "---\ntitle: 1\n---\n", "utf8");

        await expect(
            execFileAsync(process.execPath, [
                path.resolve("dist/cli.js"),
                markdownPath,
                "--schema",
                schemaPath,
                "--format",
                "json",
                "--cwd",
                cwd,
            ])
        ).rejects.toMatchObject({
            code: 1,
            stdout: expect.stringContaining('"findings"'),
        });

        await expect(readFile(markdownPath, "utf8")).resolves.toContain(
            "title: 1"
        );
    });

    it("uses the persistent remote schema cache across CLI processes", async () => {
        const remote = await createRemoteSchema({
            properties: { title: { const: "Expected" } },
            required: ["title"],
            type: "object",
        });
        const cacheDirectory = path.join(cwd, ".cache", "schemas");
        const markdownPath = path.join(cwd, "post.md");
        const command = [
            path.resolve("dist/cli.js"),
            markdownPath,
            "--schema",
            remote.url,
            "--cache-dir",
            cacheDirectory,
            "--format",
            "json",
            "--cwd",
            cwd,
        ];
        let isClosed = false;
        const closeRemote = async (): Promise<void> => {
            if (isClosed) {
                return;
            }

            isClosed = true;
            await remote.close();
        };

        await writeFile(markdownPath, "---\ntitle: Actual\n---\n", "utf8");

        try {
            const firstRun = await expectCliFailure(command);

            expect(firstRun.code).toBe(1);
            expect(firstRun.stdout).toContain("Expected");
            expect(remote.requests()).toBe(1);

            await closeRemote();

            const secondRun = await expectCliFailure(command);

            expect(secondRun.code).toBe(1);
            expect(secondRun.stdout).toContain('"findings"');
            expect(remote.requests()).toBeLessThanOrEqual(1);
        } finally {
            await closeRemote();
        }
    });
});
