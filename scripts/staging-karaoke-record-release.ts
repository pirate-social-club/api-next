import type { CloudflareAccessJwtFetch } from "../packages/platform-cf/src/cloudflare-access-jwt.ts";
import {
  FenceEvidence,
  ReleaseEvidence,
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

/** Originates the journal's released entry. The trusted release binding
 * supplies the actual fence-release evidence; this command independently
 * reads back all six retired markers and refuses anything unretired. The
 * journal entry's time equals the release evidence time so later passes and
 * the verifier agree on one releasedAt. Recording a release does not perform
 * it, and post-release passes must not claim fresh fence denial. */
export async function recordKaraokeFenceRelease(input: {
  readonly trust: KaraokeAdapterTrust;
  readonly journal: KaraokeJournalTrust;
  readonly privateKeyPem: string;
  readonly assertion: string;
  readonly challenge: KaraokeCollectorChallenge;
  readonly readers: KaraokeSigningReaders;
  readonly verifyFenceRelease: () => Promise<unknown>;
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
    throw new Error("karaoke_release_origin_scope_denied");
  await admitKaraokeResetOperator(trust.operator, input.assertion, input.authenticationFetch);
  const journal = readKaraokeMaintenanceJournal(input.journal, now());
  if (journal.state !== "retired") throw new Error("karaoke_release_origin_state_denied");
  const admission = await verifyKaraokeJournalState({ journal, trust, nowUtc: now() });
  if (
    !admission.result.latestPasses.every(
      (pass) => pass.phase === "retirement" && pass.outcome !== "incomplete",
    )
  )
    throw new Error("karaoke_release_origin_admission_denied");
  // The last maintained-fence proof is observed in this command before the
  // trusted release binding runs; fence evidence can never postdate release.
  const heldFence = decodeReconciliation(
    FenceEvidence,
    (await input.readers.observeMaintainedFence()).fence,
  );
  if (
    !heldFence.ingress ||
    !heldFence.producers ||
    !heldFence.databaseWrites ||
    !heldFence.reconnectDenied ||
    heldFence.runtimeSessions !== 0 ||
    heldFence.residualDispositionId !== trust.residualDispositionId ||
    reconciliationMillis(heldFence.verifiedAt) < started ||
    reconciliationMillis(heldFence.verifiedAt) > reconciliationMillis(now())
  )
    throw new Error("karaoke_release_origin_fence_unproven");
  const lastEntry = journal.entries.at(-1)?.entry.observedAt;
  const release = decodeReconciliation(ReleaseEvidence, await input.verifyFenceRelease());
  if (
    !release.allSixRetired ||
    lastEntry === undefined ||
    reconciliationMillis(release.releasedAt) < reconciliationMillis(lastEntry) ||
    reconciliationMillis(release.releasedAt) < reconciliationMillis(heldFence.verifiedAt) ||
    reconciliationMillis(release.releasedAt) > reconciliationMillis(now())
  )
    throw new Error("karaoke_release_origin_release_unproven");
  const artifacts = [
    JSON.stringify({ kind: "release-challenge", challenge }),
    JSON.stringify({ kind: "release-held-fence", fence: heldFence }),
    JSON.stringify({ kind: "release-evidence", release }),
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
      throw new Error("karaoke_release_origin_marker_unproven");
    artifacts.push(JSON.stringify({ kind: "release-inspection", snapshot }));
  }
  if (reconciliationMillis(now()) < started || reconciliationMillis(now()) - started > 60_000)
    throw new Error("karaoke_release_origin_expired");
  const appended = appendKaraokeMaintenanceEvent({
    trust: input.journal,
    privateKeyPem: input.privateKeyPem,
    // One release time: the journal entry and ReleaseEvidence must agree.
    observedAt: release.releasedAt,
    expectedCurrentHead: journal.head,
    event: { kind: "released", evidenceIds: artifacts.map(reconciliationDigest) },
    artifacts,
  });
  return { head: appended.head, executionAuthorized: false as const };
}
