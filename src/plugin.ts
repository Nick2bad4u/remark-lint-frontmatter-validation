import type { Root } from "mdast";
import type { VFile } from "vfile";

import { lintRule } from "unified-lint-rule";

import type { Settings } from "./types.js";

import { validateMarkdown } from "./validate.js";

const origin = "remark-lint:frontmatter-validation";
const url = "https://github.com/Nick2bad4u/remark-lint-frontmatter-validation";

/** Remark lint rule that validates leading Markdown frontmatter against JSON Schema. */
const remarkLintFrontmatterValidation = lintRule(
    { origin, url },
    async (_tree: Root, file: VFile, settings: false | Settings) => {
        if (settings === false) {
            return;
        }

        const markdown = String(file.value ?? "");
        const filePath = file.path ?? "markdown.md";
        const result = await validateMarkdown(markdown, filePath, settings);

        for (const finding of result.findings) {
            const message = file.message(new Error(finding.reason));

            message.fatal = finding.fatal ?? true;
            message.line = finding.line;
            message.column = finding.column;
            message.name = "Markdown frontmatter validation error";
            message.note = finding.note;
            message.expected = finding.expected?.map(String);
            Object.assign(message, { schema: finding.schema });
        }
    }
);

export default remarkLintFrontmatterValidation;
