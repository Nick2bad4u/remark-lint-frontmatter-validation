import type { Options as AjvOptions, ErrorObject } from "ajv";
import type { UnknownArray } from "type-fest";

/** Supported built-in frontmatter syntaxes. */
export type BuiltInFrontmatterFormat = "toml" | "yaml";

/** Custom frontmatter delimiter definition. */
export interface FrontmatterDefinition {
    /** Closing fence. Defaults to `open`. */
    readonly close?: string;
    /** User-facing format name. */
    readonly name: string;
    /** Opening fence at the start of the file. */
    readonly open: string;
    /** Parser used for the fenced block. */
    readonly parser: BuiltInFrontmatterFormat;
}

/** Normalized settings with defaults applied. */
export interface NormalizedSettings extends Omit<
    Settings,
    "cwd" | "extensions" | "frontmatter" | "remote" | "schemaKey"
> {
    readonly cwd: string;
    readonly extensions: readonly string[];
    readonly frontmatter: readonly FrontmatterDefinition[];
    readonly remote: Required<
        Pick<
            RemoteSchemaOptions,
            "allowInFileUrls" | "enabled" | "maxBytes" | "refs" | "timeoutMs"
        >
    > & {
        readonly allowedHosts: readonly string[] | undefined;
        readonly cache: Required<
            Pick<RemoteSchemaCacheOptions, "enabled" | "ttlMs">
        > & {
            readonly directory: string | undefined;
        };
    };
    readonly schemaKey: string;
}

/** Persistent cache controls for fetched remote schemas. */
export interface RemoteSchemaCacheOptions {
    /** Cache directory. Relative paths resolve from `cwd`. */
    readonly directory?: string;
    /** Whether to cache fetched remote schemas on disk. */
    readonly enabled?: boolean;
    /** Cache entry lifetime in milliseconds. Use `false` to never expire. */
    readonly ttlMs?: false | number;
}

/** Remote schema resolution controls. */
export interface RemoteSchemaOptions {
    /** Allowed remote hostnames. Empty means any host. */
    readonly allowedHosts?: readonly string[] | undefined;
    /** Whether Markdown-controlled URL schemas are allowed. */
    readonly allowInFileUrls?: boolean;
    /** Persistent cache controls for fetched remote schemas. */
    readonly cache?: RemoteSchemaCacheOptions;
    /** Whether configured URL schemas can be fetched. */
    readonly enabled?: boolean;
    /** Maximum response body size in bytes. */
    readonly maxBytes?: number;
    /** Remote `$ref` behavior. */
    readonly refs?: "all" | "same-origin" | false;
    /** Fetch timeout in milliseconds. */
    readonly timeoutMs?: number;
}

/** Plugin and CLI validation settings. */
export interface Settings {
    /** AJV options merged over package defaults. */
    readonly ajvOptions?: AjvOptions;
    /** Current working directory for resolving config associations. */
    readonly cwd?: string;
    /** Direct schema object for pipeline use. */
    readonly embed?: unknown;
    /** File extensions considered Markdown-family by the standalone CLI. */
    readonly extensions?: readonly string[];
    /** Frontmatter syntaxes to detect. */
    readonly frontmatter?: readonly (
        | BuiltInFrontmatterFormat
        | FrontmatterDefinition
    )[];
    /** Remote schema resolution controls. */
    readonly remote?: RemoteSchemaOptions;
    /** Emit a finding when a file lacks frontmatter. */
    readonly requireFrontmatter?: boolean;
    /** Emit a finding when frontmatter has no associated schema. */
    readonly requireSchema?: boolean;
    /** Frontmatter key used to declare a schema in a file. */
    readonly schemaKey?: string;
    /** Global schema-to-Markdown associations. */
    readonly schemas?: Readonly<Record<string, readonly string[]>>;
}

/** Validation finding reported by the core validator. */
export interface ValidationFinding {
    readonly column: number;
    readonly expected?: Readonly<UnknownArray>;
    readonly fatal?: boolean;
    readonly line: number;
    readonly note?: string;
    readonly reason: string;
    readonly schema?: ErrorObject;
}

/** Result returned for one Markdown file. */
export interface ValidationResult {
    readonly filePath: string;
    readonly findings: readonly ValidationFinding[];
}

/** Markdown-family extensions scanned by the CLI when callers do not pass
explicit globs. */
export const defaultExtensions = [
    ".markdown",
    ".md",
    ".mdown",
    ".mdwn",
    ".mdx",
    ".mkd",
    ".mkdn",
    ".mkdown",
] as const;

/** Built-in YAML and TOML frontmatter fence definitions. */
export const defaultFrontmatterDefinitions: readonly FrontmatterDefinition[] = [
    { name: "toml", open: "+++", parser: "toml" },
    { name: "yaml", open: "---", parser: "yaml" },
] as const;
