import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { glob } from "tinyglobby";

import type { RemoteSchemaOptions, Settings, ValidationResult } from "./types.js";

import { validateMarkdown } from "./validate.js";

interface CliOptions {
    readonly allowInFileUrls: boolean;
    readonly config: string | undefined;
    readonly cwd: string;
    readonly extensions: readonly string[] | undefined;
    readonly files: readonly string[];
    readonly format: "github" | "json" | "stylish";
    readonly frontmatter: readonly ("toml" | "yaml")[] | undefined;
    readonly remoteRefs: "all" | "same-origin" | false;
    readonly requireFrontmatter: boolean;
    readonly requireSchema: boolean;
    readonly schema: string | undefined;
    readonly schemaKey: string | undefined;
    readonly schemaMaps: readonly string[];
    readonly timeoutMs: number | undefined;
}

function buildSettings(options: CliOptions, config: Settings): Settings {
    const mapSchemas = schemaMapEntries(options.schemaMaps);
    const schemas = {
        ...config.schemas,
        ...mapSchemas,
    };

    if (options.schema) {
        schemas[options.schema] = ["**/*"];
    }

    const remote = {
        ...config,
    };
    const timeoutMs = options.timeoutMs ?? config.remote?.timeoutMs;
    const remoteSettings: RemoteSchemaOptions = {
        ...config.remote,
        allowInFileUrls: options.allowInFileUrls || config.remote?.allowInFileUrls || false,
        refs: options.remoteRefs,
        ...(timeoutMs !== undefined && { timeoutMs }),
    };
    const schemaKey = options.schemaKey ?? config.schemaKey;

    return {
        ...remote,
        cwd: options.cwd,
        remote: remoteSettings,
        requireFrontmatter:
            options.requireFrontmatter || config.requireFrontmatter || false,
        requireSchema: options.requireSchema || config.requireSchema || false,
        schemas,
        ...((options.extensions ?? config.extensions) && {
            extensions: options.extensions ?? config.extensions,
        }),
        ...((options.frontmatter ?? config.frontmatter) && {
            frontmatter: options.frontmatter ?? config.frontmatter,
        }),
        ...(schemaKey && { schemaKey }),
    };
}

function escapeGitHubMessage(message: string): string {
    return message
        .replaceAll("%", "%25")
        .replaceAll("\r", "%0D")
        .replaceAll("\n", "%0A")
        .replaceAll(":", "%3A")
        .replaceAll(",", "%2C");
}

async function findFiles(patterns: readonly string[], cwd: string): Promise<string[]> {
    if (patterns.length === 0) {
        throw new Error("At least one file or glob is required.");
    }

    const absoluteFiles: string[] = [];
    const globPatterns: string[] = [];

    for (const pattern of patterns) {
        if (path.isAbsolute(pattern)) {
            const stats = await stat(pattern).catch(() => undefined);

            if (stats?.isFile()) {
                absoluteFiles.push(pattern);
                continue;
            }
        }

        globPatterns.push(pattern);
    }

    const matches = await glob(globPatterns, {
        absolute: true,
        cwd,
        dot: true,
        onlyFiles: true,
    });

    return [...new Set([...absoluteFiles, ...matches])].sort();
}

async function loadConfig(configPath: string | undefined): Promise<Settings> {
    if (!configPath) {
        return {};
    }

    const resolved = path.resolve(configPath);
    const imported = (await import(pathToFileURL(resolved).href)) as Settings & {
        readonly default?: Settings;
    };

    return imported.default ?? imported;
}

async function main(): Promise<number> {
    try {
        const options = parseArgs(process.argv.slice(2));
        const config = await loadConfig(options.config);
        const settings = buildSettings(options, config);
        const files = await findFiles(options.files, options.cwd);
        const results = await validateFiles(files, settings);
        const output = renderResults(results, options.format);

        if (output) {
            console.log(output);
        }

        return results.some((result) => result.findings.length > 0) ? 1 : 0;
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 2;
    }
}

function parseArgs(args: string[]): CliOptions {
    const files: string[] = [];
    const schemaMaps: string[] = [];
    let allowInFileUrls = false;
    let config: string | undefined;
    let cwd = process.cwd();
    let extensions: string[] | undefined;
    let format: CliOptions["format"] = "stylish";
    let frontmatter: ("toml" | "yaml")[] | undefined;
    let remoteRefs: CliOptions["remoteRefs"] = false;
    let requireFrontmatter = false;
    let requireSchema = false;
    let schema: string | undefined;
    let schemaKey: string | undefined;
    let timeoutMs: number | undefined;

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];

        switch (arg) {
            case "--allow-in-file-urls": {
                allowInFileUrls = true;
                break;
            }
            case "--config": {
                config = takeValue(args, index, arg);
                index += 1;
                break;
            }
            case "--cwd": {
                cwd = path.resolve(takeValue(args, index, arg));
                index += 1;
                break;
            }
            case "--extensions": {
                extensions = takeValue(args, index, arg)
                    .split(",")
                    .map((value: string) => value.trim())
                    .filter(Boolean);
                index += 1;
                break;
            }
            case "--format": {
                const value = takeValue(args, index, arg);
                if (!["github", "json", "stylish"].includes(value)) {
                    throw new Error(`Unsupported format: ${value}`);
                }
                format = value as CliOptions["format"];
                index += 1;
                break;
            }
            case "--frontmatter": {
                frontmatter = takeValue(args, index, arg)
                    .split(",")
                    .map((value: string) => value.trim())
                    .filter((value: string): value is "toml" | "yaml" =>
                        value === "toml" || value === "yaml"
                    );
                index += 1;
                break;
            }
            case "--remote-refs": {
                const value = takeValue(args, index, arg);
                if (!["all", "none", "same-origin"].includes(value)) {
                    throw new Error(`Unsupported --remote-refs value: ${value}`);
                }
                remoteRefs =
                    value === "none" ? false : (value as "all" | "same-origin");
                index += 1;
                break;
            }
            case "--require-frontmatter": {
                requireFrontmatter = true;
                break;
            }
            case "--require-schema": {
                requireSchema = true;
                break;
            }
            case "--schema": {
                schema = takeValue(args, index, arg);
                index += 1;
                break;
            }
            case "--schema-key": {
                schemaKey = takeValue(args, index, arg);
                index += 1;
                break;
            }
            case "--schema-map": {
                schemaMaps.push(takeValue(args, index, arg));
                index += 1;
                break;
            }
            case "--timeout-ms": {
                timeoutMs = Number.parseInt(takeValue(args, index, arg), 10);
                index += 1;
                break;
            }
            default: {
                if (arg?.startsWith("--")) {
                    throw new Error(`Unknown option: ${arg}`);
                }
                if (arg) {
                    files.push(arg);
                }
            }
        }
    }

    return {
        allowInFileUrls,
        config,
        cwd,
        extensions,
        files,
        format,
        frontmatter,
        remoteRefs,
        requireFrontmatter,
        requireSchema,
        schema,
        schemaKey,
        schemaMaps,
        timeoutMs,
    };
}

function renderGitHub(results: readonly ValidationResult[]): string {
    const lines: string[] = [];

    for (const result of results) {
        for (const finding of result.findings) {
            lines.push(
                `::error file=${result.filePath},line=${finding.line},col=${finding.column}::${escapeGitHubMessage(finding.reason)}`
            );
        }
    }

    return lines.join("\n");
}

function renderResults(
    results: readonly ValidationResult[],
    format: CliOptions["format"]
): string {
    if (format === "json") {
        return JSON.stringify(results, null, 2);
    }

    if (format === "github") {
        return renderGitHub(results);
    }

    return renderStylish(results);
}

function renderStylish(results: readonly ValidationResult[]): string {
    const lines: string[] = [];

    for (const result of results) {
        if (result.findings.length === 0) {
            continue;
        }

        lines.push(result.filePath);

        for (const finding of result.findings) {
            lines.push(`  ${finding.line}:${finding.column}  ${finding.reason}`);
        }
    }

    return lines.join("\n");
}

function schemaMapEntries(schemaMaps: readonly string[]): Record<string, string[]> {
    const schemas: Record<string, string[]> = {};

    for (const schemaMap of schemaMaps) {
        const separatorIndex = schemaMap.indexOf("=");

        if (separatorIndex === -1) {
            throw new Error(`--schema-map must use schema=glob: ${schemaMap}`);
        }

        const schema = schemaMap.slice(0, separatorIndex);
        const glob = schemaMap.slice(separatorIndex + 1);

        schemas[schema] = [...(schemas[schema] ?? []), glob];
    }

    return schemas;
}

function takeValue(args: string[], index: number, flag: string): string {
    const value = args[index + 1];

    if (!value || value.startsWith("--")) {
        throw new Error(`${flag} requires a value.`);
    }

    return value;
}

async function validateFiles(
    files: readonly string[],
    settings: Settings
): Promise<ValidationResult[]> {
    return Promise.all(
        files.map(async (filePath) =>
            validateMarkdown(await readFile(filePath, "utf8"), filePath, settings)
        )
    );
}

process.exitCode = await main();
