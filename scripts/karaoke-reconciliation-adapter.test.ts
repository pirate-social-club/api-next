import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, linkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyKaraokeReconciliation } from "../packages/platform-cf/src/karaoke-reconciliation.ts";
import {
  FenceEvidence,
  makeReconciliationReader,
  ReconciliationManifest,
  ReconciliationScope,
  reconciliationDigest,
} from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import { decodeReconciliation } from "../packages/platform-cf/src/karaoke-reconciliation-schema.ts";
import { KARAOKE_RESET_OBJECT_IDS } from "../packages/platform-cf/src/karaoke-reset-installation.ts";
import { makeKaraokeCollectorFixture } from "../packages/testing/src/karaoke-collector-fixture.ts";
import { openKaraokePrivateArtifacts } from "./karaoke-private-artifacts.ts";
import {
  type KaraokeLiveCollector,
  openAuthenticatedKaraokeEvidence,
} from "./karaoke-reconciliation-adapter.ts";

const fixtures: ReturnType<typeof makeKaraokeCollectorFixture>[] = [];
function fixture() {
  const value = makeKaraokeCollectorFixture(KARAOKE_RESET_OBJECT_IDS, reconciliationDigest);
  fixtures.push(value);
  return value;
}
afterEach(() => {
  for (const item of fixtures.splice(0)) item.dispose();
});
function open(f: ReturnType<typeof fixture>, collector: KaraokeLiveCollector = f.collector) {
  return openAuthenticatedKaraokeEvidence(
    f.trust,
    f.assertion(),
    collector,
    f.now,
    f.authenticationFetch,
  );
}

test("signed private artifacts exercise the real reconciliation decoder and remain snapshotted", async () => {
  const f = fixture();
  const port = await open(f);
  expect((await verifyKaraokeReconciliation(port, f.now())).resetAdmission).toBe("eligible");
  const id = f.evidence.manifest.entries[0]?.id;
  if (id === undefined) throw new Error("missing_fixture");
  writeFileSync(join(f.directory, `${id}.json`), "changed");
  const expected = f.evidence.artifacts.get(id);
  if (expected === undefined) throw new Error("missing_fixture_artifact");
  expect(await port.readArtifact(id)).toBe(expected);
  await expect(port.readArtifact("../outside")).rejects.toThrow();
});

test("wrong authenticated subject never invokes the collector", async () => {
  const f = fixture();
  let calls = 0;
  await expect(
    openAuthenticatedKaraokeEvidence(
      f.trust,
      f.assertion("other"),
      {
        async collect() {
          calls++;
        },
      },
      f.now,
      f.authenticationFetch,
    ),
  ).rejects.toThrow("karaoke_reset_operator_denied");
  expect(calls).toBe(0);
});

test("runner encoder field projection passes the real decoder; diagnostic extras fail", async () => {
  for (const includeDiagnostics of [false, true]) {
    const f = fixture();
    const scope = decodeReconciliation(ReconciliationScope, f.evidence.manifest.entries[0]?.scope);
    // Frozen byte shape of runner encodeFenceEvidenceArtifact at 5deae1b2.
    const data = {
      verifiedAt: f.evidence.now,
      ingress: true,
      producers: true,
      databaseWrites: true,
      reconnectDenied: true,
      runtimeSessions: 0,
      residualDispositionId: f.trust.residualDispositionId,
      ...(includeDiagnostics ? { runtimeIdentityFingerprints: ["fixture-diagnostic"] } : {}),
    };
    const bytes = JSON.stringify({ scope, data });
    const id = reconciliationDigest(bytes);
    f.evidence.manifest.entries.push({ id, scope });
    writeFileSync(join(f.directory, `${id}.json`), bytes, { mode: 0o600 });
    const port = await open(f);
    const manifest = decodeReconciliation(
      ReconciliationManifest,
      await port.readCurrentAuthenticatedManifest(),
    );
    const decoded = makeReconciliationReader(port, manifest)(id, scope, FenceEvidence);
    if (includeDiagnostics)
      await expect(decoded).rejects.toThrow("karaoke_reconciliation_invalid_evidence");
    else expect(await decoded).toEqual(data);
  }
});

test("wrong signing key is rejected", async () => {
  const f = fixture();
  await expect(
    open(f, {
      async collect(challenge) {
        f.writeAttestation(f.attestation(challenge), generateKeyPairSync("ed25519").privateKey);
      },
    }),
  ).rejects.toThrow("karaoke_adapter_signature_denied");
});

test.each(["subject", "source", "stale", "future", "challenge", "epoch", "disposition"])(
  "rejects signed %s mismatch",
  async (variant) => {
    const f = fixture();
    await expect(
      open(f, {
        async collect(challenge) {
          const value = f.attestation(challenge);
          if (variant === "subject") value.operatorSubjectDigest = "0".repeat(64);
          if (variant === "source") value.collectorSourceDigest = "0".repeat(64);
          if (variant === "stale") value.observedAt = "2026-09-01T00:00:00.000Z";
          if (variant === "future") value.observedAt = "2027-09-01T00:00:00.000Z";
          if (variant === "challenge") value.challenge = "0".repeat(64);
          if (variant === "epoch") value.manifest.epoch = "0".repeat(64);
          if (variant === "disposition") value.manifest.residualDispositionId = "0".repeat(64);
          f.writeAttestation(value);
        },
      }),
    ).rejects.toThrow("karaoke_adapter_attestation_denied");
  },
);

test("a signed challenge cannot be replayed in a later invocation", async () => {
  const f = fixture();
  await open(f);
  await expect(open(f, { async collect() {} })).rejects.toThrow(
    "karaoke_adapter_attestation_denied",
  );
});

test.each(["omitted", "reordered"])("rejects %s retained history", async (variant) => {
  const f = fixture();
  await expect(
    open(f, {
      async collect(challenge) {
        const value = f.attestation(challenge);
        for (const target of value.manifest.targets) {
          if (variant === "omitted") target.receiptIds.shift();
          else target.receiptIds.reverse();
        }
        f.writeAttestation(value);
      },
    }),
  ).rejects.toThrow("karaoke_adapter_history_denied");
});

test("artifact digest mismatch fails before the verifier can consume it", async () => {
  const f = fixture();
  writeFileSync(join(f.directory, `${f.trust.residualDispositionId}.json`), "{}");
  await expect(open(f)).rejects.toThrow("karaoke_adapter_artifact_denied");
});

test("artifact reads preserve a UTF-8 BOM so adding bytes cannot keep the old digest", async () => {
  const f = fixture();
  const id = f.trust.residualDispositionId;
  const bytes = f.evidence.artifacts.get(id);
  if (bytes === undefined) throw new Error("missing_fixture_artifact");
  writeFileSync(join(f.directory, `${id}.json`), `\uFEFF${bytes}`);
  await expect(open(f)).rejects.toThrow("karaoke_adapter_artifact_denied");
});

test("private store rejects traversal, symlinks, hardlinks, public files and size overflow", () => {
  const f = fixture();
  const path = join(f.directory, "manifest.signed.json");
  const store = openKaraokePrivateArtifacts(f.directory);
  try {
    expect(() => store.read("../manifest.signed.json", 128)).toThrow();
    const original = join(f.directory, "original");
    writeFileSync(original, "{}", { mode: 0o600 });
    symlinkSync(original, path);
    expect(() => store.read("manifest.signed.json", 128)).toThrow();
    unlinkSync(path);
    linkSync(original, path);
    expect(() => store.read("manifest.signed.json", 128)).toThrow();
    unlinkSync(path);
    writeFileSync(path, "{}", { mode: 0o600 });
    chmodSync(path, 0o644);
    expect(() => store.read("manifest.signed.json", 128)).toThrow();
    chmodSync(path, 0o600);
    writeFileSync(path, "x".repeat(129));
    expect(() => store.read("manifest.signed.json", 128)).toThrow();
  } finally {
    store.close();
  }
  expect(() => store.read("manifest.signed.json", 128)).toThrow();
});

test("directory replacement does not redirect an anchored read", () => {
  const f = fixture();
  const other = fixture();
  writeFileSync(join(f.directory, "manifest.signed.json"), "original", { mode: 0o600 });
  writeFileSync(join(other.directory, "manifest.signed.json"), "replacement", { mode: 0o600 });
  const store = openKaraokePrivateArtifacts(f.directory);
  const moved = join(other.directory, "moved");
  try {
    renameSync(f.directory, moved);
    symlinkSync(other.directory, f.directory);
    expect(store.read("manifest.signed.json", 128)).toBe("original");
    expect(() => openKaraokePrivateArtifacts(f.directory)).toThrow();
  } finally {
    store.close();
    unlinkSync(f.directory);
  }
});
