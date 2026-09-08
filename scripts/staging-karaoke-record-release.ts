import { randomBytes } from "node:crypto";
import { Schema } from "effect";
import type { CloudflareAccessJwtFetch } from "../packages/platform-cf/src/cloudflare-access-jwt.ts";
import {
  FenceEvidence,
  ReleaseEvidence,
  reconciliationDigest,
} from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import {
  decodeReconciliation,
  ReconciliationDigest,
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
  signedBytes,
  verifiedPayload,
} from "./karaoke-maintenance-journal.ts";
import { openKaraokePrivateArtifacts } from "./karaoke-private-artifacts.ts";
import { openKaraokePrivateWriter } from "./karaoke-private-writer.ts";
import type {
  KaraokeAdapterTrust,
  KaraokeCollectorChallenge,
} from "./karaoke-reconciliation-adapter.ts";
import { verifyKaraokeJournalState } from "./staging-karaoke-journal-manifest.ts";
import type { KaraokeSigningReaders } from "./staging-karaoke-signing-collector.ts";

const Head = Schema.Struct({
  entryId: ReconciliationDigest,
  sequence: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 8191 })),
});
export const IntentRecord = Schema.Struct({
  kind: Schema.Literal("release-intent"),
  planDigest: ReconciliationDigest,
  nonce: ReconciliationDigest,
  previousNotExecutedId: Schema.NullOr(ReconciliationDigest),
  epoch: ReconciliationDigest,
  bucket: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  residualDispositionId: ReconciliationDigest,
  expectedHead: Head,
  fence: FenceEvidence,
  recordedAt: ReconciliationTime,
});
const ReleaseReconciliationOutcome = Schema.Union([
  Schema.Struct({
    disposition: Schema.Literal("released"),
    release: Schema.Unknown,
  }),
  Schema.Struct({ disposition: Schema.Literal("not-executed") }),
  Schema.Struct({ disposition: Schema.Literal("unresolved") }),
]);
export const NotExecutedRecord = Schema.Struct({
  kind: Schema.Literal("release-not-executed"),
  epoch: ReconciliationDigest,
  bucket: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  residualDispositionId: ReconciliationDigest,
  expectedHead: Head,
  intentId: ReconciliationDigest,
  recordedAt: ReconciliationTime,
});
const ExecutedRecord = Schema.Struct({
  kind: Schema.Literal("release-executed"),
  epoch: ReconciliationDigest,
  bucket: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  residualDispositionId: ReconciliationDigest,
  expectedHead: Head,
  intentId: ReconciliationDigest,
  release: ReleaseEvidence,
  source: Schema.Literals(["execution", "reconciliation"]),
  recordedAt: ReconciliationTime,
});

/** Recovery evidence must be authenticated, not merely well-formed: every
 * sidecar is signed by the pinned collector key, its bytes must hash to its
 * content-addressed filename, its expected head must exist in this journal's
 * lineage, and an executed record must bind the signed intent it followed.
 * File permissions alone establish nothing. */
function readSignedSidecar(
  store: ReturnType<typeof openKaraokePrivateArtifacts>,
  name: string,
  trust: KaraokeAdapterTrust,
  journalEntryIds: ReadonlySet<string>,
): { kind: string; payload: unknown } | undefined {
  const bytes = store.read(name, 262_144);
  if (reconciliationDigest(bytes) !== name.replace(/\.json$/u, ""))
    throw new Error("karaoke_release_origin_recovery_denied");
  let outer: unknown;
  try {
    outer = JSON.parse(bytes);
  } catch {
    throw new Error("karaoke_release_origin_recovery_denied");
  }
  const claimsReleaseRecord = (candidate: unknown) => {
    if (typeof candidate !== "object" || candidate === null) return false;
    const kind = (candidate as { kind?: unknown }).kind;
    return typeof kind === "string" && kind.startsWith("release-");
  };
  const signed = outer as { payload?: unknown; signature?: unknown };
  // The kind lives inside the signed payload. An unsigned file claiming to be
  // a release record is fabricated and refuses; signed records must carry the
  // pinned key's signature, this ceremony's scope and a predecessor inside
  // this journal, or they refuse as modified or cross-ceremony.
  let payload: unknown;
  if (typeof signed.payload === "string") {
    try {
      payload = JSON.parse(signed.payload);
    } catch {
      payload = undefined;
    }
    if (payload === undefined) throw new Error("karaoke_release_origin_recovery_denied");
    if (!claimsReleaseRecord(payload)) return undefined;
    payload = verifiedPayload(bytes, trust.collectorPublicKeyPem);
  } else {
    if (!claimsReleaseRecord(outer)) return undefined;
    throw new Error("karaoke_release_origin_recovery_denied");
  }
  const record = payload as {
    kind?: string;
    epoch?: string;
    bucket?: string;
    residualDispositionId?: string;
    expectedHead?: typeof Head.Type;
  };
  const kind = record.kind;
  if (kind === undefined || !claimsReleaseRecord(record)) return undefined;
  if (
    record.epoch !== trust.epoch ||
    record.bucket !== trust.bucket ||
    record.residualDispositionId !== trust.residualDispositionId ||
    record.expectedHead?.entryId === undefined ||
    !journalEntryIds.has(record.expectedHead.entryId)
  )
    throw new Error("karaoke_release_origin_recovery_denied");
  return { kind, payload };
}

function scanSignedSidecars(
  directory: string,
  trust: KaraokeAdapterTrust,
  journalEntryIds: ReadonlySet<string>,
  planDigest: string,
): Map<string, { kind: string; payload: unknown }> {
  const store = openKaraokePrivateArtifacts(directory);
  try {
    const found = new Map<string, { kind: string; payload: unknown }>();
    for (const name of store.names()) {
      const sidecar = readSignedSidecar(store, name, trust, journalEntryIds);
      if (
        sidecar !== undefined &&
        !["release-intent", "release-executed", "release-not-executed"].includes(sidecar.kind)
      )
        throw new Error("karaoke_release_origin_recovery_denied");
      if (
        sidecar?.kind === "release-intent" &&
        decodeReconciliation(IntentRecord, sidecar.payload).planDigest !== planDigest
      )
        throw new Error("karaoke_release_plan_changed");
      if (sidecar !== undefined) found.set(name.replace(/\.json$/u, ""), sidecar);
    }
    return found;
  } finally {
    store.close();
  }
}

function findRetainedRelease(
  directory: string,
  trust: KaraokeAdapterTrust,
  journalEntryIds: ReadonlySet<string>,
  planDigest: string,
): { release: typeof ReleaseEvidence.Type; intentFence: typeof FenceEvidence.Type } | undefined {
  const sidecars = scanSignedSidecars(directory, trust, journalEntryIds, planDigest);
  const intents = new Map(
    [...sidecars]
      .filter(([, sidecar]) => sidecar?.kind === "release-intent")
      .map(([id, sidecar]) => [id, decodeReconciliation(IntentRecord, sidecar.payload)] as const),
  );
  const results = [...sidecars]
    .filter(([, sidecar]) => sidecar?.kind === "release-executed")
    .map(([, sidecar]) => {
      const record = decodeReconciliation(ExecutedRecord, sidecar.payload);
      const intent = intents.get(record.intentId);
      if (intent === undefined) throw new Error("karaoke_release_origin_recovery_denied");
      return { release: record.release, intentFence: intent.fence, id: record.intentId };
    });
  if (new Set(results.map((result) => JSON.stringify(result))).size > 1)
    throw new Error("karaoke_release_origin_recovery_ambiguous");
  return results[0];
}

/** Originates the journal's released entry in three durable stages: intent
 * (last held-fence proof) is signed and retained before the trusted release
 * binding runs; execution evidence is signed and retained immediately after
 * it; recovery readback completes the entry from authenticated retained
 * records when a crash, lost response, inspection failure or append failure
 * interrupted the ceremony. Uncertain execution — the release may have
 * completed without its result becoming durable — is reconciled read-only
 * against an intent-bound observation and never by executing again. The
 * journal entry records when the release was recorded; the signed release
 * evidence preserves the actual release time, which may precede it. */
export async function recordKaraokeFenceRelease(input: {
  readonly releasePlanDigest: string;
  readonly trust: KaraokeAdapterTrust;
  readonly journal: KaraokeJournalTrust;
  readonly privateKeyPem: string;
  readonly assertion: string;
  readonly challenge: KaraokeCollectorChallenge;
  readonly readers: KaraokeSigningReaders;
  readonly verifyFenceRelease: (
    intent: typeof IntentRecord.Type & { readonly intentId: string },
  ) => Promise<unknown>;
  readonly reconcileReleasedFence?: (
    pendingIntent: typeof IntentRecord.Type & { readonly intentId: string },
  ) => Promise<unknown>;
  readonly now?: () => string;
  readonly authenticationFetch?: CloudflareAccessJwtFetch;
}) {
  const now = input.now ?? (() => new Date().toISOString());
  const started = reconciliationMillis(now());
  const { trust, challenge } = input;
  const planDigest = decodeReconciliation(ReconciliationDigest, input.releasePlanDigest);
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
  const journalEntryIds = new Set(journal.entries.map(({ id }) => id));
  const retained = findRetainedRelease(input.journal.directory, trust, journalEntryIds, planDigest);
  let heldFence: typeof FenceEvidence.Type | undefined;
  let release: typeof ReleaseEvidence.Type | undefined;
  const sidecar = openKaraokePrivateWriter(input.journal.directory);
  try {
    let previousNotExecutedId: string | null = null;
    const writeIntent = (fence: typeof FenceEvidence.Type) => {
      const intent = decodeReconciliation(IntentRecord, {
        kind: "release-intent",
        planDigest,
        nonce: randomBytes(32).toString("hex"),
        previousNotExecutedId,
        epoch: trust.epoch,
        bucket: trust.bucket,
        residualDispositionId: trust.residualDispositionId,
        expectedHead: {
          entryId: journal.head.entryId,
          sequence: journal.head.sequence,
        },
        fence,
        recordedAt: now(),
      });
      const intentId = sidecar.putArtifact(signedBytes(intent, input.privateKeyPem));
      return { ...intent, intentId };
    };
    if (retained !== undefined) {
      // Authenticated recovery: the executed record and its signed intent
      // exist; the fence can no longer be observed held and the binding is
      // not invoked again. The release must postdate the all-retired
      // milestone — not every later entry, which a concurrent writer may
      // have signed after the actual release.
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
    } else {
      // Recovery selection precedes any fence observation: the concrete
      // collectors throw when fencing is absent, and an observation error is
      // never proof of release. A pending signed intent is the only
      // uncertain-execution trigger, and it is passed to the read-only
      // reconciliation port explicitly.
      const sidecars = scanSignedSidecars(
        input.journal.directory,
        trust,
        journalEntryIds,
        planDigest,
      );
      // Intents with a durable authenticated not-executed disposition are
      // resolved and no longer pending.
      const resolvedIntents = new Set(
        [...sidecars]
          .filter(([, sidecar]) => sidecar?.kind === "release-not-executed")
          .map(([, sidecar]) => decodeReconciliation(NotExecutedRecord, sidecar.payload).intentId),
      );
      previousNotExecutedId =
        [...sidecars]
          .filter(([, sidecar]) => sidecar.kind === "release-not-executed")
          .map(([id, sidecar]) => ({
            id,
            record: decodeReconciliation(NotExecutedRecord, sidecar.payload),
          }))
          .sort(
            (left, right) =>
              reconciliationMillis(left.record.recordedAt) -
              reconciliationMillis(right.record.recordedAt),
          )
          .at(-1)?.id ?? null;
      const pending = [...sidecars]
        .filter(([id, sidecar]) => sidecar?.kind === "release-intent" && !resolvedIntents.has(id))
        .map(([id, sidecar]) => ({
          id,
          record: decodeReconciliation(IntentRecord, sidecar.payload),
        }))
        .sort(
          (left, right) =>
            reconciliationMillis(left.record.recordedAt) -
            reconciliationMillis(right.record.recordedAt),
        );
      const validIntent = (intent: typeof IntentRecord.Type | undefined) =>
        intent?.fence.ingress !== undefined &&
        intent.fence.ingress &&
        intent.fence.producers &&
        intent.fence.databaseWrites &&
        intent.fence.reconnectDenied &&
        intent.fence.runtimeSessions === 0 &&
        intent.fence.residualDispositionId === trust.residualDispositionId;
      let reconcileDisposition: "released" | "not-executed" | "fresh";
      const intent = pending.at(-1)?.record;
      const intentId = pending.at(-1)?.id;
      if (intent !== undefined && !validIntent(intent)) {
        // Current fencing cannot resolve an invalid retained intent.
        throw new Error("karaoke_release_origin_unresolved");
      } else if (intent === undefined) {
        reconcileDisposition = "fresh";
      } else if (input.reconcileReleasedFence === undefined) {
        // Item: reject a pending intent without a reconciliation binding
        // before any fence reader can throw.
        throw new Error("karaoke_release_origin_uncertain_denied");
      } else {
        // Only the observation call and its evidence decode may resolve to
        // unresolved; signing and persistence stay outside any fallback.
        let observed: unknown;
        try {
          if (intentId === undefined) throw new Error("karaoke_release_origin_unresolved");
          observed = await input.reconcileReleasedFence({ ...intent, intentId });
        } catch {
          observed = { disposition: "unresolved" };
        }
        const outcome = decodeReconciliation(ReleaseReconciliationOutcome, observed);
        if (outcome.disposition === "released") {
          release = decodeReconciliation(ReleaseEvidence, outcome.release);
          heldFence = intent.fence;
          const milestone = journal.entries
            .filter(({ entry }) => entry.event.kind === "all-retired")
            .at(-1)?.entry.observedAt;
          if (
            !release.allSixRetired ||
            milestone === undefined ||
            reconciliationMillis(release.releasedAt) < reconciliationMillis(milestone) ||
            reconciliationMillis(release.releasedAt) <
              reconciliationMillis(intent.fence.verifiedAt) ||
            reconciliationMillis(release.releasedAt) > reconciliationMillis(now())
          )
            throw new Error("karaoke_release_origin_recovery_unproven");
          reconcileDisposition = "released";
        } else if (outcome.disposition === "not-executed") {
          reconcileDisposition = "not-executed";
        } else {
          throw new Error("karaoke_release_origin_unresolved");
        }
      }
      if (reconcileDisposition === "released") {
        if (intentId === undefined) throw new Error("karaoke_release_origin_unresolved");
        // Persistence failures here never fall back to execution.
        sidecar.putArtifact(
          signedBytes(
            {
              kind: "release-executed",
              epoch: trust.epoch,
              bucket: trust.bucket,
              residualDispositionId: trust.residualDispositionId,
              expectedHead: {
                entryId: journal.head.entryId,
                sequence: journal.head.sequence,
              },
              intentId,
              release,
              source: "reconciliation",
              recordedAt: now(),
            },
            input.privateKeyPem,
          ),
        );
      } else if (reconcileDisposition === "fresh" || reconcileDisposition === "not-executed") {
        if (reconcileDisposition === "not-executed") {
          if (intentId === undefined) throw new Error("karaoke_release_origin_unresolved");
          // A durable, authenticated not-executed disposition is the only
          // path from a pending intent back to fresh execution; a held fence
          // alone never is.
          previousNotExecutedId = sidecar.putArtifact(
            signedBytes(
              {
                kind: "release-not-executed",
                epoch: trust.epoch,
                bucket: trust.bucket,
                residualDispositionId: trust.residualDispositionId,
                expectedHead: {
                  entryId: journal.head.entryId,
                  sequence: journal.head.sequence,
                },
                intentId,
                recordedAt: now(),
              },
              input.privateKeyPem,
            ),
          );
        }
        const observed = decodeReconciliation(
          FenceEvidence,
          (await input.readers.observeMaintainedFence()).fence,
        );
        if (
          reconciliationMillis(observed.verifiedAt) < started ||
          reconciliationMillis(observed.verifiedAt) > reconciliationMillis(now()) ||
          !observed.ingress ||
          !observed.producers ||
          !observed.databaseWrites ||
          !observed.reconnectDenied ||
          observed.runtimeSessions !== 0 ||
          observed.residualDispositionId !== trust.residualDispositionId
        )
          throw new Error("karaoke_release_origin_fence_unproven");
        heldFence = observed;
        const freshIntent = writeIntent(heldFence);
        release = decodeReconciliation(
          ReleaseEvidence,
          await input.verifyFenceRelease(freshIntent),
        );
        if (
          !release.allSixRetired ||
          reconciliationMillis(release.releasedAt) < reconciliationMillis(lastEntry) ||
          reconciliationMillis(release.releasedAt) < reconciliationMillis(heldFence.verifiedAt) ||
          reconciliationMillis(release.releasedAt) > reconciliationMillis(now())
        )
          throw new Error("karaoke_release_origin_release_unproven");
        sidecar.putArtifact(
          signedBytes(
            {
              kind: "release-executed",
              epoch: trust.epoch,
              bucket: trust.bucket,
              residualDispositionId: trust.residualDispositionId,
              expectedHead: {
                entryId: journal.head.entryId,
                sequence: journal.head.sequence,
              },
              intentId: freshIntent.intentId,
              release,
              source: "execution",
              recordedAt: now(),
            },
            input.privateKeyPem,
          ),
        );
      } else {
        throw new Error("karaoke_release_origin_unresolved");
      }
    }
    if (heldFence === undefined || release === undefined)
      throw new Error("karaoke_release_origin_unresolved");
    const artifacts = [
      JSON.stringify({ kind: "release-challenge", challenge }),
      JSON.stringify({ kind: "release-plan", planDigest }),
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
      // Recording time keeps journal monotonicity; the actual release time is
      // preserved inside the signed release evidence and may precede it.
      observedAt: now(),
      expectedCurrentHead: journal.head,
      event: { kind: "released", evidenceIds: artifacts.map(reconciliationDigest) },
      artifacts,
    });
    return { head: appended.head, executionAuthorized: false as const };
  } finally {
    sidecar.close();
  }
}
