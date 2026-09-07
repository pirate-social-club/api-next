import { DateTime } from "effect";

type Phase = "post-fence" | "pre-reset" | "retirement" | "follow-up";
type Options = {
  retention?: boolean;
  negative?: boolean;
  phases?: Phase[];
  installation?: (objectId: string, state: "active" | "retired") => unknown;
  edit?: (
    phase: Phase,
    receipt: Record<string, unknown>,
    add: (data: unknown) => string,
    index: number,
  ) => void;
  evidence?: (phase: Phase, kind: string, data: unknown, index: number) => unknown;
};

/** Private authenticated-store double, never a production provenance adapter. */
export function makeKaraokeReconciliationFixture(
  ids: readonly string[],
  digest: (bytes: string) => string,
  options: Options = {},
) {
  const epoch = "a".repeat(64);
  const dispositionBytes = JSON.stringify({
    version: "staging-karaoke-residual-disposition-v1",
    namespaceId: "d692b9d32ecc4cb4825510bde88cf97a",
    generation: "staging-reset-v1",
    inventoryDigest: "a909a00a14555f0152ce5bc9deb986eef0c4ffb2c50a8a7d6cf25343c26b05db",
    epoch,
    bucket: "staging-audio",
    role: "workspace_owner",
    decision: "accept-staging-audio-residual-retention",
  });
  const disposition = digest(dispositionBytes);
  const base = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-09-06T10:00:00.000Z"));
  const time = (offset: number) => DateTime.formatIso(DateTime.makeUnsafe(base + offset));
  const target = (objectId: string) => ({
    namespaceId: "d692b9d32ecc4cb4825510bde88cf97a",
    objectId,
    generation: "staging-reset-v1",
    inventoryDigest: "a909a00a14555f0152ce5bc9deb986eef0c4ffb2c50a8a7d6cf25343c26b05db",
    bucket: "staging-audio",
  });
  const entries = new Map<
    string,
    { id: string; scope: { target: ReturnType<typeof target>; phase: Phase; epoch: string } }
  >();
  const artifacts = new Map<string, string>();
  artifacts.set(disposition, dispositionBytes);
  const manifest = {
    version: "staging-karaoke-reconciliation-manifest-v1",
    epoch,
    bucket: "staging-audio",
    residualDispositionId: disposition,
    currentFenceEpoch: options.retention ? null : epoch,
    releasedAt: options.retention ? time(3000) : null,
    targets: ids.map((objectId) => ({
      objectId,
      markerState: options.retention ? "retired" : "active",
      alarm: null,
      sockets: 0,
      keyNotReused: true,
      receiptIds: [] as string[],
    })),
    entries: [] as Array<{
      id: string;
      scope: { target: ReturnType<typeof target>; phase: Phase; epoch: string };
    }>,
  };
  const phases: Phase[] =
    options.phases ??
    (options.retention
      ? ["post-fence", "pre-reset", "retirement", "follow-up"]
      : ["post-fence", "pre-reset"]);
  for (const current of manifest.targets) {
    let precedingReceiptId: string | null = null;
    let priorStart = -1000;
    for (const [index, phase] of phases.entries()) {
      const scope = { target: target(current.objectId), phase, epoch };
      const add = (data: unknown) => {
        const bytes = JSON.stringify({ scope, data });
        const id = digest(bytes);
        artifacts.set(id, bytes);
        entries.set(id, { id, scope });
        return id;
      };
      const evidence = (kind: string, data: unknown) =>
        add(options.evidence === undefined ? data : options.evidence(phase, kind, data, index));
      const key = `karaoke/account/${current.objectId}.pcm`;
      const response = (status: number) => ({
        endpointKind: "staging-bucket-s3",
        bucket: "staging-audio",
        requestId: "fixture-provider-request",
        status,
      });
      const authorityEvidenceId = evidence(
        "authority",
        options.negative ? null : { accountId: "account", attemptId: current.objectId },
      );
      const archiveEvidenceId = evidence("archive", null);
      const mapping = options.negative
        ? {
            kind: "no-authority-no-archive",
            authorityEvidenceId,
            archiveEvidenceId,
            historyEvidenceId: evidence("history", {
              storageNeverDeleted: true,
              namespaceUnchanged: true,
            }),
          }
        : {
            kind: "key",
            accountId: "account",
            attemptId: current.objectId,
            key,
            authorityEvidenceId,
            archiveEvidenceId,
          };
      const list = {
        key,
        pages: [
          {
            marker: null,
            nextMarker: null,
            succeeded: true,
            uploads: [],
            prefix: key,
            response: response(200),
          },
        ],
      };
      const head = { key, bucketVerified: true, state: "absent", response: response(404) };
      const observations = options.negative
        ? null
        : {
            beforeUploadsId: evidence("before-list", list),
            afterUploadsId: evidence("after-list", list),
            beforeUploadCount: 0,
            afterUploadCount: 0,
            beforeHeadId: evidence("before-head", head),
            afterHeadId: evidence("after-head", head),
            beforeHead: "absent",
            afterHead: "absent",
          };
      const { bucket: _bucket, ...identity } = scope.target;
      const observation = {
        alarm: null,
        sockets: 0,
        scoreState: null,
        recordingState: null,
        archiveKey: null,
        uploadId: null,
      };
      const state = phase === "retirement" || phase === "follow-up" ? "retired" : "active";
      const installation = options.installation?.(current.objectId, state) ?? {
        ...identity,
        state,
        initial: observation,
        current: observation,
        cancellationSucceeded: true,
        quiescenceEstablished: false,
      };
      const start = phase === "follow-up" ? priorStart + 86400200 : priorStart + 1000;
      priorStart = start;
      const receipt: Record<string, unknown> = {
        version: "staging-karaoke-reconciliation-v1",
        target: scope.target,
        mapping,
        phase,
        startedAt: time(start),
        endedAt: time(start + 100),
        installationReceiptId: evidence("installation", installation),
        fenceEvidenceId: evidence("fence", {
          verifiedAt: time(-1000),
          ingress: true,
          producers: true,
          databaseWrites: true,
          reconnectDenied: true,
          runtimeSessions: 0,
          residualDispositionId: disposition,
        }),
        releaseEvidenceId:
          options.retention && start >= 3000
            ? evidence("release", { releasedAt: manifest.releasedAt, allSixRetired: true })
            : null,
        precedingReceiptId,
        observations,
        actionsEvidenceId: evidence("actions", []),
        outcome: options.negative ? "verified-no-authority" : "observed-empty",
      };
      options.edit?.(phase, receipt, add, index);
      precedingReceiptId = add(receipt);
      current.receiptIds.push(precedingReceiptId);
    }
  }
  manifest.entries = [...entries.values()];
  return {
    manifest,
    artifacts,
    now: time(4 * 86400000),
    time,
    port: {
      async readCurrentAuthenticatedManifest() {
        return manifest;
      },
      async readArtifact(id: string) {
        const value = artifacts.get(id);
        if (value === undefined) throw new Error("fixture_missing_artifact");
        return value;
      },
    },
  };
}
