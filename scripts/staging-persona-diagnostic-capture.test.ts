import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureDiagnosticFailure } from "./staging-persona-diagnostic-capture.ts";
import { assertDiagnosticStopBeforeApply } from "./staging-persona-phased-removal.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "diagnostic-capture-"));
  chmodSync(root, 0o700);
  const branch = join(root, "branch-id");
  mkdirSync(branch, { mode: 0o700 });
  return { root, branch, evidence: join(branch, "evidence") };
}

const capture = (trustedRoot: string, evidenceDirectory: string, message = "hidden") =>
  captureDiagnosticFailure({
    trustedRoot,
    evidenceDirectory,
    error: new Error(message, { cause: new Error("underlying provider detail") }),
  });

test("the diagnostic capture writes the raw error chain owner-only", () => {
  const { root, branch, evidence } = fixture();
  const path = capture(root, evidence, "the hidden first-batch message");
  expect(path).not.toBeNull();
  expect(statSync(path as string).mode & 0o777).toBe(0o600);
  expect(statSync(evidence).mode & 0o077).toBe(0);
  const text = readFileSync(path as string, "utf8");
  expect(text).toContain("the hidden first-batch message");
  expect(text).toContain("underlying provider detail");
  expect(branch).toBe(join(root, "branch-id"));
  rmSync(root, { recursive: true, force: true });
});

test("the diagnostic capture refuses to overwrite an existing capture", () => {
  const { root, evidence } = fixture();
  expect(capture(root, evidence, "first")).not.toBeNull();
  expect(capture(root, evidence, "second")).toBeNull();
  rmSync(root, { recursive: true, force: true });
});

test("a parent symlink cannot redirect the capture", () => {
  const { root } = fixture();
  const outside = mkdtempSync(join(tmpdir(), "diagnostic-outside-"));
  const linked = join(root, "branch-id");
  rmSync(linked, { recursive: true, force: true });
  symlinkSync(outside, linked);
  expect(capture(root, join(linked, "evidence"))).toBeNull();
  expect(existsSync(join(outside, "evidence", "diagnostic-failure.txt"))).toBe(false);
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("a leaf symlinked evidence directory cannot redirect the capture", () => {
  const { root, branch, evidence } = fixture();
  const outside = mkdtempSync(join(tmpdir(), "diagnostic-outside-"));
  symlinkSync(outside, evidence);
  expect(capture(root, evidence)).toBeNull();
  expect(existsSync(join(outside, "diagnostic-failure.txt"))).toBe(false);
  expect(branch).toBe(join(root, "branch-id"));
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("a permissive evidence directory is refused rather than tightened", () => {
  const { root, evidence } = fixture();
  mkdirSync(evidence, { mode: 0o700 });
  chmodSync(evidence, 0o777);
  expect(capture(root, evidence)).toBeNull();
  expect(statSync(evidence).mode & 0o777).toBe(0o777);
  expect(existsSync(join(evidence, "diagnostic-failure.txt"))).toBe(false);
  rmSync(root, { recursive: true, force: true });
});

test("an existing non-exclusive file is refused", () => {
  const { root, evidence } = fixture();
  mkdirSync(evidence, { mode: 0o700 });
  writeFileSync(join(evidence, "diagnostic-failure.txt"), "foreign", { mode: 0o600 });
  expect(capture(root, evidence)).toBeNull();
  expect(readFileSync(join(evidence, "diagnostic-failure.txt"), "utf8")).toBe("foreign");
  rmSync(root, { recursive: true, force: true });
});

test("an evidence directory outside the trusted root is refused", () => {
  const { root } = fixture();
  const outside = mkdtempSync(join(tmpdir(), "diagnostic-outside-"));
  chmodSync(outside, 0o700);
  expect(capture(root, outside)).toBeNull();
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("the diagnostic stop refuses only when the flag is present", () => {
  expect(() => assertDiagnosticStopBeforeApply(undefined)).not.toThrow();
  expect(() => assertDiagnosticStopBeforeApply(false)).not.toThrow();
  expect(() => assertDiagnosticStopBeforeApply(true)).toThrow("diagnostic_stop_before_first_apply");
});
