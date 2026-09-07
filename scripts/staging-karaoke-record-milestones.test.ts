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
import { recordKaraokeFenceRelease } from "./staging-karaoke-record-release.ts";
import { recordKaraokeResetVerification } from "./staging-karaoke-record-reset.ts";
import { recordKaraokeRetirementCompletion } from "./staging-karaoke-record-retirement.ts";
import type { KaraokeSigningReaders } from "./staging-karaoke-signing-collector.ts";

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});
function fixture() {
  const f = makeKaraokeCollectorFixture(KARAOKE_RESET_OBJECT_IDS, reconciliationDigest);
  const directory = mkdtempSync(join(tmpdir(), "karaoke-milestone-test-"));
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
  const append = (kind: "begin" | "fence-observed") =>
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
  // Mutable provider state: markers retire, identity rows disappear at reset.
  const state = { markers: "active" as "active" | "retired", identityPresent: true };
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
        markerState: state.markers,
        initial: observation,
        current: observation,
        authority: { accountId: "fixture-account", attemptId: target.objectId },
        installationReceipt: {
          ...target,
          state: state.markers,
          initial: observation,
          current: observation,
          cancellationSucceeded: true,
          quiescenceEstablished: false,
        },
      };
    },
    verifyNonReuse: async (_snapshot, phase) => {
      reads.sql++;
      if (phase === "before-reset" ? !state.identityPresent : state.identityPresent)
        throw new Error("karaoke_sql_nonreuse_unproven");
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
  const transport = async (input: string, init: RequestInit) => {
    expect(["GET", "HEAD"]).toContain(init.method ?? "");
    reads.r2++;
    const url = new URL(String(input));
    const prefix = url.searchParams.get("prefix");
    const headers = { "x-amz-request-id": `fixture-${reads.r2}` };
    if (prefix !== null)
      return new Response(
        `<ListMultipartUploadsResult><Bucket>${STAGING_KARAOKE_BUCKET}</Bucket><Prefix>${prefix}</Prefix><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>`,
        { headers },
      );
    return new Response(null, {
      status: url.pathname === `/${STAGING_KARAOKE_BUCKET}` ? 200 : 404,
      headers,
    });
  };
  const challenge = {
    version: "staging-karaoke-collector-challenge-v1" as const,
    challenge: "c".repeat(64),
    operatorSubjectDigest: reconciliationDigest(trust.operator.KARAOKE_RESET_ACCESS_SUBJECT),
    epoch: trust.epoch,
    bucket: trust.bucket,
  };
  const base = {
    trust,
    journal: { ...journal, expectedHead: held.head },
    privateKeyPem,
    assertion: f.assertion(),
    challenge,
    readers,
    now,
    authenticationFetch: f.authenticationFetch,
  };
  const pass = (phase: "post-fence" | "pre-reset" | "retirement" | "follow-up") =>
    recordKaraokeObservationPass({
      ...base,
      phase,
      r2: makeStagingKaraokeR2Observer({
        accountId: "a".repeat(32),
        credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
        fetch: transport,
      }),
    });
  const completion = (now: string) => ({
    version: "staging-karaoke-reset-completion-v1" as const,
    verifiedAt: now,
    serverVersion: "18.6",
    terminalMigration: "0119",
    ledgerDigest: "d".repeat(64),
    personaCounts: { unbound: 0, singleCommunity: 0, multiCommunity: 0 },
    personaEvidenceDigest: "e".repeat(64),
  });
  const resetOrigin = (evidence?: unknown) =>
    recordKaraokeResetVerification({
      ...base,
      verifyResetCompletion: async () => evidence ?? completion(now()),
    });
  const retirementOrigin = () => recordKaraokeRetirementCompletion(base);
  const release = (releasedAt: string, allSixRetired = true) => ({
    releasedAt,
    allSixRetired,
  });
  const releaseOrigin = (evidence?: unknown) =>
    recordKaraokeFenceRelease({
      ...base,
      verifyFenceRelease: async () => evidence ?? release(now()),
    });
  return {
    base,
    pass,
    resetOrigin,
    retirementOrigin,
    releaseOrigin,
    completion,
    release,
    state,
    reads,
    journal,
    now,
    held,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

test("full ceremony: passes, reset origin, retirement pass, all-retired, release and 24h follow-up", async () => {
  const {
    pass,
    resetOrigin,
    retirementOrigin,
    releaseOrigin,
    state,
    reads,
    journal,
    now,
    advance,
  } = fixture();
  const postFence = await pass("post-fence");
  expect(postFence.latestPasses.every((p) => p.outcome === "observed-empty")).toBe(true);
  const preReset = await pass("pre-reset");
  expect(preReset.resetAdmission).toBe("eligible");
  state.identityPresent = false;
  const reset = await resetOrigin();
  expect(reset.executionAuthorized).toBe(false);
  state.markers = "retired";
  const retirement = await pass("retirement");
  expect(retirement.latestPasses.every((p) => p.outcome === "observed-empty")).toBe(true);
  expect(retirement.resetAdmission).toBe("blocked");
  const allRetired = await retirementOrigin();
  expect(allRetired.executionAuthorized).toBe(false);
  const releasedHead = await releaseOrigin();
  expect(releasedHead.executionAuthorized).toBe(false);
  expect(readKaraokeMaintenanceJournal(journal, now()).state).toBe("released");
  const fenceReadsAtFollowUp = reads.fence;
  advance(86_400_000);
  const followUp = await pass("follow-up");
  expect(followUp.retentionStatus).toBe("observed-stable");
  expect(followUp.latestPasses.every((p) => p.outcome === "observed-empty")).toBe(true);
  // Post-release passes cite historical fence evidence, never a fresh claim.
  expect(reads.fence).toBe(fenceReadsAtFollowUp);
  expect(readKaraokeMaintenanceJournal(journal, now()).state).toBe("released");
});

test("follow-up obeys the 24-hour boundary and requires a recorded release", async () => {
  const { pass, resetOrigin, retirementOrigin, releaseOrigin, state, journal, now, advance } =
    fixture();
  await pass("post-fence");
  await pass("pre-reset");
  state.identityPresent = false;
  await resetOrigin();
  state.markers = "retired";
  await pass("retirement");
  await retirementOrigin();
  await expect(pass("follow-up")).rejects.toThrow("karaoke_pass_release_scope_denied");
  await releaseOrigin();
  await expect(pass("follow-up")).rejects.toThrow();
  advance(86_400_000);
  const followUp = await pass("follow-up");
  expect(followUp.retentionStatus).toBe("observed-stable");
  expect(readKaraokeMaintenanceJournal(journal, now()).state).toBe("released");
});

test("reset origin requires eligible admission, zero counts and fresh completion", async () => {
  const { pass, resetOrigin, completion, state, journal, now, held } = fixture();
  await pass("post-fence");
  await expect(resetOrigin()).rejects.toThrow("karaoke_reset_origin_admission_denied");
  await pass("pre-reset");
  state.identityPresent = false;
  const counts = {
    ...completion(now()),
    personaCounts: { unbound: 0, singleCommunity: 1, multiCommunity: 0 },
  };
  await expect(resetOrigin(counts)).rejects.toThrow("karaoke_reset_origin_completion_unproven");
  await expect(resetOrigin()).resolves.toHaveProperty("executionAuthorized", false);
  await expect(resetOrigin()).rejects.toThrow("karaoke_reset_origin_state_denied");
  expect(readKaraokeMaintenanceJournal(journal, now()).state).toBe("reset");
  expect(held.head).toBeDefined();
});

test("retirement and release origins refuse wrong state or unretired markers", async () => {
  const { pass, resetOrigin, retirementOrigin, releaseOrigin, state, release, now } = fixture();
  await expect(retirementOrigin()).rejects.toThrow("karaoke_retirement_origin_state_denied");
  // While the journal is still held, retirement passes refuse regardless of
  // what the markers claim.
  state.markers = "retired";
  await expect(pass("retirement")).rejects.toThrow("karaoke_pass_retirement_state_denied");
  state.markers = "active";
  await pass("post-fence");
  await pass("pre-reset");
  state.identityPresent = false;
  await resetOrigin();
  await expect(pass("retirement")).rejects.toThrow("karaoke_pass_marker_or_authority_unproven");
  await expect(releaseOrigin()).rejects.toThrow("karaoke_release_origin_state_denied");
  state.markers = "retired";
  await pass("retirement");
  // Retirement passes are recorded, then a marker regresses: the origin must
  // refuse to certify all-retired from unretired readbacks.
  state.markers = "active";
  await expect(retirementOrigin()).rejects.toThrow("karaoke_retirement_origin_marker_unproven");
  state.markers = "retired";
  await retirementOrigin();
  await expect(releaseOrigin(release(now(), false))).rejects.toThrow(
    "karaoke_release_origin_release_unproven",
  );
  await expect(releaseOrigin()).resolves.toHaveProperty("executionAuthorized", false);
});
