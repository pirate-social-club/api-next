import { afterEach, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyKaraokeReconciliation } from "../packages/platform-cf/src/karaoke-reconciliation.ts";
import { reconciliationDigest } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import { KARAOKE_RESET_OBJECT_IDS } from "../packages/platform-cf/src/karaoke-reset-installation.ts";
import { makeKaraokeCollectorFixture } from "../packages/testing/src/karaoke-collector-fixture.ts";
import {
  appendKaraokeMaintenanceEvent,
  type KaraokeJournalTrust,
} from "./karaoke-maintenance-journal.ts";
import { openAuthenticatedKaraokeEvidence } from "./karaoke-reconciliation-adapter.ts";
import { karaokeJournalIntegrationTest as test } from "./staging-karaoke-journal-test.ts";
import {
  collectSignedKaraokeReconciliation,
  type KaraokeSigningReaders,
} from "./staging-karaoke-signing-collector.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});
function fixture() {
  const f = makeKaraokeCollectorFixture(KARAOKE_RESET_OBJECT_IDS, reconciliationDigest);
  const journalDirectory = mkdtempSync(join(tmpdir(), "karaoke-signer-journal-test-"));
  cleanup.push(f.dispose, () => rmSync(journalDirectory, { recursive: true, force: true }));
  const privateKeyPem = f.signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const journal: KaraokeJournalTrust = {
    directory: journalDirectory,
    publicKeyPem: f.trust.collectorPublicKeyPem,
    epoch: f.trust.epoch,
    collectorSourceDigest: f.trust.collectorSourceDigest,
    expectedHead: null,
  };
  const residual = f.evidence.artifacts.get(f.trust.residualDispositionId);
  if (!residual) throw new Error("missing fixture");
  const append = (
    event: Parameters<typeof appendKaraokeMaintenanceEvent>[0]["event"],
    artifacts: string[],
  ) =>
    appendKaraokeMaintenanceEvent({
      trust: journal,
      privateKeyPem,
      observedAt: f.now(),
      event,
      artifacts,
    });
  append({ kind: "begin", evidenceIds: [f.trust.residualDispositionId] }, [residual]);
  append({ kind: "fence-observed", evidenceIds: [f.trust.residualDispositionId] }, [residual]);
  for (const target of f.evidence.manifest.targets)
    for (const receiptId of target.receiptIds) {
      const ref = f.evidence.manifest.entries.find((entry) => entry.id === receiptId);
      if (!ref) throw new Error("missing fixture scope");
      const refs = f.evidence.manifest.entries.filter(
        (entry) => JSON.stringify(entry.scope) === JSON.stringify(ref.scope),
      );
      append(
        {
          kind: "pass",
          objectId: target.objectId as (typeof KARAOKE_RESET_OBJECT_IDS)[number],
          receiptId,
          evidenceIds: refs.map((entry) => entry.id),
        },
        refs.map((entry) => {
          const bytes = f.evidence.artifacts.get(entry.id);
          if (!bytes) throw new Error("missing fixture bytes");
          return bytes;
        }),
      );
    }
  const reads = { inspections: 0, nonReuse: 0, fence: 0 };
  const readers: KaraokeSigningReaders = {
    async inspect(target) {
      reads.inspections++;
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
        observedAt: f.now(),
        markerState: "active",
        initial: observation,
        current: observation,
        authority: { accountId: "account", attemptId: target.objectId },
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
    async verifyNonReuse(_snapshot, phase) {
      reads.nonReuse++;
      expect(phase).toBe("before-reset");
      return { keyNotReused: true, observedAt: f.now() };
    },
    async observeMaintainedFence() {
      reads.fence++;
      return {
        supporting: { fixture: true },
        fence: {
          verifiedAt: f.now(),
          ingress: true,
          producers: true,
          databaseWrites: true,
          reconnectDenied: true,
          runtimeSessions: 0,
          residualDispositionId: f.trust.residualDispositionId,
        },
      };
    },
  };
  const collect = (
    challenge: Parameters<typeof collectSignedKaraokeReconciliation>[0]["challenge"],
  ) =>
    collectSignedKaraokeReconciliation({
      trust: f.trust,
      journal,
      privateKeyPem,
      assertion: f.assertion(),
      challenge,
      readers,
      authenticationFetch: f.authenticationFetch,
      now: f.now,
    });
  return { f, journal, append, readers, reads, collect, residual };
}

test("signed journal plus fresh observations reaches the actual verifier and preserves false quiescence", async () => {
  const { f, collect, reads } = fixture();
  const port = await openAuthenticatedKaraokeEvidence(
    f.trust,
    f.assertion(),
    {
      async collect(challenge) {
        expect((await collect(challenge)).executionAuthorized).toBe(false);
      },
    },
    f.now,
    f.authenticationFetch,
  );
  const result = await verifyKaraokeReconciliation(port, f.now());
  expect(result.resetAdmission).toBe("eligible");
  expect(result.latestPasses.every((pass) => pass.quiescenceEstablished === false)).toBe(true);
  expect(reads).toEqual({ inspections: 6, nonReuse: 6, fence: 1 });
});

test("failed fresh observations cannot write a signed manifest", async () => {
  for (const kind of ["fence", "marker", "nonreuse"] as const) {
    const { f, readers, collect } = fixture();
    if (kind === "fence")
      readers.observeMaintainedFence = async () => {
        throw new Error("unavailable");
      };
    if (kind === "marker") {
      const inspect = readers.inspect;
      readers.inspect = async (target) => ({
        ...((await inspect(target)) as object),
        markerState: "absent",
      });
    }
    if (kind === "nonreuse")
      readers.verifyNonReuse = async () => {
        throw new Error("reused");
      };
    await expect(
      openAuthenticatedKaraokeEvidence(
        f.trust,
        f.assertion(),
        {
          async collect(challenge) {
            await collect(challenge);
          },
        },
        f.now,
        f.authenticationFetch,
      ),
    ).rejects.toThrow();
    expect(existsSync(join(f.directory, "manifest.signed.json"))).toBe(false);
  }
});

test("a concurrent broken-fence journal event invalidates collection before signing", async () => {
  const { f, append, residual, readers, collect } = fixture();
  const inspect = readers.inspect;
  let changed = false;
  readers.inspect = async (target) => {
    if (!changed) {
      changed = true;
      append({ kind: "fence-broken", evidenceIds: [f.trust.residualDispositionId] }, [residual]);
    }
    return inspect(target);
  };
  await expect(
    openAuthenticatedKaraokeEvidence(
      f.trust,
      f.assertion(),
      {
        async collect(challenge) {
          await collect(challenge);
        },
      },
      f.now,
      f.authenticationFetch,
    ),
  ).rejects.toThrow("journal_changed");
  expect(existsSync(join(f.directory, "manifest.signed.json"))).toBe(false);
});

test("a later failed collection preserves the last signed output rather than replacing it", async () => {
  const { f, readers, collect } = fixture();
  const invoke = () =>
    openAuthenticatedKaraokeEvidence(
      f.trust,
      f.assertion(),
      {
        async collect(challenge) {
          await collect(challenge);
        },
      },
      f.now,
      f.authenticationFetch,
    );
  await invoke();
  const before = readFileSync(join(f.directory, "manifest.signed.json"), "utf8");
  readers.observeMaintainedFence = async () => ({
    supporting: { fixture: true },
    fence: {
      verifiedAt: f.now(),
      ingress: true,
      producers: false,
      databaseWrites: true,
      reconnectDenied: true,
      runtimeSessions: 0,
      residualDispositionId: f.trust.residualDispositionId,
    },
  });
  await expect(invoke()).rejects.toThrow("fence_unproven");
  expect(readFileSync(join(f.directory, "manifest.signed.json"), "utf8")).toBe(before);
});
