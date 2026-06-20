import type { Root } from "mdast";
import type { Plugin } from "unified";
import type { VFile } from "vfile";

import { type Label, lintRule, type Severity } from "unified-lint-rule";

import type { Settings } from "./types.js";

import { validateMarkdown } from "./validate.js";

const origin = "remark-lint:frontmatter-validation";
const url = "https://github.com/Nick2bad4u/remark-lint-frontmatter-validation";

/** Configuration accepted by the frontmatter validation lint rule. */
export type FrontmatterValidationConfig =
    | [level: boolean | Label | Severity, option?: Settings]
    | false
    | Label
    | Settings
    | Severity;

/** Unified-compatible plugin type for the frontmatter validation lint rule. */
export type FrontmatterValidationPlugin = Plugin<
    [config?: FrontmatterValidationConfig],
    Root
>;

/**
 * Remark lint rule that validates leading Markdown frontmatter against JSON
 * Schema.
 */
const remarkLintFrontmatterValidation: FrontmatterValidationPlugin = lintRule(
    { origin, url },
    async (_tree: Root, file: VFile, settings: false | Settings) => {
        if (settings === false) {
            return;
        }

        const markdown = String(file.value);
        const rawFilePath = Reflect.get(file, "path");
        const filePath =
            typeof rawFilePath === "string" && rawFilePath !== ""
                ? rawFilePath
                : "markdown.md";
        const result = await validateMarkdown(markdown, filePath, settings);

        for (const finding of result.findings) {
            const message = file.message(finding.reason, {
                column: finding.column,
                line: finding.line,
            });

            message.fatal = finding.fatal;
            message.name = "Markdown frontmatter validation error";
            message.note = finding.note;
            message.expected = finding.expected?.map(String);
            Object.assign(message, { schema: finding.schema });
        }
    }
);

export default remarkLintFrontmatterValidation;
