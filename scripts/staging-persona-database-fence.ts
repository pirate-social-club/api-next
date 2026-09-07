import { createHash } from "node:crypto";

const digest = /^[a-f0-9]{64}$/u;
const identity = /^[a-zA-Z0-9_-]{1,128}$/u;
const time = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** The private runner-side shape is intentionally identical to FenceEvidence
 * in the merged reconciliation contract. Do not add claims to that contract. */
export interface FenceEvidence {
  readonly verifiedAt: string;
  readonly ingress: boolean;
  readonly producers: boolean;
  readonly databaseWrites: boolean;
  readonly reconnectDenied: boolean;
  readonly runtimeSessions: number;
  readonly residualDispositionId: string;
}

export interface RuntimeIdentityFenceObservation {
  /** A digest of the authenticated runtime identity, never its role name. */
  readonly identityFingerprint: string;
  readonly activeSessions: number;
  readonly databaseCreateDenied: boolean;
  readonly elevatedMembershipsDenied: boolean;
  readonly inheritedPrivilegesDenied: boolean;
  readonly publicPrivilegesDenied: boolean;
  readonly setRoleDenied: boolean;
  readonly ownershipDenied: boolean;
  readonly schemaAccessDenied: boolean;
  readonly tableAccessDenied: boolean;
  readonly sequenceAccessDenied: boolean;
  readonly securityDefinerDenied: boolean;
  readonly writeProbeDenied: boolean;
  readonly reconnectDenied: boolean;
}

export interface DatabaseFenceObservation {
  /** Counted from a fresh pg_stat_activity snapshot, excluding the observer. */
  readonly otherSessions: number;
  readonly preparedTransactions: number;
  readonly activeTransactions: number;
  readonly runtimeIdentities: readonly RuntimeIdentityFenceObservation[];
}

export interface DatabaseFenceProof {
  readonly databaseWrites: true;
  readonly reconnectDenied: true;
  readonly runtimeSessions: 0;
  readonly runtimeIdentityFingerprints: readonly string[];
}

function assertCount(value: number, error: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(error);
}

function assertDigest(value: string, error: string): void {
  if (!digest.test(value)) throw new Error(error);
}

function assertTime(value: string): void {
  if (!time.test(value) || Number.isNaN(Date.parse(value))) throw new Error("fence_time_unproven");
  if (new Date(value).toISOString() !== value) throw new Error("fence_time_unproven");
}

/**
 * Converts a trusted millisecond clock reading into the exact time format
 * expected by FenceEvidence. A timestamp supplied by an input artifact is not
 * accepted as the clock for this operation.
 */
export function canonicalFenceTime(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("fence_time_unproven");
  const result = new Date(value).toISOString();
  assertTime(result);
  return result;
}

function assertRuntimeIdentity(value: RuntimeIdentityFenceObservation): void {
  assertDigest(value.identityFingerprint, "runtime_identity_unproven");
  assertCount(value.activeSessions, "runtime_sessions_unproven");
  if (
    [
      value.databaseCreateDenied,
      value.elevatedMembershipsDenied,
      value.inheritedPrivilegesDenied,
      value.publicPrivilegesDenied,
      value.setRoleDenied,
      value.ownershipDenied,
      value.schemaAccessDenied,
      value.tableAccessDenied,
      value.sequenceAccessDenied,
      value.securityDefinerDenied,
      value.writeProbeDenied,
      value.reconnectDenied,
    ].some((result) => result !== true) ||
    value.activeSessions !== 0
  ) {
    throw new Error("runtime_fence_unproven");
  }
}

/**
 * Emits a positive proof from fresh, authenticated observations. Every
 * runtime identity must be checked independently, including inherited/PUBLIC
 * privileges and SET ROLE/security-definer paths. Reconnect denial is a
 * separate check: a point-in-time session count cannot stand in for it.
 */
export function emitDatabaseFenceProof(
  observation: DatabaseFenceObservation,
): DatabaseFenceProof {
  assertCount(observation.otherSessions, "session_drain_unproven");
  assertCount(observation.preparedTransactions, "session_drain_unproven");
  assertCount(observation.activeTransactions, "session_drain_unproven");
  if (
    observation.otherSessions !== 0 ||
    observation.preparedTransactions !== 0 ||
    observation.activeTransactions !== 0 ||
    observation.runtimeIdentities.length === 0
  ) {
    throw new Error("session_drain_unproven");
  }
  const fingerprints = observation.runtimeIdentities.map((runtime) => {
    assertRuntimeIdentity(runtime);
    return runtime.identityFingerprint;
  });
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw new Error("runtime_identity_ambiguous");
  }
  return Object.freeze({
    databaseWrites: true as const,
    reconnectDenied: true as const,
    runtimeSessions: 0 as const,
    runtimeIdentityFingerprints: Object.freeze([...fingerprints]),
  });
}

/**
 * Composes the database proof with the already-reviewed ingress and producer
 * receipts into the exact existing FenceEvidence shape. No verifier schema is
 * redefined here, and false/unknown component claims fail closed.
 */
export function emitFenceEvidence(input: {
  readonly verifiedAtMs: number;
  readonly ingress: boolean;
  readonly producers: boolean;
  readonly residualDispositionId: string;
  readonly database: DatabaseFenceObservation;
}): FenceEvidence & { readonly runtimeIdentityFingerprints: readonly string[] } {
  const database = emitDatabaseFenceProof(input.database);
  if (input.ingress !== true || input.producers !== true) {
    throw new Error("fence_components_unproven");
  }
  assertDigest(input.residualDispositionId, "residual_disposition_unproven");
  const verifiedAt = canonicalFenceTime(input.verifiedAtMs);
  return Object.freeze({
    verifiedAt,
    ingress: true,
    producers: true,
    databaseWrites: database.databaseWrites,
    reconnectDenied: database.reconnectDenied,
    runtimeSessions: database.runtimeSessions,
    residualDispositionId: input.residualDispositionId,
    runtimeIdentityFingerprints: database.runtimeIdentityFingerprints,
  });
}

/**
 * Encodes a scope-bound private artifact exactly as the reconciliation adapter
 * expects: the artifact ID is the SHA-256 of the exact UTF-8 bytes. The
 * caller persists these bytes in its private artifact directory and records
 * the returned ID in its authenticated manifest.
 */
export function encodeFenceEvidenceArtifact(
  scope: unknown,
  evidence: FenceEvidence,
): { readonly id: string; readonly bytes: string } {
  const bytes = JSON.stringify({ scope, data: evidence });
  if (bytes === undefined) throw new Error("fence_artifact_scope_unproven");
  const id = createHash("sha256").update(bytes, "utf8").digest("hex");
  return Object.freeze({ id, bytes });
}

export function assertFenceEvidenceShape(value: FenceEvidence): void {
  assertTime(value.verifiedAt);
  if (
    value.ingress !== true ||
    value.producers !== true ||
    value.databaseWrites !== true ||
    value.reconnectDenied !== true ||
    value.runtimeSessions !== 0
  ) {
    throw new Error("fence_evidence_unproven");
  }
  assertDigest(value.residualDispositionId, "residual_disposition_unproven");
}

export function runtimeIdentityFingerprint(identityName: string): string {
  if (!identity.test(identityName)) throw new Error("runtime_identity_unproven");
  return createHash("sha256").update(identityName, "utf8").digest("hex");
}
