import {
    type BuiltInFrontmatterFormat,
    defaultExtensions,
    defaultFrontmatterDefinitions,
    type FrontmatterDefinition,
    type NormalizedSettings,
    type Settings,
} from "./types.js";

const frontmatterByName = new Map<BuiltInFrontmatterFormat, FrontmatterDefinition>(
    defaultFrontmatterDefinitions.map((definition) => [
        definition.name as BuiltInFrontmatterFormat,
        definition,
    ])
);

/** Apply package defaults to user settings. */
export function normalizeSettings(settings: Settings = {}): NormalizedSettings {
    const remote = settings.remote ?? {};

    return {
        ...settings,
        cwd: settings.cwd ?? process.cwd(),
        extensions: settings.extensions ?? defaultExtensions,
        frontmatter: (settings.frontmatter ?? defaultFrontmatterDefinitions).map(
            normalizeFrontmatterDefinition
        ),
        remote: {
            allowedHosts: remote.allowedHosts,
            allowInFileUrls: remote.allowInFileUrls ?? false,
            enabled: remote.enabled ?? true,
            maxBytes: remote.maxBytes ?? 1_048_576,
            refs: remote.refs ?? false,
            timeoutMs: remote.timeoutMs ?? 10_000,
        },
        schemaKey: settings.schemaKey ?? "$schema",
    };
}

function normalizeFrontmatterDefinition(
    definition: BuiltInFrontmatterFormat | FrontmatterDefinition
): FrontmatterDefinition {
    if (typeof definition === "string") {
        const found = frontmatterByName.get(definition);
        if (found) {
            return found;
        }
        throw new TypeError(`Unsupported frontmatter format: ${definition}`);
    }

    return {
        ...definition,
        close: definition.close ?? definition.open,
    };
}
