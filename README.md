# remark-lint-frontmatter-validation

Remark lint rule and CLI for validating Markdown frontmatter against JSON Schema.

It is intended as a modern replacement for `remark-lint-frontmatter-schema` with:

- YAML frontmatter using `---`
- TOML frontmatter using `+++`
- local JSON/YAML schema files
- configured HTTP(S) schema URLs
- in-file schema directives with a configurable key, defaulting to `$schema`
- global schema-to-file associations
- a standalone CLI for repositories that do not want to wire a remark config

## Install

```sh
npm install --save-dev remark-lint-frontmatter-validation
```

## Remark Usage

```mjs
import remarkFrontmatter from "remark-frontmatter";
import remarkLintFrontmatterValidation from "remark-lint-frontmatter-validation";

export default {
    plugins: [
        [remarkFrontmatter, ["yaml", "toml"]],
        [
            remarkLintFrontmatterValidation,
            {
                schemas: {
                    "./schemas/post.schema.yaml": ["content/**/*.{md,mdx}"],
                    "https://json.schemastore.org/github-workflow.json": [
                        "docs/workflows/*.md",
                    ],
                },
            },
        ],
    ],
};
```

## In-File Schema Directive

```markdown
---
$schema: ../schemas/post.schema.json
title: Example
---

# Example
```

Remote schema URLs in Markdown files are blocked by default because Markdown content
should not be able to trigger arbitrary network requests in CI. Enable them only for
trusted content:

```mjs
[
    remarkLintFrontmatterValidation,
    {
        remote: {
            allowInFileUrls: true,
        },
    },
];
```

## TOML Frontmatter

```markdown
+++
title = "Example"
+++

# Example
```

## CLI Usage

Validate files with one schema:

```sh
npx remark-lint-frontmatter-validation "content/**/*.{md,mdx}" --schema schemas/post.schema.json
```

Use schema associations:

```sh
npx remark-lint-frontmatter-validation \
  --schema-map "schemas/post.schema.json=content/posts/**/*.md" \
  --schema-map "schemas/page.schema.yaml=content/pages/**/*.mdx" \
  "content/**/*.{md,mdx}"
```

GitHub Actions output:

```sh
npx remark-lint-frontmatter-validation "content/**/*.md" --schema schemas/post.schema.json --format github
```

## Options

- `schemas`: schema source to Markdown glob associations.
- `embed`: direct JSON Schema object for pipeline use.
- `ajvOptions`: options passed to Ajv.
- `schemaKey`: frontmatter schema directive key. Defaults to `$schema`.
- `frontmatter`: enabled frontmatter formats. Defaults to YAML and TOML.
- `extensions`: Markdown-family extensions for CLI consumers.
- `requireFrontmatter`: report files without frontmatter.
- `requireSchema`: report files with frontmatter but no schema association.
- `remote`: controls remote schema fetching.

Remote schema settings:

- `enabled`: allow configured URL schemas. Defaults to `true`.
- `allowInFileUrls`: allow Markdown-controlled URL schemas. Defaults to `false`.
- `refs`: remote `$ref` behavior: `false`, `"same-origin"`, or `"all"`. Defaults to `false`.
- `timeoutMs`: fetch timeout. Defaults to `10000`.
- `maxBytes`: maximum schema response size. Defaults to 1 MiB.
- `allowedHosts`: optional hostname allowlist.

## Defaults

The CLI targets Markdown-family extensions by default:

```text
.md, .markdown, .mdx, .mdown, .mdwn, .mkd, .mkdn, .mkdown
```

HTML is not included by default because remark does not parse HTML as Markdown.
Pass explicit globs when a project stores Markdown-compatible frontmatter in another
extension.
