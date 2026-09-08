import { createHash } from "node:crypto";
import { Schema } from "effect";
import {
  ReconciliationCount as Count,
  ReconciliationDigest as Digest,
  decodeReconciliation,
  ReconciliationPhase as Phase,
  ReconciliationTarget as Target,
  ReconciliationText as Text,
  ReconciliationTime as Time,
} from "./karaoke-reconciliation-schema.ts";
import { KaraokeResetTarget } from "./karaoke-reset-installation.ts";

export const ReconciliationScope = Schema.Struct({ target: Target, phase: Phase, epoch: Digest });
export type ReconciliationScope = typeof ReconciliationScope.Type;
const Entry = Schema.Struct({ id: Digest, scope: ReconciliationScope });
export const ReconciliationManifest = Schema.Struct({
  version: Schema.Literal("staging-karaoke-reconciliation-manifest-v1"),
  epoch: Digest,
  bucket: Text,
  residualDispositionId: Digest,
  currentFenceEpoch: Schema.NullOr(Digest),
  releasedAt: Schema.NullOr(Time),
  targets: Schema.Array(
    Schema.Struct({
      objectId: Target.fields.objectId,
      markerState: Schema.Literals(["active", "retired"]),
      alarm: Schema.NullOr(Count),
      sockets: Count,
      keyNotReused: Schema.Boolean,
      receiptIds: Schema.Array(Digest).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
    }),
  ).check(Schema.isMinLength(6), Schema.isMaxLength(6)),
  entries: Schema.Array(Entry).check(Schema.isMaxLength(8192)),
});

/** Owning operator adapter authenticates provenance AND fresh fence/marker/non-reuse
 * observations. Never implement this by parsing a caller-supplied manifest. No
 * live adapter is installed by this module; the private run store is the boundary. */
export interface KaraokeReconciliationEvidencePort {
  readCurrentAuthenticatedManifest(): Promise<unknown>;
  readArtifact(id: string): Promise<string>;
}

export const ResidualDisposition = Schema.Struct({
  version: Schema.Literal("staging-karaoke-residual-disposition-v1"),
  namespaceId: KaraokeResetTarget.fields.namespaceId,
  generation: KaraokeResetTarget.fields.generation,
  inventoryDigest: KaraokeResetTarget.fields.inventoryDigest,
  epoch: Digest,
  bucket: Text,
  role: Schema.Literal("workspace_owner"),
  decision: Schema.Literal("accept-staging-audio-residual-retention"),
});

export async function verifyResidualDisposition(
  port: KaraokeReconciliationEvidencePort,
  manifest: typeof ReconciliationManifest.Type,
) {
  // This reference is admitted by the authenticated manifest itself. Unlike a
  // per-object pass, the owner's disposition covers the entire frozen inventory.
  const bytes = await port.readArtifact(manifest.residualDispositionId);
  if (
    Buffer.byteLength(bytes, "utf8") > 262144 ||
    reconciliationDigest(bytes) !== manifest.residualDispositionId
  )
    throw new Error("karaoke_reconciliation_disposition_digest_mismatch");
  const disposition = decodeReconciliation(ResidualDisposition, JSON.parse(bytes));
  if (disposition.epoch !== manifest.epoch || disposition.bucket !== manifest.bucket)
    throw new Error("karaoke_reconciliation_disposition_scope_mismatch");
}

export const AuthorityEvidence = Schema.NullOr(Schema.Struct({ accountId: Text, attemptId: Text }));
export const ArchiveEvidence = Schema.NullOr(
  Schema.Struct({ key: Text, uploadId: Schema.NullOr(Text) }),
);
export const HistoryEvidence = Schema.Struct({
  storageNeverDeleted: Schema.Boolean,
  namespaceUnchanged: Schema.Boolean,
});
export const FenceEvidence = Schema.Struct({
  verifiedAt: Time,
  ingress: Schema.Boolean,
  producers: Schema.Boolean,
  databaseWrites: Schema.Boolean,
  reconnectDenied: Schema.Boolean,
  runtimeSessions: Count,
  residualDispositionId: Digest,
});
export const ReleaseEvidence = Schema.Struct({ releasedAt: Time, allSixRetired: Schema.Boolean });
const Marker = Schema.NullOr(Schema.Struct({ key: Text, uploadId: Text }));
const ProviderResponse = Schema.Struct({
  endpointKind: Schema.Literal("staging-bucket-s3"),
  bucket: Text,
  requestId: Text,
  status: Count,
});
export const UploadListEvidence = Schema.Struct({
  key: Text,
  pages: Schema.Array(
    Schema.Struct({
      marker: Marker,
      nextMarker: Marker,
      succeeded: Schema.Boolean,
      response: ProviderResponse,
      prefix: Text,
      uploads: Schema.Array(Schema.Struct({ key: Text, uploadId: Text })).check(
        Schema.isMaxLength(1000),
      ),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});
export const HeadEvidence = Schema.Struct({
  key: Text,
  bucketVerified: Schema.Boolean,
  response: ProviderResponse,
  state: Schema.Literals(["present", "absent", "failed"]),
});
export const ActionsEvidence = Schema.Array(
  Schema.Struct({
    kind: Schema.Literals(["abort", "delete"]),
    key: Text,
    uploadId: Schema.NullOr(Text),
    outcome: Schema.Literals(["succeeded", "not-found", "failed"]),
    response: ProviderResponse,
  }),
).check(Schema.isMaxLength(4096));

export function reconciliationDigest(bytes: string): string {
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

export function makeReconciliationReader(
  port: KaraokeReconciliationEvidencePort,
  manifest: typeof ReconciliationManifest.Type,
) {
  const entries = new Map(manifest.entries.map((entry) => [entry.id, entry.scope]));
  if (entries.size !== manifest.entries.length)
    throw new Error("karaoke_reconciliation_duplicate_artifact");
  return async <S extends Schema.ConstraintDecoder<unknown>>(
    id: string,
    scope: ReconciliationScope,
    schema: S,
  ): Promise<S["Type"]> => {
    const admitted = entries.get(id);
    if (admitted === undefined || JSON.stringify(admitted) !== JSON.stringify(scope)) {
      throw new Error("karaoke_reconciliation_untrusted_reference");
    }
    const bytes = await port.readArtifact(id);
    if (Buffer.byteLength(bytes, "utf8") > 262144 || reconciliationDigest(bytes) !== id) {
      throw new Error("karaoke_reconciliation_digest_mismatch");
    }
    // Scope is inside the hashed envelope as well as the authenticated manifest.
    const envelope = decodeReconciliation(
      Schema.Struct({ scope: ReconciliationScope, data: Schema.Unknown }),
      JSON.parse(bytes),
    );
    if (JSON.stringify(envelope.scope) !== JSON.stringify(scope)) {
      throw new Error("karaoke_reconciliation_scope_mismatch");
    }
    return decodeReconciliation(schema, envelope.data);
  };
}
