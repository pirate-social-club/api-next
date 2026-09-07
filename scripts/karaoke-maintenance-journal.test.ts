import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconciliationDigest } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import { KARAOKE_RESET_OBJECT_IDS } from "../packages/platform-cf/src/karaoke-reset-installation.ts";
import {
  appendKaraokeMaintenanceEvent,
  type KaraokeJournalTrust,
  readKaraokeMaintenanceJournal,
} from "./karaoke-maintenance-journal.ts";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "karaoke-journal-test-"));
  chmodSync(directory, 0o700);
  directories.push(directory);
  const keys = generateKeyPairSync("ed25519");
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const trust: KaraokeJournalTrust = {
    directory,
    publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    epoch: "a".repeat(64),
    collectorSourceDigest: "b".repeat(64),
    expectedHead: null,
  };
  const artifact = JSON.stringify({ fixture: "provider-boundary-observation" });
  const evidenceId = reconciliationDigest(artifact);
  const time = "2026-09-07T10:00:00.000Z";
  const append = (event: Parameters<typeof appendKaraokeMaintenanceEvent>[0]["event"]) =>
    appendKaraokeMaintenanceEvent({
      trust,
      privateKeyPem,
      observedAt: time,
      event,
      artifacts: [artifact],
    });
  return { trust, privateKeyPem, artifact, evidenceId, time, append };
}

test("retains a signed chain and per-object history without granting execution", () => {
  const f = fixture();
  const first = f.append({ kind: "begin", evidenceIds: [f.evidenceId] });
  f.append({ kind: "fence-observed", evidenceIds: [f.evidenceId] });
  const result = f.append({
    kind: "pass",
    objectId: KARAOKE_RESET_OBJECT_IDS[0],
    receiptId: f.evidenceId,
    evidenceIds: [f.evidenceId],
  });
  const read = readKaraokeMaintenanceJournal(
    { ...f.trust, expectedHead: { entryId: first.head.entryId, sequence: 0 } },
    f.time,
  );
  expect(read.entries.length).toBe(3);
  expect(read.history[KARAOKE_RESET_OBJECT_IDS[0]]).toEqual([f.evidenceId]);
  expect(result.executionAuthorized).toBe(false);
});

test("refuses release before retirement without changing the head", () => {
  const f = fixture();
  f.append({ kind: "begin", evidenceIds: [f.evidenceId] });
  f.append({ kind: "fence-observed", evidenceIds: [f.evidenceId] });
  const before = readFileSync(join(f.trust.directory, "manifest.signed.json"), "utf8");
  expect(() => f.append({ kind: "released", evidenceIds: [f.evidenceId] })).toThrow(
    "release_denied",
  );
  expect(readFileSync(join(f.trust.directory, "manifest.signed.json"), "utf8")).toBe(before);
  expect(() => f.append({ kind: "all-retired", evidenceIds: [f.evidenceId] })).toThrow(
    "retirement_denied",
  );
  f.append({ kind: "reset-verified", evidenceIds: [f.evidenceId] });
  f.append({ kind: "all-retired", evidenceIds: [f.evidenceId] });
  expect(f.append({ kind: "released", evidenceIds: [f.evidenceId] }).state).toBe("released");
  expect(() => f.append({ kind: "fence-observed", evidenceIds: [f.evidenceId] })).toThrow(
    "release_monotonic",
  );
});

test("refuses rollback below independently retained head and changed evidence", () => {
  const f = fixture();
  f.append({ kind: "begin", evidenceIds: [f.evidenceId] });
  const old = readFileSync(join(f.trust.directory, "manifest.signed.json"), "utf8");
  const latest = f.append({ kind: "fence-observed", evidenceIds: [f.evidenceId] });
  writeFileSync(join(f.trust.directory, "manifest.signed.json"), old);
  expect(() =>
    readKaraokeMaintenanceJournal(
      { ...f.trust, expectedHead: { entryId: latest.head.entryId, sequence: 1 } },
      f.time,
    ),
  ).toThrow("rollback_denied");
  writeFileSync(join(f.trust.directory, `${f.evidenceId}.json`), "{}");
  expect(() => readKaraokeMaintenanceJournal(f.trust, f.time)).toThrow("artifact_denied");
});

test("refuses missing committed entries, wrong keys, future times and orphan initialization", () => {
  const f = fixture();
  const first = f.append({ kind: "begin", evidenceIds: [f.evidenceId] });
  const wrong = fixture();
  expect(() =>
    readKaraokeMaintenanceJournal({ ...f.trust, publicKeyPem: wrong.trust.publicKeyPem }, f.time),
  ).toThrow("signature_denied");
  expect(() => readKaraokeMaintenanceJournal(f.trust, "2026-09-06T10:00:00.000Z")).toThrow(
    "entry_denied",
  );
  rmSync(join(f.trust.directory, `${first.head.entryId}.json`));
  expect(() => f.append({ kind: "begin", evidenceIds: [f.evidenceId] })).toThrow();
  const orphan = fixture();
  writeFileSync(join(orphan.trust.directory, `${orphan.evidenceId}.json`), orphan.artifact, {
    mode: 0o600,
  });
  expect(() => orphan.append({ kind: "begin", evidenceIds: [orphan.evidenceId] })).toThrow();
});

test("a broken fence cannot silently become held again", () => {
  const f = fixture();
  f.append({ kind: "begin", evidenceIds: [f.evidenceId] });
  expect(f.append({ kind: "fence-broken", evidenceIds: [f.evidenceId] }).state).toBe("broken");
  expect(() => f.append({ kind: "fence-observed", evidenceIds: [f.evidenceId] })).toThrow(
    "journal_broken",
  );
});
