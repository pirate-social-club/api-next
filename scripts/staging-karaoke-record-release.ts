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
import { openKaraokePrivateArtifacts } from "./karaoke-private-artifacts.ts";
import { openKaraokePrivateWriter } from "./karaoke-private-writer.ts";
import type {
  KaraokeAdapterTrust,
  KaraokeCollectorChallenge,
} from "./karaoke-reconciliation-adapter.ts";
import { verifyKaraokeJournalState } from "./staging-karaoke-journal-manifest.ts";
import type { KaraokeSigningReaders } from "./staging-karaoke-signing-collector.ts";

type ExecutedSidecar = {
  readonly release: typeof ReleaseEvidence.Type;
  readonly intentFence: typeof FenceEvidence.Type;
};

/** Recovery discovery of a durably retained release that the journal never
 * recorded. Distinct retained releases are ambiguous and refuse recovery. */
function findRetainedRelease(
  directory: string,
  trust: KaraokeAdapterTrust,
): ExecutedSidecar | undefined {
  const store = openKaraokePrivateArtifacts(directory);
  try {
    const found: ExecutedSidecar[] = [];
    for (const name of store.names()) {
      const parsed = JSON.parse(store.read(name, 262_144)) as {
        kind?: string;
        epoch?: string;
        bucket?: string;
        release?: unknown;
        intentFence?: unknown;
      };
      if (parsed.kind !== "release-executed") continue;
      if (parsed.epoch !== trust.epoch || parsed.bucket !== trust.bucket) continue;
      found.push({
        release: decodeReconciliation(ReleaseEvidence, parsed.release ?? null),
        intentFence: decodeReconciliation(FenceEvidence, parsed.intentFence ?? null),
      });
    }
    if (new Set(found.map((sidecar) => JSON.stringify(sidecar))).size > 1)
      throw new Error("karaoke_release_origin_recovery_ambiguous");
    return found[0];
  } finally {
    store.close();
  }
}

/** Originates the journal's released entry in three durable stages: intent
 * (last held-fence proof) is retained before the trusted release binding
 * runs; execution evidence is retained immediately after it; recovery
 * readback completes the entry from the retained record when a crash,
 * inspection failure or append failure interrupted the ceremony. The journal
 * entry's time equals the actual release time, preserved across recovery.
 * Recording a release does not perform it, and post-release passes cite
 * historical fence evidence rather than claiming writes stay disabled. */
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
  const lastEntry = journal.entries.at(-1)?.entry.observedAt;
  if (lastEntry === undefined) throw new Error("karaoke_release_origin_release_unproven");
  const retained = findRetainedRelease(input.journal.directory, trust);
  let heldFence: typeof FenceEvidence.Type;
  let release: typeof ReleaseEvidence.Type;
  const sidecar = openKaraokePrivateWriter(input.journal.directory);
  try {
    if (retained === undefined) {
      // Intent: the last held-fence proof is durable before release execution.
      heldFence = decodeReconciliation(
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
      sidecar.putArtifact(
        JSON.stringify({
          kind: "release-intent",
          epoch: trust.epoch,
          bucket: trust.bucket,
          fence: heldFence,
          recordedAt: now(),
        }),
      );
      // Execution: the trusted binding performs or verifies the release and
      // its evidence is retained before any further step can fail.
      release = decodeReconciliation(ReleaseEvidence, await input.verifyFenceRelease());
      if (
        !release.allSixRetired ||
        reconciliationMillis(release.releasedAt) < reconciliationMillis(lastEntry) ||
        reconciliationMillis(release.releasedAt) < reconciliationMillis(heldFence.verifiedAt) ||
        reconciliationMillis(release.releasedAt) > reconciliationMillis(now())
      )
        throw new Error("karaoke_release_origin_release_unproven");
      sidecar.putArtifact(
        JSON.stringify({
          kind: "release-executed",
          epoch: trust.epoch,
          bucket: trust.bucket,
          release,
          intentFence: heldFence,
        }),
      );
    } else {
      // Recovery: the release already executed durably; the fence can no
      // longer be observed held and the binding is not invoked again. The
      // release must postdate the all-retired milestone, not every later
      // entry: a concurrent writer may have signed something after the
      // release while this recording was interrupted.
      const milestone = journal.entries
        .filter(({ entry }) => entry.event.kind === "all-retired")
        .at(-1)?.entry.observedAt;
      heldFence = retained.intentFence;
      release = retained.release;
      if (
        !release.allSixRetired ||
        milestone === undefined ||
        !heldFence.ingress ||
        !heldFence.producers ||
        !heldFence.databaseWrites ||
        !heldFence.reconnectDenied ||
        heldFence.runtimeSessions !== 0 ||
        heldFence.residualDispositionId !== trust.residualDispositionId ||
        reconciliationMillis(release.releasedAt) < reconciliationMillis(milestone) ||
        reconciliationMillis(release.releasedAt) < reconciliationMillis(heldFence.verifiedAt) ||
        reconciliationMillis(release.releasedAt) > reconciliationMillis(now())
      )
        throw new Error("karaoke_release_origin_recovery_unproven");
    }
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
  } finally {
    sidecar.close();
  }
}
