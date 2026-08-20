import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

const GITLEAKS_REVISION = "83d9cd684c87d95d656c1458ef04895a7f1cbd8e";
const PATHSPEC_VERSION = "1.1.1";
const PYYAML_VERSION = "6.0.3";
const YAMLLINT_VERSION = "1.38.0";
const forceFallback = process.env.NATIVE_LINT_FORCE_FALLBACK === "1";

const run = (command, arguments_, options = {}) =>
    spawnSync(command, arguments_, { stdio: "inherit", ...options });

const finish = (result, unavailableMessage) => {
    if (result.error) {
        console.error(`${unavailableMessage}: ${result.error.message}`);
        process.exitCode = 1;
        return;
    }

    if (result.signal) {
        console.error(`Native linter terminated by signal ${result.signal}.`);
        process.exitCode = 1;
        return;
    }

    process.exitCode = result.status ?? 1;
};

const runGitleaks = () => {
    const arguments_ = [
        "dir",
        "--config",
        ".gitleaks.toml",
        ".",
    ];
    if (!forceFallback) {
        const installed = run("gitleaks", arguments_);
        if (installed.error?.code !== "ENOENT") {
            finish(installed, "Unable to run gitleaks");
            return;
        }
    }

    console.warn(
        `gitleaks is not installed; running the pinned revision ${GITLEAKS_REVISION} with Go.`
    );
    finish(
        run("go", [
            "run",
            `github.com/zricethezav/gitleaks/v8@${GITLEAKS_REVISION}`,
            ...arguments_,
        ]),
        "gitleaks is unavailable and the Go fallback could not run"
    );
};

const runYamllint = () => {
    const arguments_ = [
        "-c",
        ".yamllint",
        ".",
    ];
    if (!forceFallback) {
        const installed = run("yamllint", arguments_);
        if (installed.error?.code !== "ENOENT") {
            finish(installed, "Unable to run yamllint");
            return;
        }
    }

    const installDirectory = mkdtempSync(
        join(tmpdir(), "remark-frontmatter-yamllint-")
    );
    console.warn(
        `yamllint is not installed; using a temporary yamllint ${YAMLLINT_VERSION} installation.`
    );

    try {
        const install = run("python", [
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--no-deps",
            "--target",
            installDirectory,
            `yamllint==${YAMLLINT_VERSION}`,
            `pathspec==${PATHSPEC_VERSION}`,
            `PyYAML==${PYYAML_VERSION}`,
        ]);
        if (install.status !== 0 || install.error) {
            finish(install, "Unable to install the pinned yamllint fallback");
            return;
        }

        const pythonPath = [installDirectory, process.env.PYTHONPATH]
            .filter(Boolean)
            .join(delimiter);
        finish(
            run(
                "python",
                [
                    "-m",
                    "yamllint",
                    ...arguments_,
                ],
                {
                    env: { ...process.env, PYTHONPATH: pythonPath },
                }
            ),
            "Unable to run the pinned yamllint fallback"
        );
    } finally {
        rmSync(installDirectory, { force: true, recursive: true });
    }
};

switch (process.argv[2]) {
    case "gitleaks": {
        runGitleaks();
        break;
    }
    case "yamllint": {
        runYamllint();
        break;
    }
    default: {
        console.error(
            "Expected one native linter argument: gitleaks or yamllint."
        );
        process.exitCode = 1;
    }
}
