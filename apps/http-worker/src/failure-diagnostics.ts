/**
 * Diagnostic capture for failures the HTTP boundary redacts.
 *
 * The wire contract deliberately collapses an unexpected failure into
 * `internal_error` carrying no detail, and the transport replaces an undeclared
 * error with a fresh one, so the original cause survives nowhere else. This
 * module builds the one record that is kept.
 *
 * Every field is present because it was named here. Nothing is copied off the
 * error wholesale: an allow list cannot leak a field a future error type
 * invents, while a deny list would. Free text that does survive is scrubbed of
 * credential shapes before it is returned, because a driver is free to put a
 * value into a message.
 */

/** Longest message retained; a longer one is truncated with a marker. */
const MESSAGE_LIMIT = 300;
/** Stack frames retained, counted from the throw site. */
const STACK_FRAME_LIMIT = 6;
/** Longest retained frame line. */
const FRAME_LIMIT = 200;
/** Longest accepted machine code, e.g. a PostgreSQL SQLSTATE. */
const CODE_LIMIT = 40;
/**
 * Longest accepted control-plane field. Statement labels and constraint names
 * are long by design — `community_route_attachment_intents_one_open_per_community_uidx`
 * is 62 characters — and truncating one would defeat the point of keeping it.
 */
const CONTROL_PLANE_FIELD_LIMIT = 120;

const CODE_SHAPE = /^[A-Za-z0-9_.-]+$/u;

const REDACTIONS: readonly (readonly [RegExp, string])[] = [
  // `scheme://user:secret@host` in a connection string or URL.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]+@/giu, "$1:[redacted]@"],
  // An HTTP credential presented inline.
  [/\b(bearer|basic)\s+[\w\-._~+/]+=*/giu, "$1 [redacted]"],
  // A named secret assigned with either `:` or `=`.
  [
    /\b(authorization|cookie|set-cookie|csrf[\w-]*|passwd|password|secret|session[\w-]*|api[_-]?key|access[_-]?token|refresh[_-]?token|token)\b\s*[:=]\s*"?[^\s",;]+"?/giu,
    "$1=[redacted]",
  ],
  // A signed token: three dot-separated base64url segments.
  [/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "[redacted]"],
  // Any remaining long unbroken opaque run. Identifiers this product logs on
  // purpose (UUIDs, prefixed resource ids, SQLSTATEs) carry `-` or `_` and are
  // left intact; an undelimited 32-character run is treated as a secret even
  // when it is only a digest, because the two cannot be told apart here.
  [/\b[A-Za-z0-9+/]{32,}={0,2}\b/gu, "[redacted]"],
];

/** Remove credential shapes from free text that is about to be retained. */
export function redactDiagnosticText(value: string): string {
  let text = value.replace(/\s+/gu, " ").trim();
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
  return text;
}

const truncate = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit)}…[truncated]`;

const stringField = (source: object, key: string): string | undefined => {
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const errorName = (error: unknown): string => {
  if (error instanceof Error && error.name.length > 0) return error.name;
  if (typeof error === "object" && error !== null) {
    return error.constructor?.name ?? "Object";
  }
  return typeof error;
};

const errorMessage = (error: unknown): string | undefined => {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof error === "object" && error !== null
          ? stringField(error, "message")
          : undefined;
  if (raw === undefined || raw.length === 0) return undefined;
  return truncate(redactDiagnosticText(raw), MESSAGE_LIMIT);
};

const errorTag = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const tag = stringField(error, "_tag");
  return tag !== undefined && tag.length <= CODE_LIMIT && CODE_SHAPE.test(tag) ? tag : undefined;
};

/**
 * A driver's machine-readable code, such as a PostgreSQL SQLSTATE. Accepted
 * only in code shape, so a code field holding prose or a value cannot ride
 * through unscrubbed.
 */
const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const code = stringField(error, "code");
  return code !== undefined && code.length <= CODE_LIMIT && CODE_SHAPE.test(code)
    ? code
    : undefined;
};

/**
 * Fields the control-plane layer already sanitises when it builds a failure:
 * the statement label, the five-character SQLSTATE, the violated constraint
 * name, and how certain the outcome is. Together they name what failed without
 * carrying any statement text or parameter value, and they are the whole answer
 * for a database failure. Each is still shape-checked here rather than trusted,
 * so a future field holding prose cannot ride through on the same name.
 */
const CONTROL_PLANE_FIELDS = ["label", "sqlState", "constraint", "outcomeCertainty"] as const;
const CONTROL_PLANE_FIELD_NAMES: Readonly<Record<string, string>> = {
  label: "statement",
  sqlState: "sql_state",
  constraint: "constraint",
  outcomeCertainty: "outcome_certainty",
};

const controlPlaneFields = (error: unknown): Readonly<Record<string, string>> | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const fields: Record<string, string> = {};
  for (const key of CONTROL_PLANE_FIELDS) {
    const value = stringField(error, key);
    if (value === undefined || value.length > CONTROL_PLANE_FIELD_LIMIT) continue;
    if (!CODE_SHAPE.test(value)) continue;
    const name = CONTROL_PLANE_FIELD_NAMES[key];
    if (name !== undefined) fields[name] = value;
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
};

const errorStack = (error: unknown): readonly string[] | undefined => {
  if (!(error instanceof Error) || typeof error.stack !== "string") return undefined;
  const frames = error.stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .slice(0, STACK_FRAME_LIMIT)
    .map((line) => truncate(redactDiagnosticText(line), FRAME_LIMIT));
  return frames.length > 0 ? frames : undefined;
};

/**
 * `replaced` — the transport substituted a generic internal error and the cause
 * exists only in this record. `passthrough` — the handler raised an internal
 * error itself, which still reaches the client with no detail.
 */
export type BoundaryFailureDisposition = "replaced" | "passthrough";

export interface BoundaryFailureInput {
  readonly requestId: string;
  readonly endpoint: string;
  readonly route: string;
  readonly method: string;
  readonly disposition: BoundaryFailureDisposition;
  readonly error: unknown;
}

interface BoundaryFailureCause {
  readonly error_name: string;
  readonly error_tag?: string;
  readonly error_code?: string;
  readonly error_message?: string;
  readonly statement?: string;
  readonly sql_state?: string;
  readonly constraint?: string;
  readonly outcome_certainty?: string;
}

export interface BoundaryFailureDiagnostic {
  readonly request_id: string;
  readonly endpoint: string;
  readonly route: string;
  readonly method: string;
  readonly disposition: BoundaryFailureDisposition;
  readonly error_name: string;
  readonly error_tag?: string;
  readonly error_code?: string;
  readonly error_message?: string;
  readonly stack?: readonly string[];
  readonly statement?: string;
  readonly sql_state?: string;
  readonly constraint?: string;
  readonly outcome_certainty?: string;
  readonly causes?: readonly BoundaryFailureCause[];
}

/** Cause links followed; deep enough for a wrapped domain failure, bounded. */
const CAUSE_DEPTH_LIMIT = 3;

/**
 * The chain a handler preserved when it mapped a domain failure onto a wire
 * error. This is usually where the answer is: the outer error says only that
 * the operation failed, and the cause says why. Each link is described with the
 * same allow list as the outer error, and no stack is repeated.
 */
const errorCauses = (error: unknown): readonly BoundaryFailureCause[] | undefined => {
  const causes: BoundaryFailureCause[] = [];
  const seen = new Set<unknown>([error]);
  let current: unknown = error;
  while (causes.length < CAUSE_DEPTH_LIMIT) {
    if (typeof current !== "object" || current === null) break;
    const next: unknown = (current as { cause?: unknown }).cause;
    if (next === undefined || next === null || seen.has(next)) break;
    seen.add(next);
    const tag = errorTag(next);
    const code = errorCode(next);
    const message = errorMessage(next);
    causes.push({
      error_name: errorName(next),
      ...(tag === undefined ? {} : { error_tag: tag }),
      ...(code === undefined ? {} : { error_code: code }),
      ...(message === undefined ? {} : { error_message: message }),
      ...controlPlaneFields(next),
    });
    current = next;
  }
  return causes.length > 0 ? causes : undefined;
};

/**
 * Build the retained record for a failure leaving the boundary as
 * `internal_error`. `request_id` matches the `x-request-id` response header and
 * the `request_id` field of the error body, so a report from a user identifies
 * the entry exactly.
 */
export function boundaryFailureDiagnostic(input: BoundaryFailureInput): BoundaryFailureDiagnostic {
  const tag = errorTag(input.error);
  const code = errorCode(input.error);
  const message = errorMessage(input.error);
  const stack = errorStack(input.error);
  const causes = errorCauses(input.error);
  const controlPlane = controlPlaneFields(input.error);
  return {
    request_id: input.requestId,
    endpoint: input.endpoint,
    route: input.route,
    method: input.method,
    disposition: input.disposition,
    error_name: errorName(input.error),
    ...(tag === undefined ? {} : { error_tag: tag }),
    ...(code === undefined ? {} : { error_code: code }),
    ...(message === undefined ? {} : { error_message: message }),
    ...(stack === undefined ? {} : { stack }),
    ...controlPlane,
    ...(causes === undefined ? {} : { causes }),
  };
}

/** Event name for the retained record; the query handle in Workers Logs. */
export const BOUNDARY_FAILURE_EVENT = "http_boundary_failure";
