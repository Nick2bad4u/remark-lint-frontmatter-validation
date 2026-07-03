import nickTwoBadFourU from "eslint-config-nick2bad4u";

/** @type {import("eslint").Linter.Config[]} */
const config = [
    ...nickTwoBadFourU.configs.all,
    {
        files: ["src/**/*.ts", "test/**/*.ts"],
        name: "Local Public API and Framework Callback Boundaries",
        rules: {
            "@typescript-eslint/prefer-readonly-parameter-types": "off",
        },
    },
    {
        files: [
            "src/cli.ts",
            "src/frontmatter.ts",
            "src/schema.ts",
        ],
        name: "Local User-Supplied Path and Delimiter Handling",
        rules: {
            "security/detect-non-literal-fs-filename": "off",
            "security/detect-non-literal-regexp": "off",
        },
    },
    {
        files: ["src/**/*.ts", "test/**/*.ts"],
        name: "Local Runtime Validation Boundaries",
        rules: {
            "@typescript-eslint/no-unsafe-type-assertion": "off",
            "@typescript-eslint/strict-boolean-expressions": "off",
        },
    },
    {
        files: ["**/*.{yaml,yml}"],
        name: "Local Shared Yamllint Policy",
        rules: {
            "yamllint/yamllint": [
                "error",
                {
                    configFile:
                        "./node_modules/yamllint-config-nick2bad4u/.yamllint",
                },
            ],
        },
    },
    {
        files: ["**/*.toml"],
        name: "Local Stable TOML Formatting",
        rules: {
            // Tombi 1.1.7 formats the same TOML differently on Windows and Linux.
            "tombi/tombi": "off",
        },
    },
    {
        files: ["src/cli.ts"],
        name: "Local Command Line Runtime",
        rules: {
            "n/hashbang": "off",
            "no-console": "off",
            "no-unsanitized/method": "off",
        },
    },
    {
        files: ["test/**/*.ts"],
        name: "Local Integration Test Style",
        rules: {
            "@typescript-eslint/strict-void-return": "off",
            "no-restricted-syntax": "off",
            "sdl/no-insecure-url": "off",
            "vitest/no-hooks": "off",
            "vitest/prefer-expect-assertions": "off",
            "vitest/prefer-strict-equal": "off",
        },
    },
];

export default config;
