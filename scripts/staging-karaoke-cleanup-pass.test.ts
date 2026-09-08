import { afterEach, expect, test as unit } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconciliationDigest } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import { KARAOKE_RESET_OBJECT_IDS } from "../packages/platform-cf/src/karaoke-reset-installation.ts";
import { makeKaraokeCollectorFixture } from "../packages/testing/src/karaoke-collector-fixture.ts";
import {
  appendKaraokeMaintenanceEvent,
  type KaraokeJournalTrust,
  readKaraokeMaintenanceJournal,
  signedBytes,
  verifiedPayload,
} from "./karaoke-maintenance-journal.ts";
import { openKaraokePrivateArtifacts } from "./karaoke-private-artifacts.ts";
import { openKaraokePrivateWriter } from "./karaoke-private-writer.ts";
import { recordKaraokeCleanupPass } from "./staging-karaoke-cleanup-pass.ts";
import { karaokeJournalIntegrationTest as test } from "./staging-karaoke-journal-test.ts";
import { recordKaraokeObservationPass } from "./staging-karaoke-observation-pass.ts";
import { makeStagingKaraokeR2Cleaner } from "./staging-karaoke-r2-cleaner.ts";
import {
  makeStagingKaraokeR2Observer,
  STAGING_KARAOKE_BUCKET,
} from "./staging-karaoke-r2-observer.ts";
import { verifyRecordedKaraokePass } from "./staging-karaoke-record-pass-cli.ts";
import type { KaraokeSigningReaders } from "./staging-karaoke-signing-collector.ts";

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});
function fixture() {
  const f = makeKaraokeCollectorFixture(KARAOKE_RESET_OBJECT_IDS, reconciliationDigest);
  const directory = mkdtempSync(join(tmpdir(), "karaoke-cleanup-pass-test-"));
  disposals.push(f.dispose, () => rmSync(directory, { recursive: true, force: true }));
  const oldDisposition = f.evidence.artifacts.get(f.trust.residualDispositionId);
  if (!oldDisposition) throw new Error("missing fixture");
  const residual = JSON.stringify({
    ...JSON.parse(oldDisposition),
    bucket: STAGING_KARAOKE_BUCKET,
  });
  const trust = {
    ...f.trust,
    bucket: STAGING_KARAOKE_BUCKET,
    residualDispositionId: reconciliationDigest(residual),
    expectedHistory: Object.fromEntries(KARAOKE_RESET_OBJECT_IDS.map((id) => [id, [] as string[]])),
  };
  const privateKeyPem = f.signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const journal: KaraokeJournalTrust = {
    directory,
    publicKeyPem: trust.collectorPublicKeyPem,
    epoch: trust.epoch,
    collectorSourceDigest: trust.collectorSourceDigest,
    expectedHead: null,
  };
  let time = Date.now();
  const now = () => new Date(++time).toISOString();
  const append = (kind: "begin" | "fence-observed" | "fence-broken") =>
    appendKaraokeMaintenanceEvent({
      trust: journal,
      privateKeyPem,
      observedAt: now(),
      event: { kind, evidenceIds: [trust.residualDispositionId] },
      artifacts: [residual],
    });
  append("begin");
  const held = append("fence-observed");
  const reads = { fence: 0, inspection: 0, sql: 0, r2: 0, delete: 0 };
  const readers: KaraokeSigningReaders = {
    inspect: async (target) => {
      reads.inspection++;
      const observation = {
        alarm: null,
        sockets: 0,
        scoreState: null,
        recordingState: null,
        archiveKey: null,
        uploadId: null,
      };
      return {
        version: "staging-karaoke-reset-inspection-v1",
        ...target,
        observedAt: now(),
        markerState: "active",
        initial: observation,
        current: observation,
        authority: { accountId: "fixture-account", attemptId: target.objectId },
        installationReceipt: {
          ...target,
          state: "active",
          initial: observation,
          current: observation,
          cancellationSucceeded: true,
          quiescenceEstablished: false,
        },
      };
    },
    verifyNonReuse: async (_snapshot, phase) => {
      reads.sql++;
      expect(phase).toBe("before-reset");
      return { keyNotReused: true, observedAt: now() };
    },
    observeMaintainedFence: async () => {
      reads.fence++;
      return {
        supporting: { fixture: true },
        fence: {
          verifiedAt: now(),
          ingress: true,
          producers: true,
          databaseWrites: true,
          reconnectDenied: true,
          runtimeSessions: 0,
          residualDispositionId: trust.residualDispositionId,
        },
      };
    },
  };
  const state = {
    present: false,
    multipart: false,
    concurrent: false,
    failAbort: false,
    gone: false,
    loseAbortResponse: false,
    deletes: [] as string[],
  };
  // Per-key provider state; the booleans seed every untouched exact key so a
  // cleanup of one object never mutates another object's remnants.
  const bucketState = new Map<string, { present: boolean; multipart: boolean }>();
  const forKey = (key: string) => {
    let entry = bucketState.get(key);
    if (entry === undefined) {
      entry = { present: state.present, multipart: state.multipart };
      bucketState.set(key, entry);
    }
    return entry;
  };
  const transport = async (input: string, init: RequestInit) => {
    expect(["GET", "HEAD", "DELETE"]).toContain(init.method ?? "");
    reads.r2++;
    if (init.method === "DELETE") reads.delete++;
    if (state.concurrent) {
      state.concurrent = false;
      append("fence-observed");
    }
    const url = new URL(String(input));
    const prefix = url.searchParams.get("prefix");
    const headers = { "x-amz-request-id": `fixture-${reads.r2}` };
    if (prefix !== null) {
      const exact = forKey(prefix).multipart
        ? `<Upload><Key>${prefix}</Key><UploadId>fixture-upload</UploadId></Upload>`
        : "";
      return new Response(
        `<ListMultipartUploadsResult><Bucket>${STAGING_KARAOKE_BUCKET}</Bucket><Prefix>${prefix}</Prefix><IsTruncated>false</IsTruncated>${exact}<Upload><Key>${prefix}.neighbor</Key><UploadId>neighbor</UploadId></Upload></ListMultipartUploadsResult>`,
        { headers },
      );
    }
    const key = url.pathname.slice(`/${STAGING_KARAOKE_BUCKET}/`.length);
    if (init.method === "DELETE") {
      const uploadId = url.searchParams.get("uploadId");
      expect(url.pathname).toMatch(
        /^\/pirate-learner-audio-staging\/karaoke\/fixture-account\/[^/]+\.pcm$/u,
      );
      state.deletes.push(`${url.pathname}${uploadId === null ? "" : `?uploadId=${uploadId}`}`);
      if (uploadId === null) {
        const entry = forKey(key);
        if (!entry.present) return new Response(null, { status: 404, headers });
        entry.present = false;
        return new Response(null, { status: 204, headers });
      }
      if (uploadId === "fixture-upload" && state.failAbort)
        return new Response(null, { status: 503, headers });
      if (uploadId === "fixture-upload") {
        forKey(key).multipart = false;
        if (state.loseAbortResponse) {
          state.loseAbortResponse = false;
          throw new Error("fixture response lost after abort");
        }
        return new Response(null, { status: state.gone ? 404 : 204, headers });
      }
      expect(uploadId).not.toBe("neighbor");
      return new Response(null, { status: 204, headers });
    }
    return new Response(null, {
      status: url.pathname === `/${STAGING_KARAOKE_BUCKET}` || forKey(key).present ? 200 : 404,
      headers,
    });
  };
  const credentials = { accessKeyId: "fixture", secretAccessKey: "fixture" };
  const input = {
    trust,
    journal: { ...journal, expectedHead: held.head },
    privateKeyPem,
    assertion: f.assertion(),
    challenge: {
      version: "staging-karaoke-collector-challenge-v1" as const,
      challenge: "c".repeat(64),
      operatorSubjectDigest: reconciliationDigest(trust.operator.KARAOKE_RESET_ACCESS_SUBJECT),
      epoch: trust.epoch,
      bucket: trust.bucket,
    },
    readers,
    r2: makeStagingKaraokeR2Observer({
      accountId: "a".repeat(32),
      credentials,
      fetch: transport,
    }),
    cleaner: makeStagingKaraokeR2Cleaner({
      accountId: "a".repeat(32),
      credentials,
      fetch: transport,
    }),
    now,
    authenticationFetch: f.authenticationFetch,
  };
  return { input, reads, state, now, journal, held, append, transport, credentials };
}

test("exact-key remnants are aborted and deleted with receipts; neighbors survive and pre-reset becomes eligible", async () => {
  const { input, reads, state, journal, now, held } = fixture();
  state.present = true;
  state.multipart = true;
  const started = Date.parse(now());
  const cleaned = await recordKaraokeCleanupPass(input);
  expect(cleaned.executionAuthorized).toBe(false);
  expect(cleaned.resetAdmission).toBe("blocked");
  expect(
    cleaned.latestPasses.every(
      (pass) => pass.outcome === "cleaned-to-empty" && !pass.quiescenceEstablished,
    ),
  ).toBe(true);
  expect(state.deletes.length).toBe(12);
  expect(
    state.deletes.every((entry) => !entry.includes("neighbor") && !entry.includes(".pcm.")),
  ).toBe(true);
  const retained = readKaraokeMaintenanceJournal({ ...journal, expectedHead: cleaned.head }, now());
  expect(retained.head.sequence).toBe(7);
  const proof = await verifyRecordedKaraokePass({
    config: input.trust,
    journalTrust: input.journal,
    priorHead: held.head,
    challenge: input.challenge,
    phase: "post-fence",
    started,
    nowUtc: now(),
  });
  expect(proof.journalHead).toEqual(cleaned.head);
  expect(proof.executionAuthorized).toBe(false);
  const observed = await recordKaraokeObservationPass({ ...input, phase: "pre-reset" });
  expect(observed.resetAdmission).toBe("eligible");
  expect(observed.latestPasses.every((pass) => pass.outcome === "observed-empty")).toBe(true);
  expect(reads.delete).toBe(12);
});

test("uploads already gone at abort time record not-found actions and still complete", async () => {
  const { input, state, journal, now } = fixture();
  state.multipart = true;
  state.gone = true;
  const cleaned = await recordKaraokeCleanupPass(input);
  expect(cleaned.latestPasses.every((pass) => pass.outcome === "cleaned-to-empty")).toBe(true);
  const firstPass = readKaraokeMaintenanceJournal(journal, now());
  const receiptId = firstPass.history[KARAOKE_RESET_OBJECT_IDS[0]]?.at(-1);
  if (!receiptId) throw new Error("missing receipt");
  const receipt = (JSON.parse(firstPass.readArtifact(receiptId)) as { data: unknown }).data as {
    actionsEvidenceId: string;
  };
  const actions = JSON.parse(firstPass.readArtifact(receipt.actionsEvidenceId)) as {
    data: { outcome: string; response: { status: number } }[];
  };
  expect(actions.data[0]?.outcome).toBe("not-found");
  expect(actions.data[0]?.response.status).toBe(404);
});

unit(
  "cleaner refuses mismatched observations and never issues actions for neighbors or absent heads",
  async () => {
    const { transport, credentials } = fixture();
    const cleaner = makeStagingKaraokeR2Cleaner({
      accountId: "a".repeat(32),
      credentials,
      fetch: transport,
    });
    const authority = { accountId: "fixture-account", attemptId: "fixture-object" };
    const observation = (key: string) => ({
      uploads: {
        key,
        pages: [
          {
            marker: null,
            nextMarker: null,
            succeeded: true,
            response: {
              endpointKind: "staging-bucket-s3" as const,
              bucket: STAGING_KARAOKE_BUCKET,
              requestId: "fixture",
              status: 200,
            },
            prefix: key,
            uploads: [{ key: `${key}.neighbor`, uploadId: "neighbor" }],
          },
        ],
      },
      head: {
        key,
        bucketVerified: true,
        response: {
          endpointKind: "staging-bucket-s3" as const,
          bucket: STAGING_KARAOKE_BUCKET,
          requestId: "fixture",
          status: 404,
        },
        state: "absent" as const,
      },
    });
    await expect(
      cleaner.clean(authority, observation("karaoke/fixture-account/other.pcm")),
    ).rejects.toThrow("karaoke_r2_cleaner_observation_denied");
    const actions = await cleaner.clean(
      authority,
      observation(`karaoke/${authority.accountId}/${authority.attemptId}.pcm`),
    );
    expect(actions).toEqual([]);
  },
);

test("wrong operator or absent authority refuses before any bucket action", async () => {
  for (const failure of ["auth", "authority"] as const) {
    const { input, reads, state, journal, now, held } = fixture();
    state.present = true;
    state.multipart = true;
    if (failure === "auth") input.assertion = "invalid";
    else {
      const inspect = input.readers.inspect;
      input.readers.inspect = async (target) => ({
        ...((await inspect(target)) as object),
        authority: null,
      });
    }
    await expect(recordKaraokeCleanupPass(input)).rejects.toThrow();
    expect(reads.r2).toBe(0);
    expect(state.deletes).toEqual([]);
    expect(readKaraokeMaintenanceJournal(journal, now()).head).toEqual(held.head);
  }
});

test("cleanup after pre-reset admission performs zero provider writes", async () => {
  const { input, reads, state, journal, now } = fixture();
  await recordKaraokeObservationPass({ ...input, phase: "post-fence" });
  await recordKaraokeObservationPass({ ...input, phase: "pre-reset" });
  const r2Before = reads.r2;
  const prior = readKaraokeMaintenanceJournal(journal, now());
  await expect(recordKaraokeCleanupPass(input)).rejects.toThrow("karaoke_cleanup_phase_denied");
  expect(reads.r2).toBe(r2Before);
  expect(state.deletes).toEqual([]);
  expect(readKaraokeMaintenanceJournal(journal, now()).head).toEqual(prior.head);
});

test("interrupted cleanup retains durable intent and action sidecars", async () => {
  const { input, state, journal } = fixture();
  state.present = true;
  state.multipart = true;
  const observe = input.readers.observeMaintainedFence;
  let seen = 0;
  input.readers.observeMaintainedFence = async () => {
    if (++seen === 2) throw new Error("fixture lost fence");
    return observe();
  };
  await expect(recordKaraokeCleanupPass(input)).rejects.toThrow("fixture lost fence");
  const store = openKaraokePrivateArtifacts(journal.directory);
  try {
    const kinds = new Set<string>();
    for (const name of store.names()) {
      const raw = JSON.parse(store.read(name, 262_144));
      const parsed = (
        typeof raw.payload === "string"
          ? verifiedPayload(store.read(name, 262_144), input.trust.collectorPublicKeyPem)
          : raw
      ) as {
        kind?: string;
        attempt?: { outcome?: string };
      };
      if (parsed.kind !== undefined) kinds.add(parsed.kind);
      if (parsed.kind === "cleanup-action") kinds.add(`cleanup-action:${parsed.attempt?.outcome}`);
    }
    expect(kinds.has("cleanup-intent")).toBe(true);
    expect(kinds.has("cleanup-action:succeeded")).toBe(true);
  } finally {
    store.close();
  }
  const recovered = await recordKaraokeCleanupPass(input);
  expect(recovered.latestPasses.every((pass) => pass.outcome === "observed-empty")).toBe(true);
  const observed = await recordKaraokeObservationPass({ ...input, phase: "pre-reset" });
  expect(observed.resetAdmission).toBe("eligible");
  const retained = readKaraokeMaintenanceJournal(journal, input.now());
  const last = retained.entries.at(-1)?.entry;
  if (!last) throw new Error("missing pass");
  const history = last.event.evidenceIds
    .map((id) => JSON.parse(retained.readArtifact(id)))
    .filter((value) => value.data?.kind === "retained-cleanup-history");
  expect(history.length).toBeGreaterThanOrEqual(3);
  expect(
    history.some((value) => {
      expect(reconciliationDigest(value.data.signed)).toBe(value.data.artifactId);
      const payload = verifiedPayload(value.data.signed, input.trust.collectorPublicKeyPem) as {
        kind: string;
      };
      return payload.kind === "cleanup-action";
    }),
  ).toBe(true);
});

test("unsigned cleanup history refuses before any provider write", async () => {
  const { input, reads, state } = fixture();
  state.present = true;
  const writer = openKaraokePrivateWriter(input.journal.directory);
  try {
    writer.putArtifact(JSON.stringify({ kind: "cleanup-intent" }));
  } finally {
    writer.close();
  }
  await expect(recordKaraokeCleanupPass(input)).rejects.toThrow();
  expect(reads.delete).toBe(0);
  expect(reads.fence).toBe(0);
});

test("changing a retained sidecar kind cannot hide its digest mismatch", async () => {
  const { input, reads } = fixture();
  const writer = openKaraokePrivateWriter(input.journal.directory);
  let id: string;
  try {
    id = writer.putArtifact(JSON.stringify({ kind: "cleanup-intent" }));
  } finally {
    writer.close();
  }
  writeFileSync(join(input.journal.directory, `${id}.json`), JSON.stringify({ kind: "unrelated" }));
  await expect(recordKaraokeCleanupPass(input)).rejects.toThrow(
    "karaoke_cleanup_history_digest_denied",
  );
  expect(reads.delete).toBe(0);
  expect(reads.fence).toBe(0);
});

test("lost abort response remains uncertain in signed recovery history", async () => {
  const { input, state, journal, now } = fixture();
  state.multipart = true;
  state.loseAbortResponse = true;
  await expect(recordKaraokeCleanupPass(input)).rejects.toThrow("karaoke_r2_cleaner_failed");
  await recordKaraokeObservationPass({ ...input, phase: "post-fence" });
  const retained = readKaraokeMaintenanceJournal(journal, now());
  const pass = retained.entries.find(({ entry }) => entry.event.kind === "pass");
  if (!pass) throw new Error("missing recovery pass");
  const history = pass.entry.event.evidenceIds
    .map((id) => JSON.parse(retained.readArtifact(id)))
    .filter((value) => value.data?.kind === "retained-cleanup-history")
    .map(
      (value) =>
        verifiedPayload(value.data.signed, input.trust.collectorPublicKeyPem) as {
          kind: string;
          attempt?: { outcome: string; response: unknown };
        },
    );
  expect(history.some((value) => value.kind === "cleanup-intent")).toBe(true);
  expect(history.find((value) => value.kind === "cleanup-action")?.attempt).toMatchObject({
    outcome: "uncertain",
    response: null,
  });
});

test("foreign-lineage signed cleanup history refuses even when the bucket is empty", async () => {
  const { input, reads, state } = fixture();
  state.present = true;
  await recordKaraokeCleanupPass(input);
  const store = openKaraokePrivateArtifacts(input.journal.directory);
  let payload: unknown;
  try {
    for (const name of store.names()) {
      const raw = JSON.parse(store.read(name, 262_144));
      if (typeof raw.payload !== "string") continue;
      const value = JSON.parse(raw.payload);
      if (value.kind === "cleanup-intent") {
        payload = { ...value, expectedHead: { entryId: "f".repeat(64), sequence: 1 } };
        break;
      }
    }
  } finally {
    store.close();
  }
  if (!payload) throw new Error("missing intent");
  const writer = openKaraokePrivateWriter(input.journal.directory);
  try {
    writer.putArtifact(signedBytes(payload, input.privateKeyPem));
  } finally {
    writer.close();
  }
  const priorWrites = reads.delete;
  await expect(recordKaraokeCleanupPass(input)).rejects.toThrow(
    "karaoke_cleanup_history_scope_denied",
  );
  await expect(recordKaraokeObservationPass({ ...input, phase: "pre-reset" })).rejects.toThrow(
    "karaoke_cleanup_history_scope_denied",
  );
  expect(reads.delete).toBe(priorWrites);
});

test("lost final fence after successful actions leaves no receipt; a fresh pass recovers from actual state", async () => {
  const { input, state, journal, now, held } = fixture();
  state.present = true;
  state.multipart = true;
  const observe = input.readers.observeMaintainedFence;
  let seen = 0;
  input.readers.observeMaintainedFence = async () => {
    if (++seen === 2) throw new Error("fixture lost fence");
    return observe();
  };
  await expect(recordKaraokeCleanupPass(input)).rejects.toThrow("fixture lost fence");
  expect(state.deletes.length).toBe(12);
  expect(readKaraokeMaintenanceJournal(journal, now()).head).toEqual(held.head);
  const recovered = await recordKaraokeCleanupPass(input);
  expect(recovered.latestPasses.every((pass) => pass.outcome === "observed-empty")).toBe(true);
  const observed = await recordKaraokeObservationPass({ ...input, phase: "pre-reset" });
  expect(observed.resetAdmission).toBe("eligible");
});

test("failed aborts record incomplete receipts that are preserved, then a retry completes cleanup", async () => {
  const { input, state, journal, now } = fixture();
  state.multipart = true;
  state.failAbort = true;
  const failed = await recordKaraokeCleanupPass(input);
  expect(failed.latestPasses.every((pass) => pass.outcome === "incomplete")).toBe(true);
  const firstPass = readKaraokeMaintenanceJournal(journal, now());
  const receiptId = firstPass.history[KARAOKE_RESET_OBJECT_IDS[0]]?.at(-1);
  if (!receiptId) throw new Error("missing receipt");
  const raw: { data: unknown } = JSON.parse(firstPass.readArtifact(receiptId));
  const receipt = raw.data as { actionsEvidenceId: string };
  const actions = JSON.parse(firstPass.readArtifact(receipt.actionsEvidenceId)) as {
    data: { outcome: string; response: { status: number } }[];
  };
  expect(actions.data[0]?.outcome).toBe("failed");
  expect(actions.data[0]?.response.status).toBe(503);
  state.failAbort = false;
  const retried = await recordKaraokeCleanupPass(input);
  expect(retried.latestPasses.every((pass) => pass.outcome === "cleaned-to-empty")).toBe(true);
  expect(
    Object.values(readKaraokeMaintenanceJournal(journal, now()).history).every(
      (history) => history.length === 2,
    ),
  ).toBe(true);
  const observed = await recordKaraokeObservationPass({ ...input, phase: "pre-reset" });
  expect(observed.resetAdmission).toBe("eligible");
});

test("concurrent journal advance or a broken fence refuses cleanup appends without discarding history", async () => {
  const { input, state, journal, now, held, append } = fixture();
  state.concurrent = true;
  state.multipart = true;
  await expect(recordKaraokeCleanupPass(input)).rejects.toThrow("karaoke_journal_head_changed");
  const raced = readKaraokeMaintenanceJournal(journal, now());
  expect(Object.values(raced.history).every((history) => history.length === 0)).toBe(true);
  expect(raced.head.sequence).toBe(held.head.sequence + 1);
  // The raced run already aborted every upload but recorded no receipt; the
  // recovery pass re-observes actual provider state and records it empty.
  const recovered = await recordKaraokeCleanupPass(input);
  expect(recovered.latestPasses.every((pass) => pass.outcome === "observed-empty")).toBe(true);
  append("fence-broken");
  await expect(recordKaraokeCleanupPass(input)).rejects.toThrow("karaoke_cleanup_fence_not_held");
});
