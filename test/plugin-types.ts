import type { PluggableList, Preset } from "unified";

import remarkLintFrontmatterValidation, {
    type FrontmatterValidationConfig,
    type FrontmatterValidationPlugin,
} from "../src/plugin.js";

const plugin: FrontmatterValidationPlugin = remarkLintFrontmatterValidation;

const settings = {
    embed: {
        properties: {
            title: { type: "string" },
        },
        type: "object",
    },
} satisfies FrontmatterValidationConfig;

const disableRule = false satisfies FrontmatterValidationConfig;
const warning = ["warn", settings] satisfies FrontmatterValidationConfig;
const booleanLevel = [true, settings] satisfies FrontmatterValidationConfig;

const plugins: PluggableList = [
    plugin,
    [plugin, settings],
    [plugin, disableRule],
    [plugin, warning],
    [plugin, booleanLevel],
];

const preset: Preset = { plugins };

void preset;
