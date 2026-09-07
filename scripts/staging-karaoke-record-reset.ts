import { Schema } from "effect";
import type { CloudflareAccessJwtFetch } from "../packages/platform-cf/src/cloudflare-access-jwt.ts";
import {
  FenceEvidence,
  reconciliationDigest,
} from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import {
  decodeReconciliation,
  ReconciliationCount,
  ReconciliationDigest,
  ReconciliationText,
  ReconciliationTime,
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

/** Completed reset facts as verified by the trusted reset-executor binding.
 * Zero persona counts and the recorded server version are evidence, never
 * execution authority. */
export const KaraokeResetCompletion = Schema.Struct({
  version: Schema.Literal("staging-karaoke-reset-completion-v1"),
  verifiedAt: ReconciliationTime,
  serverVersion: ReconciliationText,
  terminalMigration: ReconciliationText,
  ledgerDigest: ReconciliationDigest,
  personaCounts: Schema.Struct({
    unbound: ReconciliationCount,
    singleCommunity: ReconciliationCount,
    multiCommunity: ReconciliationCount,
  }),
  personaEvidenceDigest: ReconciliationDigest,
});

/** Originates the journal's reset-verified entry. Admission requires the real
 * reconciliation verifier to find every target pre-reset complete under a
 * maintained fence; completion and after-reset absence come from trusted
 * operations, never from caller booleans. This records a reset that already
 * happened; it cannot execute one. */
export async function recordKaraokeResetVerification(input: {
  readonly trust: KaraokeAdapterTrust;
  readonly journal: KaraokeJournalTrust;
  readonly privateKeyPem: string;
  readonly assertion: string;
  readonly challenge: KaraokeCollectorChallenge;
  readonly readers: KaraokeSigningReaders;
  readonly verifyResetCompletion: () => Promise<unknown>;
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
    throw new Error("karaoke_reset_origin_scope_denied");
  await admitKaraokeResetOperator(trust.operator, input.assertion, input.authenticationFetch);
  const journal = readKaraokeMaintenanceJournal(input.journal, now());
  if (journal.state !== "held") throw new Error("karaoke_reset_origin_state_denied");
  const admission = await verifyKaraokeJournalState({ journal, trust, nowUtc: now() });
  if (admission.result.resetAdmission !== "eligible")
    throw new Error("karaoke_reset_origin_admission_denied");
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
    throw new Error("karaoke_reset_origin_fence_unproven");
  const completion = decodeReconciliation(
    KaraokeResetCompletion,
    await input.verifyResetCompletion(),
  );
  // The reset itself ran before this recording; its completion must postdate
  // the last signed journal entry (the admission pass) but not the present.
  const lastEntry = journal.entries.at(-1)?.entry.observedAt;
  if (
    completion.personaCounts.unbound !== 0 ||
    completion.personaCounts.singleCommunity !== 0 ||
    completion.personaCounts.multiCommunity !== 0 ||
    lastEntry === undefined ||
    reconciliationMillis(completion.verifiedAt) < reconciliationMillis(lastEntry) ||
    reconciliationMillis(completion.verifiedAt) > reconciliationMillis(now())
  )
    throw new Error("karaoke_reset_origin_completion_unproven");
  const artifacts = [
    JSON.stringify({ kind: "reset-challenge", challenge }),
    JSON.stringify({ kind: "reset-fence", fence }),
    JSON.stringify({ kind: "reset-completion", completion }),
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
      throw new Error("karaoke_reset_origin_marker_unproven");
    const nonReuse = await input.readers.verifyNonReuse(snapshot, "after-reset");
    if (
      !nonReuse.keyNotReused ||
      reconciliationMillis(nonReuse.observedAt) < started ||
      reconciliationMillis(nonReuse.observedAt) > reconciliationMillis(now())
    )
      throw new Error("karaoke_reset_origin_nonreuse_unproven");
    artifacts.push(JSON.stringify({ kind: "reset-inspection", snapshot, nonReuse }));
  }
  if (reconciliationMillis(now()) < started || reconciliationMillis(now()) - started > 60_000)
    throw new Error("karaoke_reset_origin_expired");
  const appended = appendKaraokeMaintenanceEvent({
    trust: input.journal,
    privateKeyPem: input.privateKeyPem,
    observedAt: now(),
    expectedCurrentHead: journal.head,
    event: { kind: "reset-verified", evidenceIds: artifacts.map(reconciliationDigest) },
    artifacts,
  });
  return { head: appended.head, executionAuthorized: false as const };
}
