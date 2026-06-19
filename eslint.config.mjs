import nickTwoBadFourU from "eslint-config-nick2bad4u";

/** @type {import("eslint").Linter.Config[]} */
const config = [
    ...nickTwoBadFourU.configs.all,
    {
        files: ["test/**/*.ts"],
        rules: {
            "no-restricted-syntax": "off",
        },
    },
];

export default config;
