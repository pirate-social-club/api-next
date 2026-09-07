import {
  ActionsEvidence,
  ArchiveEvidence,
  AuthorityEvidence,
  FenceEvidence,
  HeadEvidence,
  HistoryEvidence,
  type KaraokeReconciliationEvidencePort,
  makeReconciliationReader,
  ReconciliationManifest,
  type ReconciliationScope,
  ReleaseEvidence,
  UploadListEvidence,
  verifyResidualDisposition,
} from "./karaoke-reconciliation-evidence.ts";
import {
  decodeReconciliation,
  parseKaraokeReconciliationReceipt,
  type ReconciliationReceipt,
  ReconciliationReceiptSchema,
  reconciliationMillis,
} from "./karaoke-reconciliation-schema.ts";
import {
  KARAOKE_RESET_OBJECT_IDS,
  KaraokeResetReceiptSchema,
} from "./karaoke-reset-installation.ts";

const DAY_MS = 86_400_000;
type Reader = ReturnType<typeof makeReconciliationReader>;
type Outcome = ReconciliationReceipt["outcome"];
const requireEvidence = (valid: boolean): void => {
  if (!valid) throw new Error("karaoke_reconciliation_inconsistent_evidence");
};
const clean = (outcome: Outcome) =>
  outcome === "observed-empty" || outcome === "verified-no-authority";
const complete = (outcome: Outcome) => outcome !== "incomplete";

function matchingUploads(list: typeof UploadListEvidence.Type, key: string, bucket: string) {
  requireEvidence(list.key === key);
  let marker: (typeof list.pages)[number]["marker"] = null;
  const visited = new Set<string>();
  const ids = new Set<string>();
  let exhausted = true;
  for (const [index, page] of list.pages.entries()) {
    requireEvidence(page.prefix === key && page.response.bucket === bucket);
    const serialized = JSON.stringify(page.marker);
    if (
      serialized !== JSON.stringify(marker) ||
      visited.has(serialized) ||
      !page.succeeded ||
      page.response.status !== 200
    )
      exhausted = false;
    visited.add(serialized);
    for (const upload of page.uploads) {
      requireEvidence(upload.key.startsWith(key));
      if (upload.key !== key) continue;
      if (ids.has(upload.uploadId)) exhausted = false;
      ids.add(upload.uploadId);
    }
    marker = page.nextMarker;
    if (marker === null && index !== list.pages.length - 1) exhausted = false;
  }
  return { ids, exhausted: exhausted && marker === null };
}

async function verifyObservation(
  read: Reader,
  scope: ReconciliationScope,
  receipt: ReconciliationReceipt,
): Promise<Outcome> {
  const mapping = receipt.mapping;
  const authority = await read(mapping.authorityEvidenceId, scope, AuthorityEvidence);
  const archive = await read(mapping.archiveEvidenceId, scope, ArchiveEvidence);
  const actions = await read(receipt.actionsEvidenceId, scope, ActionsEvidence);
  if (mapping.kind === "no-authority-no-archive") {
    const history = await read(mapping.historyEvidenceId, scope, HistoryEvidence);
    requireEvidence(receipt.observations === null && actions.length === 0);
    return authority === null &&
      archive === null &&
      history.storageNeverDeleted &&
      history.namespaceUnchanged
      ? "verified-no-authority"
      : "incomplete";
  }
  requireEvidence(
    authority !== null &&
      authority.accountId === mapping.accountId &&
      authority.attemptId === mapping.attemptId,
  );
  requireEvidence(!/[/\\\p{Cc}]/u.test(mapping.accountId + mapping.attemptId));
  requireEvidence(mapping.key === `karaoke/${mapping.accountId}/${mapping.attemptId}.pcm`);
  requireEvidence(archive === null || archive.key === mapping.key);
  const observation = receipt.observations;
  if (observation === null) throw new Error("karaoke_reconciliation_missing_observations");
  const before = matchingUploads(
    await read(observation.beforeUploadsId, scope, UploadListEvidence),
    mapping.key,
    scope.target.bucket,
  );
  const after = matchingUploads(
    await read(observation.afterUploadsId, scope, UploadListEvidence),
    mapping.key,
    scope.target.bucket,
  );
  const beforeHead = await read(observation.beforeHeadId, scope, HeadEvidence);
  const afterHead = await read(observation.afterHeadId, scope, HeadEvidence);
  requireEvidence(beforeHead.key === mapping.key && afterHead.key === mapping.key);
  requireEvidence(
    beforeHead.response.bucket === scope.target.bucket &&
      afterHead.response.bucket === scope.target.bucket,
  );
  const headStatusValid = (head: typeof HeadEvidence.Type) =>
    head.state === "present"
      ? head.response.status === 200
      : head.state === "absent"
        ? head.response.status === 404
        : false;
  requireEvidence(
    before.ids.size === observation.beforeUploadCount &&
      after.ids.size === observation.afterUploadCount,
  );
  requireEvidence(
    beforeHead.state === observation.beforeHead && afterHead.state === observation.afterHead,
  );
  const aborted = new Set<string>();
  let deleted = false;
  let succeeded = true;
  for (const action of actions) {
    requireEvidence(action.key === mapping.key);
    requireEvidence(action.response.bucket === scope.target.bucket);
    succeeded = succeeded && action.outcome !== "failed";
    succeeded =
      succeeded &&
      (action.outcome === "not-found"
        ? action.response.status === 404
        : action.response.status >= 200 && action.response.status < 300);
    if (action.kind === "abort") {
      requireEvidence(action.uploadId !== null && before.ids.has(action.uploadId));
      if (action.uploadId !== null) aborted.add(action.uploadId);
    } else {
      requireEvidence(action.uploadId === null && beforeHead.state === "present");
      deleted = true;
    }
  }
  if (
    !before.exhausted ||
    !after.exhausted ||
    !succeeded ||
    !beforeHead.bucketVerified ||
    !headStatusValid(beforeHead) ||
    !headStatusValid(afterHead) ||
    !afterHead.bucketVerified ||
    beforeHead.state === "failed" ||
    afterHead.state !== "absent" ||
    after.ids.size !== 0 ||
    aborted.size !== before.ids.size ||
    (beforeHead.state === "present" && !deleted)
  )
    return "incomplete";
  return before.ids.size === 0 && beforeHead.state === "absent"
    ? "observed-empty"
    : "cleaned-to-empty";
}

type Pass = {
  id: string;
  receipt: ReconciliationReceipt;
  start: number;
  end: number;
  quiescenceEstablished: boolean;
};

async function verifyPass(
  id: string,
  read: Reader,
  manifest: typeof ReconciliationManifest.Type,
  objectId: string,
  now: number,
): Promise<Pass> {
  const scope = manifest.entries.find((entry) => entry.id === id)?.scope;
  if (scope === undefined) throw new Error("karaoke_reconciliation_untrusted_reference");
  requireEvidence(
    scope.epoch === manifest.epoch &&
      scope.target.objectId === objectId &&
      scope.target.bucket === manifest.bucket,
  );
  const receipt = parseKaraokeReconciliationReceipt(
    await read(id, scope, ReconciliationReceiptSchema),
  );
  requireEvidence(
    JSON.stringify(receipt.target) === JSON.stringify(scope.target) &&
      receipt.phase === scope.phase,
  );
  const start = reconciliationMillis(receipt.startedAt);
  const end = reconciliationMillis(receipt.endedAt);
  requireEvidence(end <= now);
  const installation = await read(receipt.installationReceiptId, scope, KaraokeResetReceiptSchema);
  for (const field of ["namespaceId", "objectId", "generation", "inventoryDigest"] as const) {
    requireEvidence(installation[field] === scope.target[field]);
  }
  const retiredPhase = receipt.phase === "retirement" || receipt.phase === "follow-up";
  requireEvidence(installation.state === (retiredPhase ? "retired" : "active"));
  requireEvidence(
    installation.cancellationSucceeded &&
      installation.current.alarm === null &&
      installation.current.sockets === 0,
  );
  for (const observation of [installation.initial, installation.current]) {
    requireEvidence(
      observation.archiveKey === null ||
        (receipt.mapping.kind === "key" && observation.archiveKey === receipt.mapping.key),
    );
  }
  const fence = await read(receipt.fenceEvidenceId, scope, FenceEvidence);
  requireEvidence(
    fence.ingress &&
      fence.producers &&
      fence.databaseWrites &&
      fence.reconnectDenied &&
      fence.runtimeSessions === 0,
  );
  requireEvidence(
    fence.residualDispositionId === manifest.residualDispositionId &&
      reconciliationMillis(fence.verifiedAt) <= start,
  );
  const released = manifest.releasedAt === null ? null : reconciliationMillis(manifest.releasedAt);
  if (released !== null && start >= released) {
    requireEvidence(retiredPhase && receipt.releaseEvidenceId !== null);
    const release = await read(receipt.releaseEvidenceId ?? "", scope, ReleaseEvidence);
    // Recording time and actual release time are distinct: the release may
    // have executed before its journal entry could be recorded, so the
    // evidence time can precede but never postdate the recorded release.
    requireEvidence(release.allSixRetired && reconciliationMillis(release.releasedAt) <= released);
  } else {
    requireEvidence(receipt.releaseEvidenceId === null && receipt.phase !== "follow-up");
  }
  requireEvidence((await verifyObservation(read, scope, receipt)) === receipt.outcome);
  return { id, receipt, start, end, quiescenceEstablished: installation.quiescenceEstablished };
}

function mappingIdentity(receipt: ReconciliationReceipt): string {
  const mapping = receipt.mapping;
  return mapping.kind === "key"
    ? JSON.stringify([mapping.kind, mapping.accountId, mapping.attemptId, mapping.key])
    : mapping.kind;
}

function verifyChain(passes: readonly Pass[]): boolean {
  let previous: Pass | undefined;
  let baseline: Pass | undefined;
  for (const pass of passes) {
    const receipt = pass.receipt;
    requireEvidence(receipt.precedingReceiptId === (previous?.id ?? null));
    if (previous === undefined) {
      requireEvidence(receipt.phase === "post-fence");
    } else {
      requireEvidence(
        pass.start >= previous.end &&
          mappingIdentity(receipt) === mappingIdentity(previous.receipt),
      );
      const prior = previous.receipt.phase;
      const allowed =
        receipt.phase === prior ||
        (receipt.phase === "pre-reset" &&
          prior === "post-fence" &&
          complete(previous.receipt.outcome)) ||
        (receipt.phase === "retirement" &&
          ((prior === "pre-reset" && complete(previous.receipt.outcome)) ||
            prior === "follow-up")) ||
        (receipt.phase === "follow-up" && prior === "retirement");
      requireEvidence(allowed);
    }
    if (receipt.phase === "retirement") baseline = clean(receipt.outcome) ? pass : undefined;
    if (receipt.phase === "follow-up") {
      requireEvidence(baseline !== undefined && pass.start >= baseline.end + DAY_MS);
      if (!clean(receipt.outcome)) baseline = undefined;
    }
    previous = pass;
  }
  return (
    previous?.receipt.phase === "follow-up" &&
    baseline !== undefined &&
    clean(previous.receipt.outcome)
  );
}

/** Read-only evidence composition. It grants no provider capability, mutates no
 * marker and never changes an instance's quiescenceEstablished fact. */
export async function verifyKaraokeReconciliation(
  port: KaraokeReconciliationEvidencePort,
  nowUtc: string,
) {
  const now = reconciliationMillis(nowUtc);
  const manifest = decodeReconciliation(
    ReconciliationManifest,
    await port.readCurrentAuthenticatedManifest(),
  );
  requireEvidence(
    new Set(manifest.targets.map((target) => target.objectId)).size ===
      KARAOKE_RESET_OBJECT_IDS.length,
  );
  if (manifest.releasedAt !== null)
    requireEvidence(reconciliationMillis(manifest.releasedAt) <= now);
  const read = makeReconciliationReader(port, manifest);
  await verifyResidualDisposition(port, manifest);
  let resetEligible = manifest.currentFenceEpoch === manifest.epoch && manifest.releasedAt === null;
  let stable = manifest.releasedAt !== null;
  const latestPasses = [];
  for (const target of manifest.targets) {
    requireEvidence(target.alarm === null && target.sockets === 0 && target.keyNotReused);
    requireEvidence(new Set(target.receiptIds).size === target.receiptIds.length);
    const passes: Pass[] = [];
    for (const id of target.receiptIds)
      passes.push(await verifyPass(id, read, manifest, target.objectId, now));
    const observedStable = verifyChain(passes);
    const latest = passes[passes.length - 1];
    if (latest === undefined) throw new Error("karaoke_reconciliation_missing_target");
    const retired = latest.receipt.phase === "retirement" || latest.receipt.phase === "follow-up";
    requireEvidence(target.markerState === (retired ? "retired" : "active"));
    resetEligible =
      resetEligible && latest.receipt.phase === "pre-reset" && complete(latest.receipt.outcome);
    stable = stable && observedStable;
    latestPasses.push({
      objectId: target.objectId,
      phase: latest.receipt.phase,
      outcome: latest.receipt.outcome,
      quiescenceEstablished: latest.quiescenceEstablished,
    });
  }
  return {
    resetAdmission: resetEligible ? ("eligible" as const) : ("blocked" as const),
    retentionStatus: stable ? ("observed-stable" as const) : ("pending" as const),
    latestPasses,
  };
}
