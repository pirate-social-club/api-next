import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  EVIDENCE_ROOT,
  JOURNAL_DIR,
  OPERATION_DIR,
  SOURCE_DIRECTORY,
} from "./production-release-paths.ts";
import { assertCommittedToolingSource, checkSourceManifest } from "./production-source-binding.ts";

export { checkSourceManifest, JOURNAL_DIR, OPERATION_DIR };
export const PACKAGE = SOURCE_DIRECTORY;
export const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export const fileHash = (path: string | URL) => hash(readFileSync(path));
const syncDirectory = (path: string) => {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

export function directoryIdentity(path: string) {
  const stat = lstatSync(path, { bigint: true });
  assert.ok(
    stat.isDirectory() && !stat.isSymbolicLink(),
    "Evidence directory is not a real directory",
  );
  assert.equal(realpathSync(path), path.replace(/\/$/u, ""), "Evidence directory path changed");
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    birthtime_ns: stat.birthtimeNs.toString(),
  };
}

/** Complete or absent: a crash before link leaves only an unrecognized temporary file. */
export function exclusiveRecord(directory: string, name: string, value: unknown) {
  assert.match(name, /^[a-z0-9][a-z0-9.-]*\.json$/u);
  directoryIdentity(directory);
  const temporary = join(directory, ".record-" + randomUUID());
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeSync(fd, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(temporary, join(directory, name));
    syncDirectory(directory);
  } finally {
    if (fd !== undefined) closeSync(fd);
    // Only this invocation's private temporary file is removed; durable evidence never is.
    if (existsSync(temporary)) {
      unlinkSync(temporary);
      syncDirectory(directory);
    }
  }
}

export function inspectRecord(name: string) {
  assert.match(name, /^[a-z0-9][a-z0-9.-]*\.json$/u);
  const path = join(OPERATION_DIR, name);
  if (!existsSync(path)) return { state: "absent" as const, name };
  try {
    const stat = lstatSync(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    const bytes = readFileSync(path);
    const value = JSON.parse(bytes.toString("utf8"));
    assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
    return { state: "complete" as const, name, sha256: hash(bytes), value };
  } catch {
    return { state: "unreadable" as const, name };
  }
}

export function record(name: string): any | undefined {
  const observed = inspectRecord(name);
  assert.notEqual(observed.state, "unreadable", "Malformed evidence: " + name);
  return observed.state === "complete" ? observed.value : undefined;
}
export function recordDigest(name: string) {
  const observed = inspectRecord(name);
  assert.equal(observed.state, "complete", "Missing complete evidence: " + name);
  return observed.state === "complete" ? observed.sha256 : "";
}
export const save = (name: string, value: unknown) => exclusiveRecord(OPERATION_DIR, name, value);

/** Read mode can diagnose missing, torn and foreign files without initializing or repairing evidence. */
export function evidenceDiagnostics() {
  if (!existsSync(OPERATION_DIR)) return { directory: "missing", records: [] };
  try {
    const identity = directoryIdentity(OPERATION_DIR);
    return {
      directory: "present",
      identity,
      records: readdirSync(OPERATION_DIR)
        .filter((name) => name.endsWith(".json"))
        .map((name) => {
          const observed = inspectRecord(name);
          return {
            state: observed.state,
            name,
            ...(observed.state === "complete" ? { sha256: observed.sha256 } : {}),
          };
        }),
    };
  } catch {
    return { directory: "unreadable", records: [] };
  }
}

/** Local initialization has its own reviewed root request, before any whole operational review exists. */
export function initializeOperation(requestPath: string) {
  const request = JSON.parse(readFileSync(requestPath, "utf8"));
  assert.equal(request.kind, "website-release-evidence-initialization-v1");
  assert.equal(request.resource_owner_role, "website_launch_coordinator");
  assert.equal(request.accepted, true);
  assert.equal(request.reviewer_role, "independent_reviewer");
  assert.deepEqual(request.findings, []);
  assert.equal(request.evidence_root, EVIDENCE_ROOT);
  assert.equal(request.adapter_manifest_sha256, checkSourceManifest());
  assertCommittedToolingSource(request);
  assert.ok(
    !existsSync(OPERATION_DIR) && !existsSync(JOURNAL_DIR),
    "Evidence already initialized or partly initialized; preserve and review",
  );
  if (!existsSync(EVIDENCE_ROOT)) {
    mkdirSync(EVIDENCE_ROOT, { mode: 0o700 });
    syncDirectory(dirname(EVIDENCE_ROOT.replace(/\/$/u, "")));
  }
  directoryIdentity(EVIDENCE_ROOT);
  for (const directory of [OPERATION_DIR, JOURNAL_DIR]) {
    mkdirSync(directory, { mode: 0o700 });
    syncDirectory(dirname(directory.replace(/\/$/u, "")));
  }
  const genesis = {
    kind: "website-release-evidence-genesis-v1",
    at: new Date().toISOString(),
    initialization_request_sha256: fileHash(requestPath),
    operation: directoryIdentity(OPERATION_DIR),
    journal: directoryIdentity(JOURNAL_DIR),
  };
  exclusiveRecord(OPERATION_DIR, "genesis.json", genesis);
  exclusiveRecord(JOURNAL_DIR, "genesis.json", genesis);
  return { ...genesis, genesis_sha256: recordDigest("genesis.json") };
}

export function validateGenesisIdentity(
  operation: unknown,
  journal: unknown,
  operationSha: string,
  journalSha: string,
  expected: any,
) {
  assert.deepEqual(operation, expected.operation);
  assert.deepEqual(journal, expected.journal);
  assert.equal(operationSha, expected.genesis_sha256);
  assert.equal(journalSha, expected.genesis_sha256);
}
export function checkGenesis(review: any) {
  assert.ok(
    existsSync(OPERATION_DIR) && existsSync(JOURNAL_DIR),
    "Initialized evidence directory is missing; recreation is forbidden",
  );
  validateGenesisIdentity(
    directoryIdentity(OPERATION_DIR),
    directoryIdentity(JOURNAL_DIR),
    recordDigest("genesis.json"),
    fileHash(join(JOURNAL_DIR, "genesis.json")),
    review.evidence_identity,
  );
}

export function acceptedExecutor(row: any, current: string, review: any, label: string) {
  const predecessors = review.predecessor_executor_sha256s ?? [];
  assert.ok(
    Array.isArray(predecessors) &&
      predecessors.every(
        (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value),
      ),
  );
  assert.ok(
    row.executor_sha256 === current || predecessors.includes(row.executor_sha256),
    "Unaccepted predecessor executor: " + label,
  );
}

/** The fixed SQL executor supplies observed immutable records; this function never reads or writes state. */
export function validateGrantPhaseState(
  observed: { started: any; done: any; sent: any; resolved: any; attemptSha256: string },
  expected: Record<string, unknown>,
  executor: string,
  review: any,
  phase: string,
): "none" | "unresolved" | "committed" | "resolved_not_committed" {
  const { started, done, sent, resolved, attemptSha256 } = observed;
  assert.ok(started || (!done && !sent && !resolved), "Downstream plan evidence lacks attempt");
  for (const value of [started, done])
    if (value) {
      for (const [key, expectedValue] of Object.entries(expected))
        assert.deepEqual(value[key], expectedValue, "Foreign plan record: " + phase + "." + key);
      acceptedExecutor(value, executor, review, phase);
    }
  if (done) {
    assert.ok(sent, "Committed plan lacks COMMIT-sent evidence");
    assert.equal(done.attempt_sha256, attemptSha256);
  }
  if (sent) {
    assert.equal(sent.attempt_sha256, attemptSha256);
    acceptedExecutor(sent, executor, review, phase);
  }
  if (resolved?.conclusion === "committed") return "committed";
  if (resolved?.conclusion === "not_committed") {
    assert.ok(!done, "Committed receipt conflicts with a no-commit resolution");
    return "resolved_not_committed";
  }
  return done ? "committed" : started ? "unresolved" : "none";
}

export function validateResolutionData(
  value: any,
  approved: any,
  attemptSha: string,
  recordSha: string,
  receiptSha: string,
) {
  assert.ok(approved, "Resolution lacks independent review");
  assert.equal(recordSha, approved.record_sha256);
  assert.equal(value.attempt_sha256, attemptSha);
  assert.equal(value.read_only_evidence_sha256, approved.read_only_evidence_sha256);
  assert.equal(receiptSha, approved.read_only_evidence_sha256);
  assert.equal(value.conclusion, approved.conclusion);
  assert.ok(
    ["committed", "not_committed", "candidate_verified", "baseline_unchanged"].includes(
      value.conclusion,
    ),
  );
  assert.equal(approved.accepted, true);
  assert.equal(approved.reviewer_role, "independent_reviewer");
  assert.deepEqual(approved.findings, []);
}
/** Resolution is new evidence, never an edit/reset; independent review binds attempt and real read-only result. */
export function resolution(phase: string, attempt: string, review: any) {
  const name = phase + "-resolution.json",
    value = record(name);
  if (!value) return undefined;
  const approved = review.resolutions?.[phase];
  assert.ok(approved, "Resolution lacks independent review");
  validateResolutionData(
    value,
    approved,
    recordDigest(attempt),
    recordDigest(name),
    fileHash(approved.read_only_evidence_path),
  );
  return value;
}

export function writeResolution(requestPath: string, review: any) {
  const requestBytes = readFileSync(requestPath, "utf8");
  const request = JSON.parse(requestBytes);
  assert.equal(
    requestBytes,
    JSON.stringify(request, null, 2) + "\n",
    "Resolution bytes must use the immutable record serialization",
  );
  const approved = review.resolutions?.[request.phase];
  assert.ok(approved, "Resolution request not reviewed");
  validateResolutionData(
    request,
    approved,
    recordDigest(request.attempt_name),
    fileHash(requestPath),
    fileHash(approved.read_only_evidence_path),
  );
  save(request.phase + "-resolution.json", request);
}
