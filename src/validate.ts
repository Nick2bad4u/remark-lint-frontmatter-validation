import type { ErrorObject } from "ajv";
import type { UnknownArray, UnknownRecord } from "type-fest";

import addFormatsImport from "ajv-formats";
import { Ajv2020, type AnySchema } from "ajv/dist/2020.js";
import * as path from "node:path";
import picomatch from "picomatch";

import type {
    NormalizedSettings,
    Settings,
    ValidationFinding,
    ValidationResult,
} from "./types.js";

import { type ExtractedFrontmatter, extractFrontmatter } from "./frontmatter.js";
import { normalizeSettings } from "./options.js";
import { loadSchema, type SchemaSource } from "./schema.js";

const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => void;

/** Validate one Markdown document's frontmatter against its associated schema. */
export async function validateMarkdown(
    markdown: string,
    filePath: string,
    settings: Settings = {}
): Promise<ValidationResult> {
    const normalized = normalizeSettings(settings);
    const findings: ValidationFinding[] = [];
    const frontmatter = extractFrontmatter(markdown, normalized);

    if (!isExtractedFrontmatter(frontmatter)) {
        if (normalized.requireFrontmatter) {
            findings.push(frontmatter);
        }

        return { filePath, findings };
    }

    const schemaSource =
        schemaFromFrontmatter(frontmatter, normalized) ??
        schemaFromAssociations(filePath, normalized);

    if (!schemaSource && !normalized.embed) {
        if (normalized.requireSchema) {
            findings.push({
                column: 1,
                line: frontmatter.startLine,
                reason: "No frontmatter schema is associated with this file.",
            });
        }

        return { filePath, findings };
    }

    let loadedSchema;

    try {
        loadedSchema = await loadSchema(schemaSource, filePath, normalized);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        findings.push({
            column: 1,
            fatal: true,
            line: frontmatter.startLine,
            reason: `Schema load failed: ${message}`,
        });

        return { filePath, findings };
    }

    if (!loadedSchema) {
        return { filePath, findings };
    }

    const ajv = new Ajv2020({
        allErrors: true,
        strict: false,
        ...normalized.ajvOptions,
    });
    addFormats(ajv);

    try {
        const validate = ajv.compile(loadedSchema.schema as AnySchema);
        const data = schemaSource?.controlledByMarkdown
            ? removeSchemaDirective(frontmatter, normalized)
            : frontmatter.data;

        validate(data);

        if (validate.errors) {
            findings.push(
                ...validate.errors.map((error: ErrorObject) =>
                    ajvErrorToFinding(error, frontmatter, loadedSchema.label)
                )
            );
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        findings.push({
            column: 1,
            fatal: true,
            line: frontmatter.startLine,
            reason: `Schema validation setup failed: ${message}`,
        });
    }

    return { filePath, findings };
}

function ajvErrorToFinding(
    error: ErrorObject,
    frontmatter: ExtractedFrontmatter,
    schemaLabel: string
): ValidationFinding {
    const position = frontmatter.locate(error.instancePath);
    const params = error.params as UnknownRecord;
    const noteParts = [`Keyword: ${error.keyword}`, `Schema path: ${error.schemaPath}`];
    const expected = expectedValues(error);

    if (expected) {
        noteParts.push(`Allowed values: ${expected.join(", ")}`);
    }

    if (typeof params["missingProperty"] === "string") {
        noteParts.push(`Missing property: ${params["missingProperty"]}`);
    }

    if (typeof params["type"] === "string") {
        noteParts.push(`Type: ${params["type"]}`);
    }

    return {
        column: position?.column ?? 1,
        fatal: true,
        line: position?.line ?? frontmatter.startLine,
        note: noteParts.join("\n"),
        reason: formatAjvReason(error, schemaLabel),
        schema: error,
        ...(expected && { expected }),
    };
}

function expectedValues(error: ErrorObject): Readonly<UnknownArray> | undefined {
    const params = error.params as UnknownRecord;

    if (Array.isArray(params["allowedValues"])) {
        return params["allowedValues"];
    }

    if ("allowedValue" in params) {
        return [params["allowedValue"]];
    }

    return undefined;
}

function formatAjvReason(error: ErrorObject, schemaLabel: string): string {
    const message = error.message
        ? `${error.message.charAt(0).toUpperCase()}${error.message.slice(1)}`
        : `Schema validation failed for ${error.keyword}`;
    const pathLabel = error.instancePath || "/";

    return `${pathLabel}: ${message} • ${schemaLabel} • ${error.schemaPath}`;
}

function isExtractedFrontmatter(
    value: ExtractedFrontmatter | ValidationFinding
): value is ExtractedFrontmatter {
    return "data" in value;
}

function relativeMarkdownPath(markdownPath: string, cwd: string): string {
    return path.relative(cwd, path.resolve(markdownPath)).replaceAll(path.sep, "/");
}

function removeSchemaDirective(
    frontmatter: ExtractedFrontmatter,
    settings: NormalizedSettings
): UnknownRecord {
    const data = { ...frontmatter.data };

    delete data[settings.schemaKey];

    return data;
}

function schemaFromAssociations(
    markdownPath: string,
    settings: NormalizedSettings
): SchemaSource | undefined {
    const relativePath = relativeMarkdownPath(markdownPath, settings.cwd);

    for (const [schema, patterns] of Object.entries(settings.schemas ?? {})) {
        if (patterns.some((pattern) => picomatch.isMatch(relativePath, pattern))) {
            return { controlledByMarkdown: false, value: schema };
        }
    }

    return undefined;
}

function schemaFromFrontmatter(
    frontmatter: ExtractedFrontmatter,
    settings: NormalizedSettings
): SchemaSource | undefined {
    const value = frontmatter.data[settings.schemaKey];

    return typeof value === "string"
        ? { controlledByMarkdown: true, value }
        : undefined;
}
