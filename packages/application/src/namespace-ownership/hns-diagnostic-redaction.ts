const MAX_DIAGNOSTIC_CAUSE_LENGTH = 160;

/**
 * Redacts an infrastructure error or diagnostic string into a bounded cause.
 *
 * URLs and connection strings never survive; control characters collapse to
 * spaces. Shared by the startup probe diagnostics and the operational
 * snapshot so both surfaces report the same redacted shape.
 */
export function redactedDiagnosticCause(error: unknown): string | null {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const redacted = message
    .replaceAll(/\b(?:postgres(?:ql)?|https?):\/\/\S+/giu, "<redacted>")
    .replaceAll(/[^\x20-\x7e]/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_DIAGNOSTIC_CAUSE_LENGTH);
  return redacted.length === 0 ? null : redacted;
}
