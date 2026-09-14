import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";

/** Owner-only capture for the authorized diagnostic run.
 *
 * The shared failure describer redacts anything that is not an allowlisted
 * literal, which left the r13/r14 failure unnamed. Under the owner's explicit
 * diagnostic authorization only, the raw error chain is written to one file
 * beneath the branch evidence directory with mode 0600: it never reaches
 * stdout, the execution log, a receipt, a task record or any published
 * package.
 *
 * Redirection is refused rather than followed. Every component from the
 * trusted root to the evidence directory must be a real directory (no
 * symlinks), owned by the current user, with no group or other bits; the leaf
 * file is opened exclusiely and without following a symlink. Any untrusted
 * path, an existing file, or a filesystem failure returns null so the caller's
 * original failure path is untouched.
 */
export type DiagnosticCaptureInput = {
  /** The control-plane state root the evidence directory must live under. */
  readonly trustedRoot: string;
  /** The branch evidence directory; must be below `trustedRoot`. */
  readonly evidenceDirectory: string;
  readonly error: unknown;
};

function trustedDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid?.() &&
      (stat.mode & 0o077) === 0
    );
  } catch {
    return false;
  }
}

function errorChain(error: unknown): string {
  const chain: string[] = [];
  let current: unknown = error;
  let depth = 0;
  while (current !== null && current !== undefined && depth < 8) {
    if (current instanceof Error) {
      chain.push(`[${depth}] ${current.name}: ${current.message}\n${current.stack ?? ""}`);
      current = (current as { cause?: unknown }).cause;
    } else {
      chain.push(`[${depth}] ${typeof current}: ${String(current)}`);
      break;
    }
    depth += 1;
  }
  return `${chain.join("\n\n")}\n`;
}

export function captureDiagnosticFailure(input: DiagnosticCaptureInput): string | null {
  try {
    const root = resolve(input.trustedRoot);
    const evidence = resolve(input.evidenceDirectory);
    if (!evidence.startsWith(`${root}${sep}`)) return null;
    if (!trustedDirectory(root)) return null;
    const relative = evidence.slice(root.length + 1).split(sep);
    if (relative.some((part) => part.length === 0 || part === "." || part === "..")) return null;
    let current = root;
    for (const part of relative) {
      current = join(current, part);
      if (!existsSync(current)) {
        // The launcher creates the branch and evidence directories; only the
        // final component may be created here, under a verified parent.
        if (current !== evidence) return null;
        mkdirSync(current, { mode: 0o700 });
      }
      if (!trustedDirectory(current)) return null;
    }
    const path = join(evidence, "diagnostic-failure.txt");
    const descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(descriptor, errorChain(input.error));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    return path;
  } catch {
    return null;
  }
}
