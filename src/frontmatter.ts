import type { UnknownRecord } from "type-fest";

import * as smolToml from "smol-toml";
import {
    arrayFirst,
    arrayJoin,
    isDefined,
    setHas,
    stringSplit,
} from "ts-extras";
import YAML, { type Document, isNode, LineCounter } from "yaml";

import type {
    FrontmatterDefinition,
    NormalizedSettings,
    ValidationFinding,
} from "./types.js";

/** Parsed leading frontmatter and source-location helpers for schema findings. */
export interface ExtractedFrontmatter {
    readonly data: UnknownRecord;
    readonly definition: FrontmatterDefinition;
    readonly locate: (
        instancePath: string
    ) => undefined | { column: number; line: number };
    readonly raw: string;
    readonly startLine: number;
}

interface ParsedTomlFrontmatter {
    readonly data: UnknownRecord;
}

interface ParsedYamlFrontmatter {
    readonly data: UnknownRecord;
    readonly document: Document.Parsed;
    readonly lineCounter: LineCounter;
}

/** Extract and parse leading frontmatter from Markdown text. */
export function extractFrontmatter(
    markdown: string,
    settings: NormalizedSettings
): ExtractedFrontmatter | ValidationFinding {
    const text = stripByteOrderMark(markdown);
    const firstLine = lineAt(text, 0)?.trim();
    const definition = settings.frontmatter.find(
        (candidate) => candidate.open === firstLine
    );

    if (!definition) {
        return {
            column: 1,
            line: 1,
            reason: "Missing supported YAML or TOML frontmatter.",
        };
    }

    const lines = splitLines(text);
    const closeFence = definition.close ?? definition.open;
    const closingIndex = findClosingFence(lines, closeFence);

    if (!isDefined(closingIndex)) {
        return {
            column: 1,
            line: 1,
            reason: `Frontmatter fence '${definition.open}' is not closed.`,
        };
    }

    const raw = arrayJoin(lines.slice(1, closingIndex), "\n");
    const startLine = 2;

    try {
        if (definition.parser === "yaml") {
            const parsed = parseYamlFrontmatter(raw);

            return {
                data: parsed.data,
                definition,
                locate: (instancePath) =>
                    locateYamlPath(parsed, instancePath, startLine),
                raw,
                startLine,
            };
        }

        const parsed = parseTomlFrontmatter(raw);

        return {
            data: parsed.data,
            definition,
            locate: (instancePath) =>
                locateTomlPath(raw, instancePath, startLine),
            raw,
            startLine,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        return {
            column: 1,
            line: startLine,
            reason: `${definition.name.toUpperCase()} frontmatter parsing failed: ${message}`,
        };
    }
}

function escapeRegExp(value: string): string {
    const specialCharacters = new Set([
        "$",
        "(",
        ")",
        "*",
        "+",
        ".",
        "?",
        "[",
        "\\",
        "]",
        "^",
        "{",
        "|",
        "}",
    ]);

    return arrayJoin(
        Array.from(value, (character) =>
            setHas(specialCharacters, character) ? `\\${character}` : character
        ),
        ""
    );
}

function findClosingFence(
    lines: readonly string[],
    closeFence: string
): number | undefined {
    for (let index = 1; index < lines.length; index += 1) {
        if (lines[index]?.trim() === closeFence) {
            return index;
        }
    }

    return undefined;
}

function isUnknownRecord(value: unknown): value is UnknownRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lineAt(text: string, lineIndex: number): string | undefined {
    return splitLines(text)[lineIndex];
}

function locateTomlPath(
    raw: string,
    instancePath: string,
    startLine: number
): undefined | { column: number; line: number } {
    const [firstSegment] = pointerSegments(instancePath);

    if (!isDefined(firstSegment)) {
        return undefined;
    }

    const lines = splitLines(raw);
    const matcher = new RegExp(
        String.raw`^\s*${escapeRegExp(firstSegment)}\s*=`,
        "u"
    );
    const lineIndex = lines.findIndex((line) => matcher.test(line));

    if (lineIndex === -1) {
        return undefined;
    }

    const keyColumn = lines[lineIndex]?.search(/\S/v);

    return {
        column: (keyColumn ?? 0) + 1,
        line: startLine + lineIndex,
    };
}

function locateYamlPath(
    parsed: ParsedYamlFrontmatter,
    instancePath: string,
    startLine: number
): undefined | { column: number; line: number } {
    const node = parsed.document.getIn(pointerSegments(instancePath), true);

    if (!isNode(node) || !node.range) {
        return undefined;
    }

    const position = parsed.lineCounter.linePos(arrayFirst(node.range));

    return {
        column: position.col,
        line: startLine + position.line - 1,
    };
}

function parseTomlFrontmatter(raw: string): ParsedTomlFrontmatter {
    return {
        data: smolToml.parse(raw),
    };
}

function parseYamlFrontmatter(raw: string): ParsedYamlFrontmatter {
    const lineCounter = new LineCounter();
    const document = YAML.parseDocument(raw, { lineCounter });
    const parsedData: unknown = document.toJS();
    const data = isUnknownRecord(parsedData) ? parsedData : null;

    return {
        data: data ?? {},
        document,
        lineCounter,
    };
}

function pointerSegments(instancePath: string): string[] {
    return stringSplit(instancePath.replace(/^\//v, ""), "/")
        .filter(Boolean)
        .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function splitLines(value: string): string[] {
    return stringSplit(
        value.replaceAll("\r\n", "\n").replaceAll("\r", "\n"),
        "\n"
    );
}

function stripByteOrderMark(text: string): string {
    return text.startsWith("\u{FEFF}") ? text.slice(1) : text;
}
