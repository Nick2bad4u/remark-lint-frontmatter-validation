import type { UnknownRecord } from "type-fest";

import { inspect } from "node:util";
import { keyIn } from "ts-extras";

/** Return a useful message from an unknown caught value. */
export function getErrorMessage(error: unknown): string {
    if (hasStringMessage(error)) {
        return error.message;
    }

    if (typeof error === "string") {
        return error;
    }

    return inspect(error);
}

function hasStringMessage(
    value: unknown
): value is { readonly message: string } {
    return (
        isUnknownRecord(value) &&
        keyIn(value, "message") &&
        typeof value["message"] === "string"
    );
}

function isUnknownRecord(value: unknown): value is UnknownRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
