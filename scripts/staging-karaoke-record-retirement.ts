import type { CloudflareAccessJwtFetch } from "../packages/platform-cf/src/cloudflare-access-jwt.ts";
import {
  FenceEvidence,
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
import { verifyKaraokeJournalState } from "./staging-karaoke-journal-manifest.ts";
import type { KaraokeSigningReaders } from "./staging-karaoke-signing-collector.ts";

/** Originates the journal's all-retired entry from fresh readbacks of all six
 * permanent retired markers plus a maintained fence. Marker retirement itself
 * happened through the reviewed retirement operation before this command;
 * recording never retires anything. */
export async function recordKaraokeRetirementCompletion(input: {
  readonly trust: KaraokeAdapterTrust;
  readonly journal: KaraokeJournalTrust;
  readonly privateKeyPem: string;
  readonly assertion: string;
  readonly challenge: KaraokeCollectorChallenge;
  readonly readers: KaraokeSigningReaders;
  readonly now?: () => string;
  readonly authenticationFetch?: CloudflareAccessJwtFetch;
}) {
  const now = input.now ?? (() => new Date().toISOString());
  const started = reconciliationMillis(now());
  const { trust, challenge } = input;
  if (
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
    throw new Error("karaoke_retirement_origin_scope_denied");
  await admitKaraokeResetOperator(trust.operator, input.assertion, input.authenticationFetch);
  const journal = readKaraokeMaintenanceJournal(input.journal, now());
  if (journal.state !== "reset") throw new Error("karaoke_retirement_origin_state_denied");
  const admission = await verifyKaraokeJournalState({ journal, trust, nowUtc: now() });
  if (
    !admission.result.latestPasses.every(
      (pass) => pass.phase === "retirement" && pass.outcome !== "incomplete",
    )
  )
    throw new Error("karaoke_retirement_origin_admission_denied");
  const fence = decodeReconciliation(
    FenceEvidence,
    (await input.readers.observeMaintainedFence()).fence,
  );
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
    throw new Error("karaoke_retirement_origin_fence_unproven");
  const artifacts = [
    JSON.stringify({ kind: "retirement-challenge", challenge }),
    JSON.stringify({ kind: "retirement-fence", fence }),
  ];
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
      snapshot.markerState !== "retired" ||
      snapshot.initial === null ||
      snapshot.installationReceipt?.state !== "retired" ||
      !snapshot.installationReceipt.cancellationSucceeded ||
      snapshot.current.alarm !== null ||
      snapshot.current.sockets !== 0 ||
      reconciliationMillis(snapshot.observedAt) < started ||
      reconciliationMillis(snapshot.observedAt) > reconciliationMillis(now())
    )
      throw new Error("karaoke_retirement_origin_marker_unproven");
    artifacts.push(JSON.stringify({ kind: "retirement-inspection", snapshot }));
  }
  if (reconciliationMillis(now()) < started || reconciliationMillis(now()) - started > 60_000)
    throw new Error("karaoke_retirement_origin_expired");
  const appended = appendKaraokeMaintenanceEvent({
    trust: input.journal,
    privateKeyPem: input.privateKeyPem,
    observedAt: now(),
    expectedCurrentHead: journal.head,
    event: { kind: "all-retired", evidenceIds: artifacts.map(reconciliationDigest) },
    artifacts,
  });
  return { head: appended.head, executionAuthorized: false as const };
}
