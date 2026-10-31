import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acceptedExecutor, directoryIdentity, exclusiveRecord, fileHash, validateGenesisIdentity, validateGrantPhaseState, validateResolutionData } from "./production-operation-evidence.ts";

test("exclusive evidence publication preserves complete prior bytes and rejects directory symlinks", () => {
  const directory = mkdtempSync(join(tmpdir(), "production-evidence-"));
  try {
    exclusiveRecord(directory, "attempt.json", { kind: "synthetic-attempt", value: 1 });
    const before = readFileSync(join(directory, "attempt.json"), "utf8");
    expect(() => exclusiveRecord(directory, "attempt.json", { value: 2 })).toThrow();
    expect(readFileSync(join(directory, "attempt.json"), "utf8")).toBe(before);
    expect(JSON.parse(before)).toEqual({ kind: "synthetic-attempt", value: 1 });
    mkdirSync(join(directory, "actual")); symlinkSync(join(directory, "actual"), join(directory, "alias"));
    expect(() => exclusiveRecord(join(directory, "alias"), "escape.json", {})).toThrow();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("genesis binding rejects replacement directory and altered complete evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "production-genesis-")), operation = join(root, "operation"), journal = join(root, "journal");
  try {
    mkdirSync(operation); mkdirSync(journal);
    exclusiveRecord(operation, "genesis.json", { kind: "synthetic-genesis" }); exclusiveRecord(journal, "genesis.json", { kind: "synthetic-genesis" });
    const expected = { operation: directoryIdentity(operation), journal: directoryIdentity(journal), genesis_sha256: fileHash(join(operation, "genesis.json")) };
    validateGenesisIdentity(directoryIdentity(operation), directoryIdentity(journal), fileHash(join(operation, "genesis.json")), fileHash(join(journal, "genesis.json")), expected);
    expect(() => validateGenesisIdentity(directoryIdentity(operation), directoryIdentity(journal), "0".repeat(64), expected.genesis_sha256, expected)).toThrow();
    rmSync(operation, { recursive: true }); mkdirSync(operation);
    expect(() => validateGenesisIdentity(directoryIdentity(operation), directoryIdentity(journal), expected.genesis_sha256, expected.genesis_sha256, expected)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("resolution and predecessor acceptance bind exact immutable lineage", () => {
  const attempt = "a".repeat(64), record = "b".repeat(64), receipt = "c".repeat(64), executor = "d".repeat(64);
  const value = { attempt_sha256: attempt, read_only_evidence_sha256: receipt, conclusion: "not_committed" };
  const approved = { record_sha256: record, read_only_evidence_sha256: receipt, conclusion: "not_committed", accepted: true, reviewer_role: "independent_reviewer", findings: [] };
  validateResolutionData(value, approved, attempt, record, receipt);
  expect(() => validateResolutionData(value, approved, "0".repeat(64), record, receipt)).toThrow();
  expect(() => validateResolutionData(value, approved, attempt, record, "0".repeat(64))).toThrow();
  expect(() => validateResolutionData({ ...value, conclusion: "retry_anything" }, approved, attempt, record, receipt)).toThrow();
  acceptedExecutor({ executor_sha256: executor }, "0".repeat(64), { predecessor_executor_sha256s: [executor] }, "fixture");
  expect(() => acceptedExecutor({ executor_sha256: executor }, "0".repeat(64), { predecessor_executor_sha256s: [] }, "fixture")).toThrow();
});

test("actual grant lifecycle distinguishes unsent, COMMIT-sent, complete and independently resolved outcomes", () => {
  const executor = "d".repeat(64), attemptSha256 = "a".repeat(64), expected = { source: "fixture-source", role: "fixture-runtime", phase: "browser", plan_file_sha256: "b".repeat(64) };
  const started = { ...expected, executor_sha256: executor }, sent = { executor_sha256: executor, attempt_sha256: attemptSha256 };
  const done = { ...started, attempt_sha256: attemptSha256 }, review = { predecessor_executor_sha256s: [executor] };
  const state = (fields: { started?: unknown; sent?: unknown; done?: unknown; resolved?: unknown }) => validateGrantPhaseState({ started: undefined, sent: undefined, done: undefined, resolved: undefined, attemptSha256, ...fields }, expected, "0".repeat(64), review, "browser");
  expect(state({})).toBe("none"); expect(state({ started })).toBe("unresolved");
  expect(state({ started, sent })).toBe("unresolved"); expect(state({ started, sent, done })).toBe("committed");
  expect(state({ started, sent, resolved: { conclusion: "committed" } })).toBe("committed");
  expect(state({ started, sent, resolved: { conclusion: "not_committed" } })).toBe("resolved_not_committed");
  expect(() => state({ done, sent })).toThrow(); expect(() => state({ started, done })).toThrow();
  expect(() => state({ started, sent: { ...sent, attempt_sha256: "0".repeat(64) } })).toThrow();
  expect(() => state({ started, sent, done: { ...done, source: "foreign" } })).toThrow();
  expect(() => state({ started, sent, done, resolved: { conclusion: "not_committed" } })).toThrow();
  expect(() => state({ started: { ...started, executor_sha256: "1".repeat(64) } })).toThrow();
});
