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
  ReconciliationReceiptSchema,
  reconciliationMillis,
} from "../packages/platform-cf/src/karaoke-reconciliation-schema.ts";
import { KaraokeResetSnapshotSchema } from "../packages/platform-cf/src/karaoke-reset-inspection.ts";
import {
  KARAOKE_RESET_GENERATION,
  KARAOKE_RESET_INVENTORY_DIGEST,
  KARAOKE_RESET_NAMESPACE_ID,
  KARAOKE_RESET_OBJECT_IDS,
} from "../packages/platform-cf/src/karaoke-reset-installation.ts";
import { admitKaraokeResetOperator } from "../packages/platform-cf/src/karaoke-reset-operator-auth.ts";
import {
  appendKaraokeMaintenanceEvent,
  type KaraokeJournalTrust,
  readKaraokeMaintenanceJournal,
} from "./karaoke-maintenance-journal.ts";
import type {
  KaraokeAdapterTrust,
  KaraokeCollectorChallenge,
} from "./karaoke-reconciliation-adapter.ts";
import type { makeStagingKaraokeR2Observer } from "./staging-karaoke-r2-observer.ts";
import type { KaraokeSigningReaders } from "./staging-karaoke-signing-collector.ts";

const Envelope = Schema.Struct({ scope: ReconciliationScope, data: Schema.Unknown });
type Scope = typeof ReconciliationScope.Type;
type Phase = "post-fence" | "pre-reset";

/** Records observations only. Existing objects/uploads produce incomplete
 * receipts; this function has no cleanup, reset or release capability. */
export async function recordKaraokeObservationPass(input: {
  readonly trust: KaraokeAdapterTrust;
  readonly journal: KaraokeJournalTrust;
  readonly privateKeyPem: string;
  readonly assertion: string;
  readonly challenge: KaraokeCollectorChallenge;
  readonly phase: Phase;
  readonly readers: KaraokeSigningReaders;
  readonly r2: ReturnType<typeof makeStagingKaraokeR2Observer>;
  readonly now?: () => string;
  readonly authenticationFetch?: CloudflareAccessJwtFetch;
}) {
  const now = input.now ?? (() => new Date().toISOString());
  const started = reconciliationMillis(now());
  const { trust, challenge } = input;
  if (
    !["post-fence", "pre-reset"].includes(input.phase) ||
    input.journal.expectedHead === null ||
    input.journal.epoch !== trust.epoch ||
    input.journal.collectorSourceDigest !== trust.collectorSourceDigest ||
    input.journal.publicKeyPem !== trust.collectorPublicKeyPem ||
    challenge.version !== "staging-karaoke-collector-challenge-v1" ||
    challenge.epoch !== trust.epoch ||
    challenge.bucket !== trust.bucket ||
    challenge.operatorSubjectDigest !==
      reconciliationDigest(trust.operator.KARAOKE_RESET_ACCESS_SUBJECT ?? "")
  )
    throw new Error("karaoke_pass_scope_denied");
  await admitKaraokeResetOperator(trust.operator, input.assertion, input.authenticationFetch);
  const journal = readKaraokeMaintenanceJournal(input.journal, now());
  if (journal.state !== "held") throw new Error("karaoke_pass_fence_not_held");
  const checkFence = async () => {
    const observation = await input.readers.observeMaintainedFence();
    const fence = decodeReconciliation(FenceEvidence, observation.fence);
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
      throw new Error("karaoke_pass_fence_unproven");
    return { ...observation, fence };
  };
  const initialFence = await checkFence();
  const entries = new Map<string, { id: string; scope: Scope }>();
  for (const { entry } of journal.entries) {
    if (entry.event.kind !== "pass") continue;
    for (const id of entry.event.evidenceIds) {
      const envelope = decodeReconciliation(Envelope, JSON.parse(journal.readArtifact(id)));
      entries.set(id, { id, scope: envelope.scope });
    }
  }
  const fresh = new Map<string, string>();
  const pending: {
    objectId: (typeof KARAOKE_RESET_OBJECT_IDS)[number];
    receiptId: string;
    evidenceIds: string[];
  }[] = [];
  const targets = [];
  for (const objectId of KARAOKE_RESET_OBJECT_IDS) {
    const target = {
      namespaceId: KARAOKE_RESET_NAMESPACE_ID,
      objectId,
      generation: KARAOKE_RESET_GENERATION,
      inventoryDigest: KARAOKE_RESET_INVENTORY_DIGEST,
    } as const;
    const snapshot = decodeReconciliation(
      KaraokeResetSnapshotSchema,
      await input.readers.inspect(target),
    );
    if (
      Object.entries(target).some(([key, value]) => Reflect.get(snapshot, key) !== value) ||
      snapshot.markerState !== "active" ||
      snapshot.initial === null ||
      snapshot.installationReceipt?.state !== "active" ||
      !snapshot.installationReceipt.cancellationSucceeded ||
      snapshot.current.alarm !== null ||
      snapshot.current.sockets !== 0 ||
      snapshot.authority === null ||
      reconciliationMillis(snapshot.observedAt) < started ||
      reconciliationMillis(snapshot.observedAt) > reconciliationMillis(now())
    )
      throw new Error("karaoke_pass_marker_or_authority_unproven");
    const nonReuse = await input.readers.verifyNonReuse(snapshot, "before-reset");
    if (
      !nonReuse.keyNotReused ||
      reconciliationMillis(nonReuse.observedAt) < started ||
      reconciliationMillis(nonReuse.observedAt) > reconciliationMillis(now())
    )
      throw new Error("karaoke_pass_nonreuse_unproven");
    const previous = journal.history[objectId];
    const retained = trust.expectedHistory[objectId];
    if (
      previous === undefined ||
      retained === undefined ||
      retained.some((id, index) => previous[index] !== id)
    )
      throw new Error("karaoke_pass_history_denied");
    const scope: Scope = {
      target: { ...target, bucket: trust.bucket },
      phase: input.phase,
      epoch: trust.epoch,
    };
    const evidenceIds: string[] = [];
    const retain = (data: unknown) => {
      const bytes = JSON.stringify({ scope, data });
      if (Buffer.byteLength(bytes) > 262_144) throw new Error("karaoke_pass_artifact_limit");
      const id = reconciliationDigest(bytes);
      fresh.set(id, bytes);
      entries.set(id, { id, scope });
      if (!evidenceIds.includes(id)) evidenceIds.push(id);
      return id;
    };
    const passStarted = now();
    const before = await input.r2.observe(snapshot.authority);
    const after = await input.r2.observe(snapshot.authority);
    const key = `karaoke/${snapshot.authority.accountId}/${snapshot.authority.attemptId}.pcm`;
    const count = (observation: typeof before) =>
      new Set(
        observation.uploads.pages.flatMap((page) =>
          page.uploads.filter((upload) => upload.key === key).map((upload) => upload.uploadId),
        ),
      ).size;
    const beforeCount = count(before);
    const afterCount = count(after);
    retain({ kind: "pass-challenge", challenge });
    retain({ kind: "pass-inspection", snapshot, nonReuse });
    retain({ kind: "initial-fence", observation: initialFence });
    const receipt = decodeReconciliation(ReconciliationReceiptSchema, {
      version: "staging-karaoke-reconciliation-v1",
      target: scope.target,
      phase: scope.phase,
      startedAt: passStarted,
      endedAt: now(),
      mapping: {
        kind: "key",
        ...snapshot.authority,
        key,
        authorityEvidenceId: retain(snapshot.authority),
        archiveEvidenceId: retain(
          snapshot.current.archiveKey === null
            ? null
            : { key: snapshot.current.archiveKey, uploadId: snapshot.current.uploadId },
        ),
      },
      installationReceiptId: retain(snapshot.installationReceipt),
      fenceEvidenceId: retain(initialFence.fence),
      releaseEvidenceId: null,
      precedingReceiptId: previous.at(-1) ?? null,
      observations: {
        beforeUploadsId: retain(before.uploads),
        afterUploadsId: retain(after.uploads),
        beforeUploadCount: beforeCount,
        afterUploadCount: afterCount,
        beforeHeadId: retain(before.head),
        afterHeadId: retain(after.head),
        beforeHead: before.head.state,
        afterHead: after.head.state,
      },
      actionsEvidenceId: retain([]),
      outcome:
        beforeCount === 0 &&
        afterCount === 0 &&
        before.head.state === "absent" &&
        after.head.state === "absent"
          ? "observed-empty"
          : "incomplete",
    });
    const receiptId = retain(receipt);
    pending.push({ objectId, receiptId, evidenceIds });
    targets.push({
      objectId,
      markerState: "active",
      alarm: null,
      sockets: 0,
      keyNotReused: true,
      receiptIds: [...previous, receiptId],
    });
  }
  const finalFence = await checkFence();
  for (const pass of pending) {
    const scope = entries.get(pass.receiptId)?.scope;
    if (!scope) throw new Error("karaoke_pass_scope_missing");
    const bytes = JSON.stringify({ scope, data: { kind: "final-fence", observation: finalFence } });
    if (Buffer.byteLength(bytes) > 262_144) throw new Error("karaoke_pass_artifact_limit");
    const id = reconciliationDigest(bytes);
    fresh.set(id, bytes);
    entries.set(id, { id, scope });
    pass.evidenceIds.push(id);
  }
  const manifest = decodeReconciliation(ReconciliationManifest, {
    version: "staging-karaoke-reconciliation-manifest-v1",
    epoch: trust.epoch,
    bucket: trust.bucket,
    residualDispositionId: trust.residualDispositionId,
    currentFenceEpoch: trust.epoch,
    releasedAt: null,
    targets,
    entries: [...entries.values()],
  });
  const result = await verifyKaraokeReconciliation(
    {
      readCurrentAuthenticatedManifest: async () => manifest,
      readArtifact: async (id) => fresh.get(id) ?? journal.readArtifact(id),
    },
    now(),
  );
  if (reconciliationMillis(now()) < started || reconciliationMillis(now()) - started > 60_000)
    throw new Error("karaoke_pass_observation_expired");
  let head = journal.head;
  for (const pass of pending) {
    if (reconciliationMillis(now()) - started > 60_000)
      throw new Error("karaoke_pass_observation_expired");
    const appended = appendKaraokeMaintenanceEvent({
      trust: input.journal,
      privateKeyPem: input.privateKeyPem,
      observedAt: now(),
      expectedCurrentHead: head,
      event: { kind: "pass", ...pass },
      artifacts: pass.evidenceIds.map((id) => {
        const bytes = fresh.get(id);
        if (bytes === undefined) throw new Error("karaoke_pass_artifact_missing");
        return bytes;
      }),
    });
    head = appended.head;
  }
  return { ...result, head, executionAuthorized: false as const };
}
