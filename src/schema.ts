import type { UnknownRecord } from "type-fest";

import $RefParser from "@apidevtools/json-schema-ref-parser";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import YAML from "yaml";

import type { NormalizedSettings } from "./types.js";

export interface SchemaSource {
    readonly controlledByMarkdown: boolean;
    readonly value: string;
}

interface ResolvedSchema {
    readonly label: string;
    readonly schema: unknown;
}

const remoteSchemaCache = new Map<string, unknown>();

/** Load and optionally bundle a schema from an embedded object, local file, or URL. */
export async function loadSchema(
    source: SchemaSource | undefined,
    markdownPath: string,
    settings: NormalizedSettings
): Promise<ResolvedSchema | undefined> {
    if (settings.embed && typeof settings.embed === "object") {
        return {
            label: "embedded schema",
            schema: settings.embed,
        };
    }

    if (!source) {
        return undefined;
    }

    if (isUrl(source.value)) {
        if (source.controlledByMarkdown && !settings.remote.allowInFileUrls) {
            throw new Error(`In-file remote schema URLs are disabled: ${source.value}`);
        }

        const schema = await fetchRemoteSchema(source.value, settings);
        assertRemoteRefsAllowed(schema, source.value, settings);

        if (settings.remote.refs === false) {
            return {
                label: source.value,
                schema,
            };
        }

        return {
            label: source.value,
            schema: await $RefParser.bundle(
                source.value,
                buildRefParserOptions(source.value, settings)
            ),
        };
    }

    const schemaPath = normalizeSchemaPath(source.value, markdownPath, settings.cwd);
    const text = await readFile(schemaPath, "utf8");
    const parsed = parseSchemaText(text, schemaPath);
    assertRemoteRefsAllowed(parsed, schemaPath, settings);

    return {
        label: schemaPath,
        schema: await $RefParser.bundle(
            schemaPath,
            buildRefParserOptions(schemaPath, settings)
        ),
    };
}

function assertAllowedRemoteUrl(url: URL, settings: NormalizedSettings): void {
    if (!settings.remote.enabled) {
        throw new Error(`Remote schema loading is disabled: ${url.href}`);
    }

    const allowedHosts = settings.remote.allowedHosts ?? [];
    if (allowedHosts.length > 0 && !allowedHosts.includes(url.hostname)) {
        throw new Error(`Remote schema host is not allowed: ${url.hostname}`);
    }
}

function assertRemoteRefsAllowed(
    schema: unknown,
    source: string,
    settings: NormalizedSettings
): void {
    const refs = findRemoteRefs(schema);

    if (refs.length === 0) {
        return;
    }

    if (settings.remote.refs === false) {
        throw new Error(`Remote $ref values are disabled in schema: ${source}`);
    }

    if (settings.remote.refs === "same-origin") {
        if (!isUrl(source)) {
            throw new Error(`Remote $ref values require a remote schema source: ${source}`);
        }

        const origin = new URL(source).origin;
        const disallowed = refs.find((ref) => new URL(ref).origin !== origin);

        if (disallowed) {
            throw new Error(`Remote $ref is outside the schema origin: ${disallowed}`);
        }
    }
}

function buildRefParserOptions(
    source: string,
    settings: NormalizedSettings
): UnknownRecord {
    const sourceOrigin = isUrl(source) ? new URL(source).origin : undefined;

    return {
        resolve: {
            http:
                settings.remote.refs === false
                    ? false
                    : {
                          canRead: /^https?:\/\//iv,
                          read: async (file: { readonly url: string }) => {
                              if (
                                  settings.remote.refs === "same-origin" &&
                                  sourceOrigin &&
                                  new URL(file.url).origin !== sourceOrigin
                              ) {
                                  throw new Error(
                                      `Remote $ref is outside the schema origin: ${file.url}`
                                  );
                              }

                              return fetchRemoteSchema(file.url, settings);
                          },
                      },
        },
    };
}

async function fetchRemoteSchema(
    source: string,
    settings: NormalizedSettings
): Promise<unknown> {
    const cached = remoteSchemaCache.get(source);
    if (cached) {
        return cached;
    }

    const url = new URL(source);
    assertAllowedRemoteUrl(url, settings);

    const controller = new AbortController();
    const timer = setTimeout(() => {
        controller.abort();
    }, settings.remote.timeoutMs);

    try {
        const response = await fetch(url, {
            credentials: "omit",
            redirect: "follow",
            signal: controller.signal,
        });

        if (!response.ok) {
            throw new Error(`Remote schema returned HTTP ${response.status}: ${url.href}`);
        }

        const contentLength = response.headers.get("content-length");
        if (
            contentLength &&
            Number.parseInt(contentLength, 10) > settings.remote.maxBytes
        ) {
            throw new Error(
                `Remote schema is larger than ${settings.remote.maxBytes} bytes: ${url.href}`
            );
        }

        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > settings.remote.maxBytes) {
            throw new Error(
                `Remote schema is larger than ${settings.remote.maxBytes} bytes: ${url.href}`
            );
        }

        const schema = parseSchemaText(new TextDecoder().decode(bytes), source);
        remoteSchemaCache.set(source, schema);

        return schema;
    } finally {
        clearTimeout(timer);
    }
}

function findRemoteRefs(schema: unknown, refs: string[] = []): string[] {
    if (!schema || typeof schema !== "object") {
        return refs;
    }

    if (Array.isArray(schema)) {
        for (const value of schema) {
            findRemoteRefs(value, refs);
        }

        return refs;
    }

    const record = schema as UnknownRecord;
    const ref = record["$ref"];

    if (typeof ref === "string" && isUrl(ref)) {
        refs.push(ref);
    }

    for (const value of Object.values(record)) {
        findRemoteRefs(value, refs);
    }

    return refs;
}

function isUrl(value: string): boolean {
    return /^https?:\/\//iv.test(value);
}

function normalizeSchemaPath(source: string, markdownPath: string, cwd: string): string {
    if (path.isAbsolute(source)) {
        return source;
    }

    const fromMarkdown = path.resolve(path.dirname(markdownPath), source);
    if (existsSync(fromMarkdown)) {
        return fromMarkdown;
    }

    return path.resolve(cwd, source.replace(/^\.?\//v, ""));
}

function parseSchemaText(text: string, source: string): unknown {
    const lowerSource = source.toLowerCase();

    if (lowerSource.endsWith(".json")) {
        return JSON.parse(text) as unknown;
    }

    try {
        return JSON.parse(text) as unknown;
    } catch {
        return YAML.parse(text) as unknown;
    }
}
