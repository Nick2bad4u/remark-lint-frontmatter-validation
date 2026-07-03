import type { UnknownRecord } from "type-fest";

import $RefParser from "@apidevtools/json-schema-ref-parser";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { isDefined, isEmpty, keyIn, objectValues, setHas } from "ts-extras";
import YAML from "yaml";

import type { NormalizedSettings } from "./types.js";

/** Schema source selected from frontmatter or configured file associations. */
export interface SchemaSource {
    /** Whether Markdown content supplied the schema path or URL. */
    readonly controlledByMarkdown: boolean;
    /** Local path or HTTP(S) URL for the JSON Schema. */
    readonly value: string;
}

interface RemoteSchemaCacheEntry {
    readonly data: unknown;
    readonly source: string;
    readonly timestamp: number;
    readonly version: 1;
}

interface ResolvedSchema {
    readonly label: string;
    readonly schema: unknown;
}

const packageName = "remark-lint-frontmatter-validation";
const remoteSchemaCache = new Map<string, unknown>();

/**
 * Load and optionally bundle a schema from an embedded object, local file, or
 * URL.
 *
 * @throws When a schema source cannot be read, fetched, parsed, or bundled.
 */
export async function loadSchema(
    source: SchemaSource | undefined,
    markdownPath: string,
    settings: NormalizedSettings
): Promise<ResolvedSchema | undefined> {
    if (isDefined(settings.embed) && typeof settings.embed === "object") {
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
            throw new Error(
                `In-file remote schema URLs are disabled: ${source.value}`
            );
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

    const schemaPath = await normalizeSchemaPath(
        source.value,
        markdownPath,
        settings.cwd
    );
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
    const hostname: string = url.hostname;
    const allowedHostSet = new Set<string>(allowedHosts);
    const isAllowedHost = setHas(allowedHostSet, hostname);
    if (!isEmpty(allowedHosts) && !isAllowedHost) {
        const rejectedUrl = new URL(url.href);

        throw new Error(
            `Remote schema host is not allowed: ${rejectedUrl.hostname}`
        );
    }
}

function assertRemoteRefsAllowed(
    schema: unknown,
    source: string,
    settings: NormalizedSettings
): void {
    const refs = findRemoteRefs(schema);

    if (isEmpty(refs)) {
        return;
    }

    if (settings.remote.refs === false) {
        throw new Error(`Remote $ref values are disabled in schema: ${source}`);
    }

    if (settings.remote.refs === "same-origin") {
        if (!isUrl(source)) {
            throw new Error(
                `Remote $ref values require a remote schema source: ${source}`
            );
        }

        const sourceUrl = new URL(source);
        const origin = sourceUrl.origin;
        const disallowed = refs.find((ref) => {
            const refUrl = new URL(ref);

            return refUrl.origin !== origin;
        });

        if (isDefined(disallowed)) {
            throw new Error(
                `Remote $ref is outside the schema origin: ${disallowed}`
            );
        }
    }
}

function buildRefParserOptions(
    source: string,
    settings: NormalizedSettings
): UnknownRecord {
    const sourceUrl = isUrl(source) ? new URL(source) : undefined;
    const sourceOrigin = sourceUrl?.origin;

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
                                  isDefined(sourceOrigin) &&
                                  remoteOrigin(file.url) !== sourceOrigin
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
    if (remoteSchemaCache.has(source)) {
        return remoteSchemaCache.get(source);
    }

    const url = new URL(source);
    assertAllowedRemoteUrl(url, settings);

    const cachedSchema = await readCachedRemoteSchema(source, settings);
    if (isDefined(cachedSchema)) {
        remoteSchemaCache.set(source, cachedSchema);

        return cachedSchema;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
        controller.abort();
    }, settings.remote.timeoutMs);

    try {
        const response = await fetch(url, {
            credentials: "omit",
            signal: controller.signal,
        });

        const schema = await parseRemoteResponse(
            response,
            url,
            settings,
            source
        );
        await writeCachedRemoteSchema(source, schema, settings);
        remoteSchemaCache.set(source, schema);

        return schema;
    } finally {
        clearTimeout(timer);
    }
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        const stats = await stat(filePath);

        return stats.isFile();
    } catch {
        return false;
    }
}

function findRemoteRefs(schema: unknown, refs: string[] = []): string[] {
    if (schema === null || typeof schema !== "object") {
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

    for (const value of objectValues(record)) {
        findRemoteRefs(value, refs);
    }

    return refs;
}

function isRemoteSchemaCacheEntry(
    value: unknown
): value is RemoteSchemaCacheEntry {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }

    const record = value as UnknownRecord;

    return (
        record["version"] === 1 &&
        typeof record["source"] === "string" &&
        typeof record["timestamp"] === "number" &&
        keyIn(record, "data")
    );
}

function isUrl(value: string): boolean {
    return /^https?:\/\//iv.test(value);
}

function isUsableRemoteSchemaCacheEntry(
    value: unknown,
    source: string,
    settings: NormalizedSettings
): value is RemoteSchemaCacheEntry {
    if (!isRemoteSchemaCacheEntry(value) || value.source !== source) {
        return false;
    }

    const ttlMs = settings.remote.cache.ttlMs;

    return ttlMs === false || value.timestamp + ttlMs >= Date.now();
}

async function normalizeSchemaPath(
    source: string,
    markdownPath: string,
    cwd: string
): Promise<string> {
    if (path.isAbsolute(source)) {
        return source;
    }

    const fromMarkdown = path.resolve(path.dirname(markdownPath), source);
    if (await fileExists(fromMarkdown)) {
        return fromMarkdown;
    }

    return path.resolve(cwd, source.replace(/^\.?\//v, ""));
}

async function parseRemoteResponse(
    response: Response,
    url: URL,
    settings: NormalizedSettings,
    source: string
): Promise<unknown> {
    if (!response.ok) {
        throw new Error(
            `Remote schema returned HTTP ${response.status}: ${url.href}`
        );
    }

    const contentLength = response.headers.get("content-length");
    if (
        contentLength !== null &&
        Number(contentLength) > settings.remote.maxBytes
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

    const decoder = new TextDecoder();

    return parseSchemaText(decoder.decode(bytes), source);
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

async function readCachedRemoteSchema(
    source: string,
    settings: NormalizedSettings
): Promise<unknown> {
    if (!settings.remote.cache.enabled) {
        return undefined;
    }

    try {
        const cacheData = await readRemoteSchemaCacheEntry(source, settings);
        if (!isUsableRemoteSchemaCacheEntry(cacheData, source, settings)) {
            return undefined;
        }

        return cacheData.data;
    } catch {
        return undefined;
    }
}

async function readRemoteSchemaCacheEntry(
    source: string,
    settings: NormalizedSettings
): Promise<unknown> {
    const cacheText = await readFile(
        remoteSchemaCachePath(source, settings),
        "utf8"
    );

    return JSON.parse(cacheText) as unknown;
}

function remoteOrigin(value: string): string {
    const url = new URL(value);

    return url.origin;
}

function remoteSchemaCacheDirectory(settings: NormalizedSettings): string {
    const directory = settings.remote.cache.directory;

    if (isDefined(directory) && directory !== "") {
        return path.isAbsolute(directory)
            ? directory
            : path.resolve(settings.cwd, directory);
    }

    return path.resolve(settings.cwd, "node_modules", ".cache", packageName);
}

function remoteSchemaCachePath(
    source: string,
    settings: NormalizedSettings
): string {
    const hash = createHash("sha256").update(source).digest("hex");

    return path.join(remoteSchemaCacheDirectory(settings), `${hash}.json`);
}

async function writeCachedRemoteSchema(
    source: string,
    schema: unknown,
    settings: NormalizedSettings
): Promise<void> {
    if (!settings.remote.cache.enabled) {
        return;
    }

    const cachePath = remoteSchemaCachePath(source, settings);
    const cacheEntry: RemoteSchemaCacheEntry = {
        data: schema,
        source,
        timestamp: Date.now(),
        version: 1,
    };

    try {
        await mkdir(path.dirname(cachePath), { recursive: true });
        await writeFile(cachePath, `${JSON.stringify(cacheEntry)}\n`, "utf8");
    } catch {
        // Validation should not fail just because the schema cache is read-only.
    }
}
