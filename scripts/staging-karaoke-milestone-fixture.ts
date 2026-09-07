import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconciliationDigest } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import { KARAOKE_RESET_OBJECT_IDS } from "../packages/platform-cf/src/karaoke-reset-installation.ts";
import { makeKaraokeCollectorFixture } from "../packages/testing/src/karaoke-collector-fixture.ts";
import {
  appendKaraokeMaintenanceEvent,
  type KaraokeJournalTrust,
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
export function disposeMilestoneFixtures() {
  for (const dispose of disposals.splice(0)) dispose();
}
export function makeKaraokeMilestoneFixture() {
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
  const seed = (kind: "begin" | "fence-observed") =>
    appendKaraokeMaintenanceEvent({
      trust: journal,
      privateKeyPem,
      observedAt: now(),
      event: { kind, evidenceIds: [trust.residualDispositionId] },
      artifacts: [residual],
    });
  seed("begin");
  const held = seed("fence-observed");
  const reads = { fence: 0, inspection: 0, sql: 0, r2: 0 };
  // Mutable provider state: markers retire, identity rows disappear at reset,
  // and the fence stops holding once the release actually executes.
  const state = {
    markers: "active" as "active" | "retired",
    identityPresent: true,
    fenceHeld: true,
    failInspectionOnce: false,
  };
  const readers: KaraokeSigningReaders = {
    inspect: async (target) => {
      reads.inspection++;
      if (state.failInspectionOnce) {
        state.failInspectionOnce = false;
        throw new Error("fixture inspection failed");
      }
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
          ingress: state.fenceHeld,
          producers: state.fenceHeld,
          databaseWrites: state.fenceHeld,
          reconnectDenied: state.fenceHeld,
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
      verifyFenceRelease: async () => {
        const result = (evidence ?? release(now())) as ReturnType<typeof release>;
        if (result.allSixRetired) state.fenceHeld = false;
        return result;
      },
    });
  const append = (kind: "begin" | "fence-observed", when?: string) =>
    appendKaraokeMaintenanceEvent({
      trust: journal,
      privateKeyPem,
      observedAt: when ?? now(),
      event: { kind, evidenceIds: [trust.residualDispositionId] },
      artifacts: [residual],
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
    append,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
