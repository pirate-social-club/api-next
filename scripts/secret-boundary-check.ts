/**
 * Trusted pull request secret boundary check.
 *
 * This module is executed from base branch code only. It never checks out and
 * never executes pull request code: it reads changed file contents through the
 * GitHub API and asserts the invariants that keep credential-bearing automation
 * from being turned into a secret exfiltration path by an unreviewed change.
 */

export type ChangedFileStatus =
  | "added"
  | "changed"
  | "copied"
  | "modified"
  | "removed"
  | "renamed"
  | "unchanged";

export type ChangedFile = Readonly<{
  path: string;
  status: ChangedFileStatus;
  previousPath?: string;
  contentsUrl?: string;
}>;

export type BoundaryViolationKind =
  | "changed-file-list-truncated"
  | "content-unavailable"
  | "credential-workflow-trigger"
  | "guarded-file-modified"
  | "pull-request-secret-exposure"
  | "pull-request-target-workflow"
  | "required-file-removed"
  | "secret-value-exposure"
  | "secret-value-guard-removed"
  | "unpinned-action"
  | "unscoped-id-token";

export type BoundaryViolation = Readonly<{
  kind: BoundaryViolationKind;
  path: string;
  reason: string;
}>;

/** Files the check depends on. A pull request may never touch them. */
export const GUARDED_PATHS: readonly string[] = [
  ".github/workflows/secret-boundary.yml",
  "scripts/secret-boundary-check.ts",
  "scripts/secret-boundary-check.test.ts",
];

/** Workflows that receive real credentials and must never run on pull requests. */
export const CREDENTIAL_WORKFLOW_PATHS: readonly string[] = [".github/workflows/secret-drift.yml"];

export const CREDENTIAL_WORKFLOW_ALLOWED_TRIGGERS: readonly string[] = [
  "push",
  "schedule",
  "workflow_dispatch",
];

/** Scripts that hold an Infisical token and must only ever read secret names. */
export const SECRET_READING_SCRIPT_PATHS: readonly string[] = [
  "scripts/infisical-secret-drift-audit.ts",
];

export const REQUIRED_SECRET_REQUEST_LITERALS: readonly string[] = [
  'viewSecretValue: "false"',
  'expandSecretReferences: "false"',
];

const REQUIRED_PATHS: readonly string[] = [
  ...CREDENTIAL_WORKFLOW_PATHS,
  ...SECRET_READING_SCRIPT_PATHS,
];

const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const SCRIPT_PATH = /^scripts\/[^\0]*\.(?:ts|mjs|js)$/;
const TEST_PATH = /\.test\.[^.]+$/;
const COMMIT_PIN = /^[0-9a-f]{40}$/;

export function isWorkflowPath(path: string): boolean {
  return WORKFLOW_PATH.test(path);
}

export function isAuditableScriptPath(path: string): boolean {
  return SCRIPT_PATH.test(path) && !TEST_PATH.test(path);
}

/**
 * Paths whose head-side content the check has to read to reach a verdict.
 * Guarded paths are excluded: touching one is already a verdict on its own.
 */
export function pathsRequiringContent(files: readonly ChangedFile[]): readonly string[] {
  return files
    .filter((file) => file.status !== "removed")
    .map((file) => file.path)
    .filter((path) => !GUARDED_PATHS.includes(path))
    .filter((path) => isWorkflowPath(path) || isAuditableScriptPath(path));
}

type YamlLine = Readonly<{ indent: number; text: string }>;

function significantLines(content: string): readonly YamlLine[] {
  return content
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith("#"))
    .map((line) => ({ indent: line.length - line.trimStart().length, text: line.trim() }));
}

function unquote(value: string): string {
  return value.replace(/^["']/, "").replace(/["']$/, "");
}

function topLevelBlock(lines: readonly YamlLine[], keys: readonly string[]): readonly YamlLine[] {
  const start = lines.findIndex(
    (line) => line.indent === 0 && keys.some((key) => line.text.startsWith(`${key}:`)),
  );
  if (start === -1) return [];
  const block: YamlLine[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.indent === 0) break;
    block.push(line);
  }
  return [lines[start] as YamlLine, ...block];
}

export function workflowTriggers(content: string): readonly string[] {
  const section = topLevelBlock(significantLines(content), ["on", '"on"', "'on'"]);
  const header = section[0];
  if (header === undefined) return [];
  const inline = header.text.slice(header.text.indexOf(":") + 1).trim();
  if (inline.length > 0) {
    return inline
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .split(",")
      .map((entry) => unquote(entry.trim()))
      .filter((entry) => entry.length > 0);
  }
  const nested = section.slice(1);
  const depth = nested[0]?.indent;
  if (depth === undefined) return [];
  return nested
    .filter((line) => line.indent === depth)
    .map((line) => unquote(line.text.replace(/^-\s*/, "").replace(/:.*$/, "").trim()))
    .filter((entry) => entry.length > 0);
}

export function hasTopLevelIdTokenWrite(content: string): boolean {
  const section = topLevelBlock(significantLines(content), ["permissions"]);
  const header = section[0];
  if (header === undefined) return false;
  if (/^permissions:\s*write-all/.test(header.text)) return true;
  return section.slice(1).some((line) => /^id-token:\s*write\b/.test(line.text));
}

export function referencedSecretNames(content: string): readonly string[] {
  const names = new Set<string>();
  for (const match of content.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) {
    const name = match[1];
    if (name !== undefined && name !== "GITHUB_TOKEN") names.add(name);
  }
  for (const match of content.matchAll(/secrets\[\s*["']([^"']+)["']/g)) {
    const name = match[1];
    if (name !== undefined && name !== "GITHUB_TOKEN") names.add(name);
  }
  return [...names].sort();
}

export function actionReferences(content: string): readonly string[] {
  return significantLines(content)
    .map((line) => /^-?\s*uses:\s*(\S+)/.exec(line.text)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(unquote);
}

function isPinnedAction(reference: string): boolean {
  if (reference.startsWith("./") || reference.startsWith("docker://")) return true;
  const separator = reference.lastIndexOf("@");
  if (separator === -1) return false;
  return COMMIT_PIN.test(reference.slice(separator + 1));
}

function auditWorkflowContent(path: string, content: string): readonly BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const triggers = workflowTriggers(content);

  if (triggers.includes("pull_request_target")) {
    violations.push({
      kind: "pull-request-target-workflow",
      path,
      reason:
        "Only the guarded secret-boundary workflow may use pull_request_target: it runs base branch code with repository write context.",
    });
  }

  const pullRequestTriggered = triggers.some(
    (trigger) => trigger === "pull_request" || trigger === "pull_request_target",
  );
  if (pullRequestTriggered) {
    const secretNames = referencedSecretNames(content);
    if (secretNames.length > 0) {
      violations.push({
        kind: "pull-request-secret-exposure",
        path,
        reason: `Pull request triggered workflow references repository secrets: ${secretNames.join(", ")}.`,
      });
    }
    if (/id-token:\s*write\b/.test(content)) {
      violations.push({
        kind: "pull-request-secret-exposure",
        path,
        reason: "Pull request triggered workflow requests an OIDC token (id-token: write).",
      });
    }
  }

  if (hasTopLevelIdTokenWrite(content)) {
    violations.push({
      kind: "unscoped-id-token",
      path,
      reason: "id-token: write must be scoped to the job that needs it, not granted workflow wide.",
    });
  }

  for (const reference of actionReferences(content)) {
    if (isPinnedAction(reference)) continue;
    violations.push({
      kind: "unpinned-action",
      path,
      reason: `Action "${reference}" is not pinned to a full 40 character commit SHA.`,
    });
  }

  if (CREDENTIAL_WORKFLOW_PATHS.includes(path)) {
    for (const trigger of triggers) {
      if (CREDENTIAL_WORKFLOW_ALLOWED_TRIGGERS.includes(trigger)) continue;
      violations.push({
        kind: "credential-workflow-trigger",
        path,
        reason: `Credential bearing workflow may only trigger on ${CREDENTIAL_WORKFLOW_ALLOWED_TRIGGERS.join(", ")}; found "${trigger}".`,
      });
    }
  }

  return violations;
}

function auditScriptContent(path: string, content: string): readonly BoundaryViolation[] {
  const readsInfisicalSecrets =
    /viewSecretValue|expandSecretReferences|"\/secrets"|\/v\d+\/secrets/.test(content);
  if (!readsInfisicalSecrets && !SECRET_READING_SCRIPT_PATHS.includes(path)) return [];

  const violations: BoundaryViolation[] = [];
  for (const literal of REQUIRED_SECRET_REQUEST_LITERALS) {
    if (content.includes(literal)) continue;
    violations.push({
      kind: "secret-value-guard-removed",
      path,
      reason: `Infisical secret listing must keep the literal ${literal}.`,
    });
  }
  if (
    /viewSecretValue:\s*"true"/.test(content) ||
    /expandSecretReferences:\s*"true"/.test(content)
  ) {
    violations.push({
      kind: "secret-value-exposure",
      path,
      reason: "Infisical secret listing must never request secret values or expanded references.",
    });
  }
  if (/\bsecretValue\b/.test(content)) {
    violations.push({
      kind: "secret-value-exposure",
      path,
      reason: "Audit code must not read the secretValue field returned by Infisical.",
    });
  }
  return violations;
}

export function auditSecretBoundary(input: {
  readonly files: readonly ChangedFile[];
  readonly contents: ReadonlyMap<string, string>;
  readonly truncated?: boolean;
}): readonly BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];

  if (input.truncated === true) {
    violations.push({
      kind: "changed-file-list-truncated",
      path: "*",
      reason: "The pull request changes too many files for the boundary check to inspect them all.",
    });
  }

  for (const file of input.files) {
    for (const path of [file.path, file.previousPath]) {
      if (path === undefined || !GUARDED_PATHS.includes(path)) continue;
      violations.push({
        kind: "guarded-file-modified",
        path,
        reason: "The secret boundary check may not be changed by the pull request it is checking.",
      });
    }
    const vanished =
      file.status === "removed"
        ? file.path
        : file.previousPath !== undefined && file.previousPath !== file.path
          ? file.previousPath
          : undefined;
    if (vanished !== undefined && REQUIRED_PATHS.includes(vanished)) {
      violations.push({
        kind: "required-file-removed",
        path: vanished,
        reason: "This file carries the secret boundary contract and may not be removed or renamed.",
      });
    }
  }

  for (const path of pathsRequiringContent(input.files)) {
    const content = input.contents.get(path);
    if (content === undefined) {
      violations.push({
        kind: "content-unavailable",
        path,
        reason: "The boundary check could not read this file at the pull request head commit.",
      });
      continue;
    }
    if (isWorkflowPath(path)) violations.push(...auditWorkflowContent(path, content));
    if (isAuditableScriptPath(path)) violations.push(...auditScriptContent(path, content));
  }

  return violations;
}

export type GitHubRequest = (input: string, init: RequestInit) => Promise<Response>;

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

function apiHeaders(token: string, accept: string): Record<string, string> {
  return {
    accept,
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
  };
}

function parseChangedFile(entry: unknown): ChangedFile {
  if (typeof entry !== "object" || entry === null) throw new Error("Malformed pull request file");
  const record = entry as Record<string, unknown>;
  const path = record.filename;
  const status = record.status;
  if (typeof path !== "string" || typeof status !== "string") {
    throw new Error("Pull request file entry has no filename or status");
  }
  return {
    path,
    status: status as ChangedFileStatus,
    ...(typeof record.previous_filename === "string"
      ? { previousPath: record.previous_filename }
      : {}),
    ...(typeof record.contents_url === "string" ? { contentsUrl: record.contents_url } : {}),
  };
}

export async function listPullRequestFiles(input: {
  readonly apiUrl: string;
  readonly repository: string;
  readonly pullNumber: number;
  readonly token: string;
  readonly request?: GitHubRequest;
}): Promise<Readonly<{ files: readonly ChangedFile[]; truncated: boolean }>> {
  const request = input.request ?? fetch;
  const files: ChangedFile[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = `${input.apiUrl}/repos/${input.repository}/pulls/${input.pullNumber}/files?per_page=${PAGE_SIZE}&page=${page}`;
    const response = await request(url, {
      headers: apiHeaders(input.token, "application/vnd.github+json"),
    });
    if (!response.ok) {
      throw new Error(`GitHub pull request files request failed with HTTP ${response.status}`);
    }
    const payload: unknown = await response.json();
    if (!Array.isArray(payload))
      throw new Error("GitHub pull request files response is not a list");
    files.push(...payload.map(parseChangedFile));
    if (payload.length < PAGE_SIZE) return { files, truncated: false };
  }
  return { files, truncated: true };
}

export async function fetchChangedFileContents(input: {
  readonly files: readonly ChangedFile[];
  readonly token: string;
  readonly request?: GitHubRequest;
}): Promise<ReadonlyMap<string, string>> {
  const request = input.request ?? fetch;
  const wanted = new Set(pathsRequiringContent(input.files));
  const contents = new Map<string, string>();
  for (const file of input.files) {
    if (!wanted.has(file.path) || file.contentsUrl === undefined) continue;
    const response = await request(file.contentsUrl, {
      headers: apiHeaders(input.token, "application/vnd.github.raw"),
    });
    if (!response.ok) continue;
    contents.set(file.path, await response.text());
  }
  return contents;
}

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

export async function main(): Promise<void> {
  const apiUrl = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const repository = requireEnvironment("GITHUB_REPOSITORY");
  const token = requireEnvironment("GITHUB_TOKEN");
  const pullNumber = Number.parseInt(requireEnvironment("PULL_REQUEST_NUMBER"), 10);
  if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
    throw new Error("PULL_REQUEST_NUMBER must be a positive integer");
  }

  const { files, truncated } = await listPullRequestFiles({
    apiUrl,
    repository,
    pullNumber,
    token,
  });
  const contents = await fetchChangedFileContents({ files, token });
  const violations = auditSecretBoundary({ files, contents, truncated });

  console.log(
    JSON.stringify(
      {
        axis: "secret-boundary",
        repository,
        pullNumber,
        changedFiles: files.map(({ path, status }) => ({ path, status })),
        inspected: pathsRequiringContent(files),
        violations,
      },
      null,
      2,
    ),
  );
  if (violations.length > 0) process.exitCode = 1;
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Secret boundary check failed");
    process.exitCode = 1;
  });
}
