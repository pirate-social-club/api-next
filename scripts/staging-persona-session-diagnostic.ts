import { createHash } from "node:crypto";

const digest = /^[a-f0-9]{64}$/u;
const userOid = /^\d+$/u;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u;

export interface SessionDiagnosticInput {
  readonly pid: number;
  readonly userOid: string | null;
  readonly role: string | null;
  readonly applicationName: string | null;
  readonly backendType: string | null;
  readonly clientAddress: string | null;
  readonly backendStart: string | null;
  readonly state: string | null;
  readonly queryStart: string | null;
}

export interface SessionDiagnostic {
  readonly pid: number;
  readonly user_oid: string | null;
  readonly role_sha256: string | null;
  readonly application_sha256: string | null;
  readonly backend_type_sha256: string | null;
  readonly client_address_sha256: string | null;
  readonly backend_start: string | null;
  readonly state: string | null;
  readonly query_start: string | null;
  /** Provider/Hyperdrive attribution remains unresolved without independent evidence. */
  readonly attribution: "unresolved";
}

function hashNullable(value: string | null): string | null {
  return value === null ? null : createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalTimestamp(value: string | null): string | null {
  if (value === null) return null;
  if (!timestamp.test(value)) throw new Error("session_diagnostic_timestamp");
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("session_diagnostic_timestamp");
  return new Date(parsed).toISOString();
}

function assertInput(input: SessionDiagnosticInput): void {
  if (!Number.isSafeInteger(input.pid) || input.pid < 1) throw new Error("session_diagnostic_pid");
  if (input.userOid !== null && !userOid.test(input.userOid)) {
    throw new Error("session_diagnostic_user_oid");
  }
  for (const value of [input.role, input.applicationName, input.backendType, input.clientAddress]) {
    if (value !== null && (value.length === 0 || value.length > 4096)) {
      throw new Error("session_diagnostic_value");
    }
  }
  if (input.state !== null && !/^[a-z_() ]{1,64}$/u.test(input.state)) {
    throw new Error("session_diagnostic_state");
  }
  canonicalTimestamp(input.backendStart);
  canonicalTimestamp(input.queryStart);
}

/**
 * Retains enough identity to compare a refused session across observations,
 * while never emitting role/application/address strings, query text or
 * credentials. In particular, this does not label a session as Hyperdrive.
 */
export function describeSessionDiagnostic(input: SessionDiagnosticInput): SessionDiagnostic {
  assertInput(input);
  return Object.freeze({
    pid: input.pid,
    user_oid: input.userOid,
    role_sha256: hashNullable(input.role),
    application_sha256: hashNullable(input.applicationName),
    backend_type_sha256: hashNullable(input.backendType),
    client_address_sha256: hashNullable(input.clientAddress),
    backend_start: canonicalTimestamp(input.backendStart),
    state: input.state,
    query_start: canonicalTimestamp(input.queryStart),
    attribution: "unresolved" as const,
  });
}

export function describeSessionDiagnostics(
  inputs: readonly SessionDiagnosticInput[],
): readonly SessionDiagnostic[] {
  const result = inputs.map(describeSessionDiagnostic);
  if (new Set(result.map((session) => session.pid)).size !== result.length) {
    throw new Error("session_diagnostic_duplicate_pid");
  }
  return Object.freeze(result.sort((left, right) => left.pid - right.pid));
}

export function assertSessionDiagnostic(value: SessionDiagnostic): void {
  if (
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    (value.role_sha256 !== null && !digest.test(value.role_sha256)) ||
    (value.application_sha256 !== null && !digest.test(value.application_sha256)) ||
    (value.backend_type_sha256 !== null && !digest.test(value.backend_type_sha256)) ||
    (value.client_address_sha256 !== null && !digest.test(value.client_address_sha256)) ||
    value.attribution !== "unresolved"
  ) {
    throw new Error("session_diagnostic_unproven");
  }
}
