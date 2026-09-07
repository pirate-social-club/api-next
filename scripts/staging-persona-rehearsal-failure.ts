import { createHash } from "node:crypto";

/** SQLSTATE and a message fingerprint only. Never emit a driver message,
 * query, detail, connection string or attached cause. Internal error literals
 * can be matched to the digest offline without weakening output redaction.
 */
export function describeRehearsalFailure(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  const sqlState =
    typeof error === "object" && error !== null && "sqlState" in error ? error.sqlState : null;
  const valid = (value: unknown): value is string =>
    typeof value === "string" && /^[0-9A-Z]{5}$/.test(value);
  return {
    sqlstate: valid(code) ? code : valid(sqlState) ? sqlState : null,
    message_sha256:
      error instanceof Error ? createHash("sha256").update(error.message).digest("hex") : null,
  };
}
