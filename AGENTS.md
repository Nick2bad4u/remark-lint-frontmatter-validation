# Global Codex instructions

- Be direct and critical. Call out incorrect assumptions, poor designs, security risks, over-engineering, and better alternatives.
- Prefer modern, stable, idiomatic practices, but follow the repository's existing conventions unless they are clearly harmful, insecure, or outdated.
- Make focused, maintainable changes. Avoid unnecessary rewrites, abstractions, or dependencies.
- For non-trivial tasks, inspect first, plan briefly, implement, validate, and review the diff.
- Run relevant tests, type checks, linters, or builds when practical. If not run, state what was skipped.

--- project-doc ---

# remark-lint-frontmatter-validation

This package exports a remark-lint plugin and CLI for validating Markdown frontmatter against JSON Schema.

## Repository Rules

- Keep the core validation behavior in reusable TypeScript modules under `src/`.
- Keep the remark plugin and CLI as thin adapters over the shared validator.
- Preserve compatibility with `remark-lint-frontmatter-schema` config where practical.
- Remote schemas must remain explicit and safe by default. Do not allow Markdown-controlled URL fetches unless the user opts in.
- Add tests for each new schema source, frontmatter format, and failure mode.
- `npm run release:verify` is the authoritative local gate.
