import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconciliationDigest } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import { KARAOKE_RESET_OBJECT_IDS } from "../packages/platform-cf/src/karaoke-reset-installation.ts";
import { makeKaraokeCollectorFixture } from "../packages/testing/src/karaoke-collector-fixture.ts";
import { readKaraokeMaintenanceJournal } from "./karaoke-maintenance-journal.ts";
import { recordStagingKaraokeFence } from "./staging-karaoke-record-fence.ts";

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});
function fixture() {
  const f = makeKaraokeCollectorFixture(KARAOKE_RESET_OBJECT_IDS, reconciliationDigest);
  const privateDirectory = mkdtempSync(join(tmpdir(), "karaoke-fence-config-test-"));
  const journalDirectory = mkdtempSync(join(tmpdir(), "karaoke-fence-journal-test-"));
  disposals.push(
    f.dispose,
    () => rmSync(privateDirectory, { recursive: true, force: true }),
    () => rmSync(journalDirectory, { recursive: true, force: true }),
  );
  const file = (name: string, bytes: string) => {
    const path = join(privateDirectory, name);
    writeFileSync(path, bytes, { mode: 0o600 });
    return path;
  };
  const collectorSourceDigest = reconciliationDigest("fixture-source");
  const originalResidual = f.evidence.artifacts.get(f.trust.residualDispositionId);
  if (!originalResidual) throw new Error("fixture disposition missing");
  const residual = JSON.stringify({
    ...JSON.parse(originalResidual),
    bucket: "pirate-learner-audio-staging",
  });
  const operator = {
    version: "staging-karaoke-operator-config-v1",
    ...f.trust,
    bucket: "pirate-learner-audio-staging",
    residualDispositionId: reconciliationDigest(residual),
    collectorPath: file("collector.mjs", "fixture-source"),
    collectorSourceDigest,
    expectedHistory: Object.fromEntries(KARAOKE_RESET_OBJECT_IDS.map((id) => [id, []])),
  };
  const config = {
    version: "staging-karaoke-live-collector-v1",
    operatorConfigPath: file("operator.json", JSON.stringify(operator)),
    signingKeyPath: file(
      "signing.pem",
      f.signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    ),
    inspectionOrigin: "https://collector-test.example",
    journalDirectory,
    residualDispositionPath: file("disposition.json", residual),
    expectedJournalHead: null,
    baselineIds: [],
    pins: {
      accountId: "08a4c22cf52e2ecae883e36f80a33f4a",
      ingressApplicationId: "a".repeat(32),
      reviewedVersions: [],
      queues: [],
      external: [],
    },
  };
  const input = {
    configPath: file("live.json", JSON.stringify(config)),
    assertionPath: file("assertion.jwt", f.assertion()),
    runDirectory: f.directory,
    sourceDigest: collectorSourceDigest,
    apiToken: "fixture-token",
    challengeJson: JSON.stringify({
      version: "staging-karaoke-collector-challenge-v1",
      challenge: "b".repeat(64),
      epoch: operator.epoch,
      bucket: operator.bucket,
      operatorSubjectDigest: reconciliationDigest(operator.operator.KARAOKE_RESET_ACCESS_SUBJECT),
    }),
  };
  const reads = { fence: 0, inspection: 0, sql: 0 };
  type Dependencies = NonNullable<Parameters<typeof recordStagingKaraokeFence>[1]>;
  const dependencies: { -readonly [K in keyof Dependencies]: Dependencies[K] } = {
    authenticationFetch: f.authenticationFetch,
    observeFence: async () => {
      reads.fence++;
      // Provider-bound test double; no provider operation is performed by this test.
      return {
        fence: {
          verifiedAt: new Date().toISOString(),
          ingress: true,
          producers: true,
          databaseWrites: true,
          reconnectDenied: true,
          runtimeSessions: 0,
          residualDispositionId: operator.residualDispositionId,
        },
        supporting: { fixture: true },
        executionAuthorized: false,
      };
    },
    inspect: async ({ target }) => {
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
        observedAt: new Date().toISOString(),
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
    observeIdentity: async (authority) => {
      reads.sql++;
      return {
        state: "present",
        key: `karaoke/${authority.accountId}/${authority.attemptId}.pcm`,
        identity: { ...authority, identityDigest: reconciliationDigest(JSON.stringify(authority)) },
        observedAt: new Date().toISOString(),
      };
    },
  };
  return { f, operator, config, input, dependencies, reads, journalDirectory };
}

test("authenticated fence recording retains six live-read baselines and false quiescence without reset authority", async () => {
  const { operator, input, dependencies, reads, journalDirectory } = fixture();
  const result = await recordStagingKaraokeFence(input, dependencies);
  expect(result.executionAuthorized).toBe(false);
  expect(result.baselineIds).toHaveLength(6);
  expect(reads).toEqual({ fence: 1, inspection: 6, sql: 6 });
  const journal = readKaraokeMaintenanceJournal(
    {
      directory: journalDirectory,
      publicKeyPem: operator.collectorPublicKeyPem,
      epoch: operator.epoch,
      collectorSourceDigest: operator.collectorSourceDigest,
      expectedHead: result.head,
    },
    new Date().toISOString(),
  );
  expect(journal.state).toBe("held");
  expect(journal.head.sequence).toBe(1);
  const artifacts = journal.entries[0]?.entry.event.evidenceIds.map((id) =>
    JSON.parse(journal.readArtifact(id)),
  );
  const snapshots = artifacts?.filter((a) => a.version === "staging-karaoke-reset-inspection-v1");
  expect(snapshots).toHaveLength(6);
  expect(snapshots?.every((s) => s.installationReceipt.quiescenceEstablished === false)).toBe(true);
  await expect(recordStagingKaraokeFence(input, dependencies)).rejects.toThrow();
  expect(
    readKaraokeMaintenanceJournal(
      {
        directory: journalDirectory,
        publicKeyPem: operator.collectorPublicKeyPem,
        epoch: operator.epoch,
        collectorSourceDigest: operator.collectorSourceDigest,
        expectedHead: result.head,
      },
      new Date().toISOString(),
    ).head,
  ).toEqual(result.head);
});

test("fence initialization refuses unauthenticated, broken fence, missing authority and incomplete SQL without a journal", async () => {
  for (const failure of ["auth", "fence", "authority", "sql", "challenge"] as const) {
    const { f, input, dependencies, reads, journalDirectory } = fixture();
    if (failure === "auth") writeFileSync(input.assertionPath, f.assertion("wrong-subject"));
    if (failure === "challenge") {
      const challenge = JSON.parse(input.challengeJson);
      challenge.epoch = "f".repeat(64);
      input.challengeJson = JSON.stringify(challenge);
    }
    if (failure === "fence") {
      const observe = dependencies.observeFence;
      if (!observe) throw new Error("missing fixture observer");
      dependencies.observeFence = async (value) => {
        const result = await observe(value);
        return { ...result, fence: { ...result.fence, producers: false } };
      };
    }
    if (failure === "authority") {
      const inspect = dependencies.inspect;
      if (!inspect) throw new Error("missing fixture observer");
      dependencies.inspect = async (value) => ({ ...(await inspect(value)), authority: null });
    }
    if (failure === "sql")
      dependencies.observeIdentity = async () => {
        throw new Error("fixture database unavailable");
      };
    await expect(recordStagingKaraokeFence(input, dependencies)).rejects.toThrow();
    expect(existsSync(join(journalDirectory, "manifest.signed.json"))).toBe(false);
    if (failure === "auth" || failure === "challenge")
      expect(reads).toEqual({ fence: 0, inspection: 0, sql: 0 });
    else expect(reads.fence).toBe(1);
  }
});
