#!/usr/bin/env node

import type { ArrayValues } from "type-fest";

import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { glob } from "tinyglobby";
import {
    arrayConcat,
    arrayIncludes,
    arrayJoin,
    isDefined,
    isEmpty,
    objectHasOwn,
    stringSplit,
} from "ts-extras";

import type {
    RemoteSchemaOptions,
    Settings,
    ValidationResult,
} from "./types.js";

import { getErrorMessage } from "./errors.js";
import { validateMarkdown } from "./validate.js";

interface CliOptions {
    readonly allowInFileUrls: boolean;
    readonly cache: boolean | undefined;
    readonly cacheDirectory: string | undefined;
    readonly cacheTtlMs: number | undefined;
    readonly config: string | undefined;
    readonly cwd: string;
    readonly extensions: readonly string[] | undefined;
    readonly files: readonly string[];
    readonly format:
        | "github"
        | "json"
        | "stylish";
    readonly frontmatter: readonly ("toml" | "yaml")[] | undefined;
    readonly remoteRefs:
        | "all"
        | "same-origin"
        | false;
    readonly requireFrontmatter: boolean;
    readonly requireSchema: boolean;
    readonly schema: string | undefined;
    readonly schemaKey: string | undefined;
    readonly schemaMaps: readonly string[];
    readonly timeoutMs: number | undefined;
}

interface MutableCliOptions {
    allowInFileUrls: boolean;
    cache: boolean | undefined;
    cacheDirectory: string | undefined;
    cacheTtlMs: number | undefined;
    config: string | undefined;
    cwd: string;
    extensions: string[] | undefined;
    files: string[];
    format: CliOptions["format"];
    frontmatter: ("toml" | "yaml")[] | undefined;
    remoteRefs: CliOptions["remoteRefs"];
    requireFrontmatter: boolean;
    requireSchema: boolean;
    schema: string | undefined;
    schemaKey: string | undefined;
    schemaMaps: string[];
    timeoutMs: number | undefined;
}

interface ParsedArgument {
    readonly nextIndex: number;
}

const outputFormats = [
    "github",
    "json",
    "stylish",
] as const;
const remoteRefModes = [
    "all",
    "none",
    "same-origin",
] as const;

interface ResolvedInputPattern {
    readonly kind: "file" | "glob";
    readonly value: string;
}

function buildRemoteSettings(
    options: CliOptions,
    config: Settings
): RemoteSchemaOptions {
    const timeoutMs = options.timeoutMs ?? config.remote?.timeoutMs;

    return {
        ...config.remote,
        allowInFileUrls: options.allowInFileUrls
            ? true
            : (config.remote?.allowInFileUrls ?? false),
        cache: {
            ...config.remote?.cache,
            ...(isDefined(options.cache) && { enabled: options.cache }),
            ...(isDefined(options.cacheDirectory) && {
                directory: options.cacheDirectory,
            }),
            ...(isDefined(options.cacheTtlMs) && { ttlMs: options.cacheTtlMs }),
        },
        refs: options.remoteRefs,
        ...(isDefined(timeoutMs) && { timeoutMs }),
    };
}

function buildSettings(options: CliOptions, config: Settings): Settings {
    const schemas = mergeSchemaSettings(options, config);
    const remoteSettings = buildRemoteSettings(options, config);
    const schemaKey = options.schemaKey ?? config.schemaKey;

    return {
        ...config,
        cwd: options.cwd,
        remote: remoteSettings,
        requireFrontmatter: options.requireFrontmatter
            ? true
            : (config.requireFrontmatter ?? false),
        requireSchema: options.requireSchema
            ? true
            : (config.requireSchema ?? false),
        schemas,
        ...(isDefined(options.extensions ?? config.extensions) && {
            extensions: options.extensions ?? config.extensions,
        }),
        ...(isDefined(options.frontmatter ?? config.frontmatter) && {
            frontmatter: options.frontmatter ?? config.frontmatter,
        }),
        ...(isDefined(schemaKey) && { schemaKey }),
    };
}

function defaultCliOptions(): MutableCliOptions {
    return {
        allowInFileUrls: false,
        cache: undefined,
        cacheDirectory: undefined,
        cacheTtlMs: undefined,
        config: undefined,
        cwd: process.cwd(),
        extensions: undefined,
        files: [],
        format: "stylish",
        frontmatter: undefined,
        remoteRefs: false,
        requireFrontmatter: false,
        requireSchema: false,
        schema: undefined,
        schemaKey: undefined,
        schemaMaps: [],
        timeoutMs: undefined,
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

async function findFiles(
    patterns: readonly string[],
    cwd: string
): Promise<string[]> {
    if (isEmpty(patterns)) {
        throw new Error("At least one file or glob is required.");
    }

    const resolvedPatterns = await Promise.all(
        patterns.map(async (pattern) => resolveInputPattern(pattern))
    );
    const absoluteFiles = resolvedPatterns
        .filter((entry) => entry.kind === "file")
        .map((entry) => entry.value);
    const globPatterns = resolvedPatterns
        .filter((entry) => entry.kind === "glob")
        .map((entry) => entry.value);

    const matches = await glob(globPatterns, {
        absolute: true,
        cwd,
        dot: true,
        onlyFiles: true,
    });

    return [...new Set(arrayConcat(absoluteFiles, matches))];
}

function isOutputFormat(value: string): value is CliOptions["format"] {
    return arrayIncludes(outputFormats, value);
}

function isRemoteRefMode(
    value: string
): value is ArrayValues<typeof remoteRefModes> {
    return arrayIncludes(remoteRefModes, value);
}

function isSettings(value: unknown): value is Settings {
    return typeof value === "object" && value !== null;
}

async function loadConfig(configPath: string | undefined): Promise<Settings> {
    if (!isDefined(configPath)) {
        return {};
    }

    const resolved = path.resolve(configPath);
    const imported: unknown = await import(pathToFileURL(resolved).href);

    return settingsFromModule(imported);
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
        console.error(getErrorMessage(error));
        return 2;
    }
}

function mergeSchemaSettings(
    options: CliOptions,
    config: Settings
): Record<string, readonly string[]> {
    const schemas: Record<string, readonly string[]> = {
        ...config.schemas,
        ...schemaMapEntries(options.schemaMaps),
    };

    if (isDefined(options.schema)) {
        schemas[options.schema] = ["**/*"];
    }

    return schemas;
}

function parseArgs(args: readonly string[]): CliOptions {
    const options = defaultCliOptions();

    for (let index = 0; index < args.length;) {
        index = parseArgument(args, index, options).nextIndex;
    }

    return options;
}

function parseArgument(
    args: readonly string[],
    index: number,
    options: MutableCliOptions
): ParsedArgument {
    const arg = args[index];

    if (!isDefined(arg)) {
        return { nextIndex: index + 1 };
    }

    if (!arg.startsWith("--")) {
        options.files.push(arg);

        return { nextIndex: index + 1 };
    }

    return parseFlagArgument(args, index, arg, options);
}

function parseFlagArgument(
    args: readonly string[],
    index: number,
    arg: string,
    options: MutableCliOptions
): ParsedArgument {
    switch (arg) {
        case "--allow-in-file-urls": {
            options.allowInFileUrls = true;

            return { nextIndex: index + 1 };
        }
        case "--cache": {
            options.cache = true;

            return { nextIndex: index + 1 };
        }
        case "--cache-dir": {
            options.cacheDirectory = takeValue(args, index, arg);

            return { nextIndex: index + 2 };
        }
        case "--cache-ttl-ms": {
            options.cacheTtlMs = Number(takeValue(args, index, arg));

            return { nextIndex: index + 2 };
        }
        case "--config": {
            options.config = takeValue(args, index, arg);

            return { nextIndex: index + 2 };
        }
        case "--cwd": {
            options.cwd = path.resolve(takeValue(args, index, arg));

            return { nextIndex: index + 2 };
        }
        case "--extensions": {
            options.extensions = parseList(takeValue(args, index, arg));

            return { nextIndex: index + 2 };
        }
        case "--format": {
            options.format = parseOutputFormat(takeValue(args, index, arg));

            return { nextIndex: index + 2 };
        }
        case "--frontmatter": {
            options.frontmatter = parseFrontmatterFormats(
                takeValue(args, index, arg)
            );

            return { nextIndex: index + 2 };
        }
        case "--no-cache": {
            options.cache = false;

            return { nextIndex: index + 1 };
        }
        case "--remote-refs": {
            options.remoteRefs = parseRemoteRefs(takeValue(args, index, arg));

            return { nextIndex: index + 2 };
        }
        case "--require-frontmatter": {
            options.requireFrontmatter = true;

            return { nextIndex: index + 1 };
        }
        case "--require-schema": {
            options.requireSchema = true;

            return { nextIndex: index + 1 };
        }
        case "--schema": {
            options.schema = takeValue(args, index, arg);

            return { nextIndex: index + 2 };
        }
        case "--schema-key": {
            options.schemaKey = takeValue(args, index, arg);

            return { nextIndex: index + 2 };
        }
        case "--schema-map": {
            options.schemaMaps.push(takeValue(args, index, arg));

            return { nextIndex: index + 2 };
        }
        case "--timeout-ms": {
            options.timeoutMs = Number(takeValue(args, index, arg));

            return { nextIndex: index + 2 };
        }
        default: {
            throw new Error(`Unknown option: ${arg}`);
        }
    }
}

function parseFrontmatterFormats(value: string): ("toml" | "yaml")[] {
    return parseList(value).filter(
        (entry: string): entry is "toml" | "yaml" =>
            entry === "toml" || entry === "yaml"
    );
}

function parseList(value: string): string[] {
    return stringSplit(value, ",")
        .map((entry: string) => entry.trim())
        .filter((entry) => entry !== "");
}

function parseOutputFormat(value: string): CliOptions["format"] {
    if (!isOutputFormat(value)) {
        throw new Error(`Unsupported format: ${value}`);
    }

    return value;
}

function parseRemoteRefs(value: string): CliOptions["remoteRefs"] {
    if (!isRemoteRefMode(value)) {
        throw new Error(`Unsupported --remote-refs value: ${value}`);
    }

    return value === "none" ? false : value;
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

    return arrayJoin(lines, "\n");
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
        if (isEmpty(result.findings)) {
            continue;
        }

        lines.push(result.filePath);

        for (const finding of result.findings) {
            lines.push(
                `  ${finding.line}:${finding.column}  ${finding.reason}`
            );
        }
    }

    return arrayJoin(lines, "\n");
}

async function resolveInputPattern(
    pattern: string
): Promise<ResolvedInputPattern> {
    if (!path.isAbsolute(pattern)) {
        return { kind: "glob", value: pattern };
    }

    try {
        const stats = await stat(pattern);

        if (stats.isFile()) {
            return { kind: "file", value: pattern };
        }
    } catch {
        return { kind: "glob", value: pattern };
    }

    return { kind: "glob", value: pattern };
}

function schemaMapEntries(
    schemaMaps: readonly string[]
): Record<string, string[]> {
    const schemas: Record<string, string[]> = {};

    for (const schemaMap of schemaMaps) {
        const separatorIndex = schemaMap.indexOf("=");

        if (separatorIndex === -1) {
            throw new Error(`--schema-map must use schema=glob: ${schemaMap}`);
        }

        const schema = schemaMap.slice(0, separatorIndex);
        const globPattern = schemaMap.slice(separatorIndex + 1);

        schemas[schema] = [...(schemas[schema] ?? []), globPattern];
    }

    return schemas;
}

function settingsFromModule(value: unknown): Settings {
    if (
        isSettings(value) &&
        objectHasOwn(value, "default") &&
        isSettings(value.default)
    ) {
        return value.default;
    }

    if (isSettings(value)) {
        return value;
    }

    throw new TypeError("Config module must export a settings object.");
}

function takeValue(
    args: readonly string[],
    index: number,
    flag: string
): string {
    const value = args[index + 1];

    if (!isDefined(value) || value === "" || value.startsWith("--")) {
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
            validateMarkdown(
                await readFile(filePath, "utf8"),
                filePath,
                settings
            )
        )
    );
}

process.exitCode = await main();
