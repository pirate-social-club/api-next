import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { Schema } from "effect";
import type { CloudflareAccessJwtFetch } from "../packages/platform-cf/src/cloudflare-access-jwt.ts";
import { verifyKaraokeReconciliation } from "../packages/platform-cf/src/karaoke-reconciliation.ts";
import {
  FenceEvidence,
  ReconciliationManifest,
  ReconciliationScope,
  reconciliationDigest,
} from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import {
  decodeReconciliation,
  reconciliationMillis,
} from "../packages/platform-cf/src/karaoke-reconciliation-schema.ts";
import { KaraokeResetSnapshotSchema } from "../packages/platform-cf/src/karaoke-reset-inspection.ts";
import {
  KARAOKE_RESET_GENERATION,
  KARAOKE_RESET_INVENTORY_DIGEST,
  KARAOKE_RESET_NAMESPACE_ID,
  KARAOKE_RESET_OBJECT_IDS,
  KaraokeResetTarget,
} from "../packages/platform-cf/src/karaoke-reset-installation.ts";
import { admitKaraokeResetOperator } from "../packages/platform-cf/src/karaoke-reset-operator-auth.ts";
import {
  type KaraokeJournalTrust,
  readKaraokeMaintenanceJournal,
} from "./karaoke-maintenance-journal.ts";
import { openKaraokePrivateWriter } from "./karaoke-private-writer.ts";
import {
  type KaraokeAdapterTrust,
  KaraokeCollectorAttestation,
  type KaraokeCollectorChallenge,
} from "./karaoke-reconciliation-adapter.ts";

/** Implemented by the reviewed provider/SQL composition, never by supplied JSON.
 * This module owns signing, history and freshness; these readers own provenance.
 */
export interface KaraokeSigningReaders {
  inspect(target: typeof KaraokeResetTarget.Type): Promise<unknown>;
  verifyNonReuse(
    snapshot: typeof KaraokeResetSnapshotSchema.Type,
    phase: "before-reset" | "after-reset",
  ): Promise<{ readonly keyNotReused: true; readonly observedAt: string }>;
  observeMaintainedFence(): Promise<{ readonly fence: unknown; readonly supporting: unknown }>;
}
const Envelope = Schema.Struct({ scope: ReconciliationScope, data: Schema.Unknown });

/** No storage/provider mutation. A full verifier run precedes the atomic signed head.
 * Callers must provide concrete readers; no fallback treats missing observations as success.
 */
export async function collectSignedKaraokeReconciliation(input: {
  readonly trust: KaraokeAdapterTrust;
  readonly journal: KaraokeJournalTrust;
  readonly privateKeyPem: string;
  readonly assertion: string;
  readonly challenge: KaraokeCollectorChallenge;
  readonly readers: KaraokeSigningReaders;
  readonly authenticationFetch?: CloudflareAccessJwtFetch;
  readonly now?: () => string;
}) {
  const now = input.now ?? (() => new Date().toISOString());
  const started = reconciliationMillis(now());
  const { trust, challenge } = input;
  if (
    trust.directory === input.journal.directory ||
    input.journal.epoch !== trust.epoch ||
    input.journal.collectorSourceDigest !== trust.collectorSourceDigest ||
    input.journal.publicKeyPem !== trust.collectorPublicKeyPem ||
    challenge.version !== "staging-karaoke-collector-challenge-v1" ||
    challenge.epoch !== trust.epoch ||
    challenge.bucket !== trust.bucket ||
    challenge.operatorSubjectDigest !==
      reconciliationDigest(trust.operator.KARAOKE_RESET_ACCESS_SUBJECT ?? "")
  )
    throw new Error("karaoke_collector_scope_denied");
  await admitKaraokeResetOperator(trust.operator, input.assertion, input.authenticationFetch);
  const writer = openKaraokePrivateWriter(trust.directory);
  try {
    const journal = readKaraokeMaintenanceJournal(input.journal, now());
    if (journal.state === "unestablished" || journal.state === "broken")
      throw new Error("karaoke_collector_journal_unproven");
    const released = journal.entries.find(({ entry }) => entry.event.kind === "released");
    let releaseTime: string | null = null;
    if (released?.entry.event.kind === "released") {
      for (const id of released.entry.event.evidenceIds) {
        const artifact = JSON.parse(journal.readArtifact(id)) as {
          kind?: string;
          release?: { releasedAt?: unknown };
        };
        if (artifact.kind === "release-evidence") {
          if (typeof artifact.release?.releasedAt !== "string")
            throw new Error("karaoke_collector_release_evidence_denied");
          releaseTime = artifact.release.releasedAt;
          break;
        }
      }
      if (releaseTime === null) throw new Error("karaoke_collector_release_evidence_denied");
    }
    const reset = journal.entries.some(({ entry }) => entry.event.kind === "reset-verified");
    const freshArtifacts = new Map<string, string>();
    let freshFence: { readonly fence: unknown; readonly supporting: unknown } | undefined;
    if (released === undefined) {
      freshFence = await input.readers.observeMaintainedFence();
      const fence = decodeReconciliation(FenceEvidence, freshFence.fence);
      if (
        !fence.ingress ||
        !fence.producers ||
        !fence.databaseWrites ||
        !fence.reconnectDenied ||
        fence.runtimeSessions !== 0 ||
        fence.residualDispositionId !== trust.residualDispositionId ||
        reconciliationMillis(fence.verifiedAt) < started ||
        reconciliationMillis(fence.verifiedAt) > reconciliationMillis(now())
      )
        throw new Error("karaoke_collector_fence_unproven");
    }
    const entries = new Map<string, { id: string; scope: typeof ReconciliationScope.Type }>();
    for (const { entry } of journal.entries) {
      if (entry.event.kind !== "pass") continue;
      for (const id of entry.event.evidenceIds) {
        const envelope = decodeReconciliation(Envelope, JSON.parse(journal.readArtifact(id)));
        if (
          envelope.scope.epoch !== trust.epoch ||
          envelope.scope.target.bucket !== trust.bucket ||
          envelope.scope.target.objectId !== entry.event.objectId
        )
          throw new Error("karaoke_collector_artifact_scope_denied");
        const prior = entries.get(id);
        if (prior !== undefined && JSON.stringify(prior.scope) !== JSON.stringify(envelope.scope))
          throw new Error("karaoke_collector_artifact_conflict");
        entries.set(id, { id, scope: envelope.scope });
      }
    }
    const targets = [];
    // Serial database authority reads avoid overlapping transactions on a connection.
    for (const objectId of KARAOKE_RESET_OBJECT_IDS) {
      const target = decodeReconciliation(KaraokeResetTarget, {
        namespaceId: KARAOKE_RESET_NAMESPACE_ID,
        objectId,
        generation: KARAOKE_RESET_GENERATION,
        inventoryDigest: KARAOKE_RESET_INVENTORY_DIGEST,
      });
      const snapshot = decodeReconciliation(
        KaraokeResetSnapshotSchema,
        await input.readers.inspect(target),
      );
      if (
        Object.entries(target).some(([key, value]) => Reflect.get(snapshot, key) !== value) ||
        (snapshot.markerState !== "active" && snapshot.markerState !== "retired") ||
        snapshot.current.alarm !== null ||
        snapshot.current.sockets !== 0 ||
        snapshot.installationReceipt === null ||
        reconciliationMillis(snapshot.observedAt) < started ||
        reconciliationMillis(snapshot.observedAt) > reconciliationMillis(now())
      )
        throw new Error("karaoke_collector_marker_unproven");
      const nonReuse = await input.readers.verifyNonReuse(
        snapshot,
        reset ? "after-reset" : "before-reset",
      );
      if (
        nonReuse.keyNotReused !== true ||
        reconciliationMillis(nonReuse.observedAt) < started ||
        reconciliationMillis(nonReuse.observedAt) > reconciliationMillis(now())
      )
        throw new Error("karaoke_collector_nonreuse_unproven");
      const receiptIds = journal.history[objectId];
      const prior = trust.expectedHistory[objectId];
      if (
        receiptIds === undefined ||
        prior === undefined ||
        prior.some((id, index) => receiptIds[index] !== id)
      )
        throw new Error("karaoke_collector_history_denied");
      const latestId = receiptIds.at(-1);
      const scope = latestId === undefined ? undefined : entries.get(latestId)?.scope;
      if (!scope) throw new Error("karaoke_collector_latest_scope_missing");
      const retain = (data: unknown) => {
        const bytes = JSON.stringify({ scope, data });
        if (Buffer.byteLength(bytes) > 262_144) throw new Error("karaoke_collector_support_size");
        const id = reconciliationDigest(bytes);
        freshArtifacts.set(id, bytes);
        entries.set(id, { id, scope });
      };
      retain({ kind: "fresh-inspection", snapshot });
      retain({ kind: "fresh-nonreuse", observation: nonReuse });
      if (freshFence !== undefined) retain({ kind: "fresh-fence", observation: freshFence });
      targets.push({
        objectId,
        markerState: snapshot.markerState,
        alarm: snapshot.current.alarm,
        sockets: snapshot.current.sockets,
        keyNotReused: true,
        receiptIds,
      });
    }
    const manifest = decodeReconciliation(ReconciliationManifest, {
      version: "staging-karaoke-reconciliation-manifest-v1",
      epoch: trust.epoch,
      bucket: trust.bucket,
      residualDispositionId: trust.residualDispositionId,
      currentFenceEpoch: released === undefined ? trust.epoch : null,
      releasedAt: releaseTime,
      targets,
      entries: [...entries.values()],
    });
    const readArtifact = (id: string) => freshArtifacts.get(id) ?? journal.readArtifact(id);
    const result = await verifyKaraokeReconciliation(
      {
        readCurrentAuthenticatedManifest: async () => manifest,
        readArtifact: async (id) => readArtifact(id),
      },
      now(),
    );
    if (readKaraokeMaintenanceJournal(input.journal, now()).head.entryId !== journal.head.entryId)
      throw new Error("karaoke_collector_journal_changed");
    const observedAt = now();
    const ended = reconciliationMillis(observedAt);
    if (ended < started || ended - started > 60_000) throw new Error("karaoke_collector_expired");
    const payload = JSON.stringify(
      decodeReconciliation(KaraokeCollectorAttestation, {
        version: "staging-karaoke-collector-attestation-v1",
        challenge: challenge.challenge,
        operatorSubjectDigest: challenge.operatorSubjectDigest,
        collectorSourceDigest: trust.collectorSourceDigest,
        observedAt,
        manifest,
      }),
    );
    const key = createPrivateKey(input.privateKeyPem);
    const publicKey = createPublicKey(trust.collectorPublicKeyPem);
    if (key.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519")
      throw new Error("karaoke_collector_key_denied");
    const signature = sign(null, Buffer.from(payload), key);
    if (!verify(null, Buffer.from(payload), publicKey, signature))
      throw new Error("karaoke_collector_key_denied");
    for (const id of new Set([trust.residualDispositionId, ...entries.keys()]))
      if (writer.putArtifact(readArtifact(id)) !== id)
        throw new Error("karaoke_collector_copy_denied");
    writer.replaceManifest(JSON.stringify({ payload, signature: signature.toString("hex") }));
    return { ...result, executionAuthorized: false as const };
  } finally {
    writer.close();
  }
}
