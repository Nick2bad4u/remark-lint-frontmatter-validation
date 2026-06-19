import type { ErrorObject } from "ajv";
import type { UnknownArray, UnknownRecord } from "type-fest";

import applyFormatsImport from "ajv-formats";
import { Ajv2020, type AnySchema } from "ajv/dist/2020.js";
import * as path from "node:path";
import picomatch from "picomatch";
import {
    arrayJoin,
    keyIn,
    objectEntries,
    objectFromEntries,
    objectHasOwn,
    safeCastTo,
} from "ts-extras";

import type {
    NormalizedSettings,
    Settings,
    ValidationFinding,
    ValidationResult,
} from "./types.js";

import {
    type ExtractedFrontmatter,
    extractFrontmatter,
} from "./frontmatter.js";
import { normalizeSettings } from "./options.js";
import { loadSchema, type SchemaSource } from "./schema.js";

const applyFormats = applyFormatsImport as unknown as (ajv: Ajv2020) => void;

interface ValidateFrontmatterDataOptions {
    readonly ajv: Ajv2020;
    readonly frontmatter: ExtractedFrontmatter;
    readonly normalized: NormalizedSettings;
    readonly schema: unknown;
    readonly schemaLabel: string;
    readonly schemaSource: SchemaSource | undefined;
}

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
    applyFormats(ajv);

    try {
        findings.push(
            ...(await validateFrontmatterData({
                ajv,
                frontmatter,
                normalized,
                schema: loadedSchema.schema,
                schemaLabel: loadedSchema.label,
                schemaSource,
            }))
        );
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
    const params = safeCastTo<UnknownRecord>(error.params);
    const noteParts = [
        `Keyword: ${error.keyword}`,
        `Schema path: ${error.schemaPath}`,
    ];
    const expected = expectedValues(error);

    if (expected) {
        noteParts.push(
            `Allowed values: ${arrayJoin(expected.map(String), ", ")}`
        );
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
        note: arrayJoin(noteParts, "\n"),
        reason: formatAjvReason(error, schemaLabel),
        schema: error,
        ...(expected && { expected }),
    };
}

function expectedValues(
    error: ErrorObject
): Readonly<UnknownArray> | undefined {
    const params = safeCastTo<UnknownRecord>(error.params);

    if (Array.isArray(params["allowedValues"])) {
        return safeCastTo<Readonly<UnknownArray>>(params["allowedValues"]);
    }

    if (keyIn(params, "allowedValue")) {
        return [params["allowedValue"]];
    }

    return undefined;
}

function formatAjvReason(error: ErrorObject, schemaLabel: string): string {
    const message = error.message
        ? `${error.message.charAt(0).toUpperCase()}${error.message.slice(1)}`
        : `Schema validation failed for ${error.keyword}`;
    const pathLabel = error.instancePath === "" ? "/" : error.instancePath;

    return `${pathLabel}: ${message} • ${schemaLabel} • ${error.schemaPath}`;
}

function isExtractedFrontmatter(
    value: ExtractedFrontmatter | ValidationFinding
): value is ExtractedFrontmatter {
    return objectHasOwn(value, "data");
}

function relativeMarkdownPath(markdownPath: string, cwd: string): string {
    return path
        .relative(cwd, path.resolve(markdownPath))
        .replaceAll(path.sep, "/");
}

function removeSchemaDirective(
    frontmatter: ExtractedFrontmatter,
    settings: NormalizedSettings
): UnknownRecord {
    return objectFromEntries(
        objectEntries(frontmatter.data).filter(
            ([key]) => key !== settings.schemaKey
        )
    );
}

function schemaFromAssociations(
    markdownPath: string,
    settings: NormalizedSettings
): SchemaSource | undefined {
    const relativePath = relativeMarkdownPath(markdownPath, settings.cwd);

    const schemaEntries = objectEntries(settings.schemas ?? {});

    for (const [schema, patterns] of schemaEntries) {
        if (
            patterns.some((pattern) => picomatch.isMatch(relativePath, pattern))
        ) {
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

async function validateFrontmatterData(
    options: ValidateFrontmatterDataOptions
): Promise<ValidationFinding[]> {
    const validate = options.ajv.compile(options.schema as AnySchema);
    const data =
        options.schemaSource?.controlledByMarkdown === true
            ? removeSchemaDirective(options.frontmatter, options.normalized)
            : options.frontmatter.data;
    const result = validate(data);

    if (result instanceof Promise) {
        await result;
    }

    return (validate.errors ?? []).map((error: ErrorObject) =>
        ajvErrorToFinding(error, options.frontmatter, options.schemaLabel)
    );
}
