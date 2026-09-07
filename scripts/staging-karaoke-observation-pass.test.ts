import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconciliationDigest } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import { KARAOKE_RESET_OBJECT_IDS } from "../packages/platform-cf/src/karaoke-reset-installation.ts";
import { makeKaraokeCollectorFixture } from "../packages/testing/src/karaoke-collector-fixture.ts";
import {
  appendKaraokeMaintenanceEvent,
  type KaraokeJournalTrust,
  readKaraokeMaintenanceJournal,
} from "./karaoke-maintenance-journal.ts";
import { recordKaraokeObservationPass } from "./staging-karaoke-observation-pass.ts";
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
  const directory = mkdtempSync(join(tmpdir(), "karaoke-observation-pass-test-"));
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
  const reads = { fence: 0, inspection: 0, sql: 0, r2: 0 };
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
  const state = { present: false, multipart: false, concurrent: false };
  const transport = async (input: string, init: RequestInit) => {
    expect(["GET", "HEAD"]).toContain(init.method ?? "");
    reads.r2++;
    if (state.concurrent) {
      state.concurrent = false;
      append("fence-observed");
    }
    const url = new URL(String(input));
    const key = url.searchParams.get("prefix");
    const headers = { "x-amz-request-id": `fixture-${reads.r2}` };
    if (key !== null) {
      const exact = state.multipart
        ? `<Upload><Key>${key}</Key><UploadId>fixture-upload</UploadId></Upload>`
        : "";
      return new Response(
        `<ListMultipartUploadsResult><Bucket>${STAGING_KARAOKE_BUCKET}</Bucket><Prefix>${key}</Prefix><IsTruncated>false</IsTruncated>${exact}<Upload><Key>${key}.neighbor</Key><UploadId>neighbor</UploadId></Upload></ListMultipartUploadsResult>`,
        { headers },
      );
    }
    return new Response(null, {
      status: url.pathname === `/${STAGING_KARAOKE_BUCKET}` || state.present ? 200 : 404,
      headers,
    });
  };
  const r2 = makeStagingKaraokeR2Observer({
    accountId: "a".repeat(32),
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
    fetch: transport,
  });
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
    r2,
    now,
    authenticationFetch: f.authenticationFetch,
  };
  return { input, reads, state, now, journal, held, append };
}

test("real observer and signed journal record post-fence then pre-reset without changing false quiescence", async () => {
  const { input, reads, journal, now } = fixture();
  const first = await recordKaraokeObservationPass({ ...input, phase: "post-fence" });
  expect(first.resetAdmission).toBe("blocked");
  expect(first.executionAuthorized).toBe(false);
  expect(
    first.latestPasses.every(
      (pass) => pass.outcome === "observed-empty" && !pass.quiescenceEstablished,
    ),
  ).toBe(true);
  const second = await recordKaraokeObservationPass({ ...input, phase: "pre-reset" });
  expect(second.resetAdmission).toBe("eligible");
  expect(second.executionAuthorized).toBe(false);
  expect(reads).toEqual({ fence: 4, inspection: 12, sql: 12, r2: 96 });
  const retained = readKaraokeMaintenanceJournal({ ...journal, expectedHead: second.head }, now());
  expect(retained.head.sequence).toBe(13);
  expect(Object.values(retained.history).every((history) => history.length === 2)).toBe(true);
});

test("exact-key remnants record incomplete and cannot advance to pre-reset; neighbors are never cleanup authority", async () => {
  for (const kind of ["present", "multipart"] as const) {
    const { input, state, journal, now } = fixture();
    state[kind] = true;
    const first = await recordKaraokeObservationPass({ ...input, phase: "post-fence" });
    expect(first.latestPasses.every((pass) => pass.outcome === "incomplete")).toBe(true);
    expect(first.resetAdmission).toBe("blocked");
    await expect(recordKaraokeObservationPass({ ...input, phase: "pre-reset" })).rejects.toThrow(
      "inconsistent_evidence",
    );
    expect(readKaraokeMaintenanceJournal(journal, now()).head).toEqual(first.head);
  }
});

test("changed journal or lost final fence refuses recording without discarding prior history", async () => {
  for (const failure of ["concurrent", "final-fence"] as const) {
    const { input, state, journal, now, held } = fixture();
    if (failure === "concurrent") state.concurrent = true;
    else {
      const observe = input.readers.observeMaintainedFence;
      let count = 0;
      input.readers.observeMaintainedFence = async () => {
        if (++count === 2) throw new Error("fixture lost fence");
        return observe();
      };
    }
    await expect(recordKaraokeObservationPass({ ...input, phase: "post-fence" })).rejects.toThrow();
    const retained = readKaraokeMaintenanceJournal(journal, now());
    expect(Object.values(retained.history).every((history) => history.length === 0)).toBe(true);
    expect(retained.head.sequence).toBe(held.head.sequence + (failure === "concurrent" ? 1 : 0));
  }
});

test("wrong operator or absent authority refuses before bucket observation", async () => {
  for (const failure of ["auth", "authority"] as const) {
    const { input, reads, journal, now, held } = fixture();
    if (failure === "auth") input.assertion = "invalid";
    else {
      const inspect = input.readers.inspect;
      input.readers.inspect = async (target) => ({
        ...((await inspect(target)) as object),
        authority: null,
      });
    }
    await expect(recordKaraokeObservationPass({ ...input, phase: "post-fence" })).rejects.toThrow();
    expect(reads.r2).toBe(0);
    expect(readKaraokeMaintenanceJournal(journal, now()).head).toEqual(held.head);
  }
});

test("parent verifies signed pass challenge and refuses a different challenge or expired result", async () => {
  const { input, held, now } = fixture();
  const started = Date.parse(now());
  const recorded = await recordKaraokeObservationPass({ ...input, phase: "post-fence" });
  const proof = {
    config: input.trust,
    journalTrust: input.journal,
    priorHead: held.head,
    challenge: input.challenge,
    phase: "post-fence" as const,
    started,
    nowUtc: now(),
  };
  expect((await verifyRecordedKaraokePass(proof)).journalHead).toEqual(recorded.head);
  await expect(
    verifyRecordedKaraokePass({
      ...proof,
      challenge: { ...proof.challenge, challenge: "d".repeat(64) },
    }),
  ).rejects.toThrow("challenge_denied");
  await expect(
    verifyRecordedKaraokePass({ ...proof, nowUtc: new Date(started + 60_001).toISOString() }),
  ).rejects.toThrow("attestation_denied");
});
