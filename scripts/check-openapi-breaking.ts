import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { diffBreaking, type OpenApiDocument } from "@pirate/contracts";

const MAX_BASELINE_DOCUMENT_BYTES = 16 * 1024 * 1024;

export type BaselineEvent = "pull_request" | "push";

export interface BaselineSelectionInput {
  readonly eventName: BaselineEvent;
  readonly pullRequestBaseSha?: string;
  readonly pushBaseSha?: string;
}

export function selectBaselineSha(input: BaselineSelectionInput): string {
  const sha = input.eventName === "pull_request" ? input.pullRequestBaseSha : input.pushBaseSha;
  if (sha === undefined || sha.trim() === "") {
    throw new Error(`Missing baseline SHA for ${input.eventName} event`);
  }
  return sha;
}

export interface BreakingChangeWaiver {
  readonly baselineSha: string;
  readonly expectedViolations: readonly string[];
  readonly kind: "clean-break" | "deprecation";
  readonly operationId: string;
  readonly reason: string;
}

export interface BreakingChangePolicy {
  /**
   * One-time allowances for an exact reviewed diff against an exact baseline.
   * Remove each entry after its transition lands; a later baseline never
   * inherits the allowance.
   */
  readonly breakingChangeWaivers: readonly BreakingChangeWaiver[];
}

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;

function validateBreakingChangePolicy(
  policy: BreakingChangePolicy,
): readonly BreakingChangeWaiver[] {
  const candidate = policy as unknown as Record<string, unknown>;
  if ("cleanBreakOperations" in candidate || "deprecatedOperations" in candidate) {
    throw new Error(
      "Legacy operation-wide breaking-change allowances are forbidden; use breakingChangeWaivers",
    );
  }
  if (!Array.isArray(candidate.breakingChangeWaivers)) {
    throw new Error("breakingChangeWaivers must be an array");
  }

  const operationIds = new Set<string>();
  for (const [index, raw] of candidate.breakingChangeWaivers.entries()) {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`breakingChangeWaivers[${index}] must be an object`);
    }
    const waiver = raw as Record<string, unknown>;
    const label = `breakingChangeWaivers[${index}]`;
    if (typeof waiver.operationId !== "string" || waiver.operationId.trim() === "") {
      throw new Error(`${label}.operationId must be a non-empty string`);
    }
    if (operationIds.has(waiver.operationId)) {
      throw new Error(`Duplicate breaking-change waiver for operation ${waiver.operationId}`);
    }
    operationIds.add(waiver.operationId);
    if (waiver.kind !== "clean-break" && waiver.kind !== "deprecation") {
      throw new Error(`${label}.kind must be clean-break or deprecation`);
    }
    if (typeof waiver.baselineSha !== "string" || !FULL_COMMIT_SHA.test(waiver.baselineSha)) {
      throw new Error(`${label}.baselineSha must be a full lowercase commit SHA`);
    }
    if (typeof waiver.reason !== "string" || waiver.reason.trim() === "") {
      throw new Error(`${label}.reason must be a non-empty string`);
    }
    if (!Array.isArray(waiver.expectedViolations) || waiver.expectedViolations.length === 0) {
      throw new Error(`${label}.expectedViolations must be a non-empty array`);
    }
    const expected = new Set<string>();
    for (const violation of waiver.expectedViolations) {
      if (typeof violation !== "string" || violation.trim() === "") {
        throw new Error(`${label}.expectedViolations must contain only non-empty strings`);
      }
      if (expected.has(violation)) {
        throw new Error(`${label}.expectedViolations contains a duplicate: ${violation}`);
      }
      expected.add(violation);
    }
  }
  return candidate.breakingChangeWaivers as unknown as readonly BreakingChangeWaiver[];
}

export function assertNoObsoleteBreakingChangeWaivers(
  policy: BreakingChangePolicy,
  baselineSha: string,
  isAncestorOfHead: (commitSha: string) => boolean,
): void {
  if (!FULL_COMMIT_SHA.test(baselineSha)) {
    throw new Error(`Resolved baseline SHA must be a full lowercase commit SHA: ${baselineSha}`);
  }
  const obsolete = validateBreakingChangePolicy(policy)
    .filter((waiver) => waiver.baselineSha !== baselineSha && isAncestorOfHead(waiver.baselineSha))
    .map((waiver) => `${waiver.operationId} (${waiver.baselineSha})`)
    .sort();
  if (obsolete.length === 0) return;
  throw new Error(
    [
      "Breaking-change waivers reference an obsolete baseline reachable from HEAD:",
      ...obsolete.map((entry) => `  - ${entry}`),
      "Remove each landed waiver, or regenerate its exact diff against the current baseline if the transition is still pending.",
    ].join("\n"),
  );
}

function isCommitAncestorOfHead(commitSha: string): boolean {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", commitSha, "HEAD"], {
    encoding: "utf8",
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  const detail = result.stderr.trim();
  throw new Error(
    `Unable to determine whether breaking-change waiver baseline ${commitSha} is reachable from HEAD${detail === "" ? "" : `: ${detail}`}`,
  );
}

function sorted(values: Iterable<string>): readonly string[] {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function formatMismatch(label: string, values: readonly string[]): string {
  return values.length === 0
    ? `${label}: none`
    : `${label}:\n${values.map((v) => `  - ${v}`).join("\n")}`;
}

export function classifyBreakingViolationOperationKey(
  violation: string,
  operationKeys: Iterable<string>,
): string | undefined {
  const matches = [...operationKeys].filter(
    (key) =>
      violation === `operation removed: ${key}` ||
      violation.startsWith(`operation id changed on ${key}:`) ||
      violation.startsWith(`request ${key}:`) ||
      violation.startsWith(`request ${key} parameter `) ||
      violation === `request body removed on ${key}` ||
      violation === `request body became required on ${key}` ||
      violation === `required request body added on ${key}` ||
      violation.startsWith(`response status removed on ${key}:`) ||
      violation.startsWith(`response body removed on ${key} status `) ||
      violation.startsWith(`response ${key}:`) ||
      violation.startsWith(`response ${key} status `) ||
      violation.startsWith(`error code removed on ${key} status `),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function filterAllowedBreakingChanges(
  oldDoc: OpenApiDocument,
  newDoc: OpenApiDocument,
  policy: BreakingChangePolicy,
  baselineSha: string,
): readonly string[] {
  if (!FULL_COMMIT_SHA.test(baselineSha)) {
    throw new Error(`Resolved baseline SHA must be a full lowercase commit SHA: ${baselineSha}`);
  }
  const waivers = validateBreakingChangePolicy(policy);
  const violations = diffBreaking(oldDoc, newDoc);

  // Map "METHOD /path" of removed operations back to their old operation ids
  // so a declared deprecation can retire exactly one entry.
  const operationIds = new Map<string, string>();
  const operationKeysById = new Map<string, string[]>();
  for (const [route, methods] of Object.entries(oldDoc.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const id = (operation as Record<string, unknown>).operationId;
      if (typeof id === "string") {
        const key = `${method.toUpperCase()} ${route}`;
        operationIds.set(key, id);
        operationKeysById.set(id, [...(operationKeysById.get(id) ?? []), key]);
      }
    }
  }

  const operationId = (violation: string): string | undefined => {
    const key = classifyBreakingViolationOperationKey(violation, operationIds.keys());
    return key === undefined ? undefined : operationIds.get(key);
  };
  const allowed = new Set<string>();

  for (const waiver of waivers) {
    if (waiver.baselineSha !== baselineSha) continue;
    const keys = operationKeysById.get(waiver.operationId) ?? [];
    if (keys.length !== 1) {
      throw new Error(
        `Breaking-change waiver operation ${waiver.operationId} resolves to ${keys.length} baseline operations`,
      );
    }

    const expected = sorted(waiver.expectedViolations);
    for (const violation of expected) {
      if (operationId(violation) !== waiver.operationId) {
        throw new Error(
          `Breaking-change waiver for ${waiver.operationId} includes a violation for another or unknown operation: ${violation}`,
        );
      }
    }
    const observed = sorted(
      violations.filter((violation) => operationId(violation) === waiver.operationId),
    );
    const observedSet = new Set(observed);
    const expectedSet = new Set(expected);
    const missing = expected.filter((violation) => !observedSet.has(violation));
    const unexpected = observed.filter((violation) => !expectedSet.has(violation));
    if (missing.length > 0 || unexpected.length > 0) {
      throw new Error(
        [
          `Breaking-change waiver mismatch for ${waiver.operationId} at baseline ${baselineSha}`,
          formatMismatch("Missing expected violations", missing),
          formatMismatch("Unexpected violations", unexpected),
        ].join("\n"),
      );
    }
    for (const violation of observed) allowed.add(violation);
  }

  return sorted(violations.filter((violation) => !allowed.has(violation)));
}

interface BaselineDocument {
  readonly resolvedSha: string;
  readonly text?: string;
}

function readBaselineDocument(baseSha: string, documentPath: string): BaselineDocument {
  if (baseSha.trim() === "" || baseSha.startsWith("-")) {
    throw new Error(`Invalid baseline SHA: ${JSON.stringify(baseSha)}`);
  }

  let resolvedSha: string;
  try {
    resolvedSha = execFileSync("git", ["rev-parse", "--verify", `${baseSha}^{commit}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(`Unable to resolve baseline commit ${JSON.stringify(baseSha)}`, {
      cause: error,
    });
  }

  const show = spawnSync("git", ["show", `${resolvedSha}:${documentPath}`], {
    encoding: "utf8",
    maxBuffer: MAX_BASELINE_DOCUMENT_BYTES,
  });
  if (show.status === 0) return { resolvedSha, text: show.stdout };

  const tree = spawnSync("git", ["ls-tree", "-r", "--name-only", resolvedSha, "--", documentPath], {
    encoding: "utf8",
    maxBuffer: MAX_BASELINE_DOCUMENT_BYTES,
  });
  if (tree.status !== 0) {
    throw new Error(`Unable to inspect baseline tree ${resolvedSha}: ${tree.stderr.trim()}`);
  }
  if (tree.stdout.trim() === "") return { resolvedSha };

  throw new Error(`Unable to read ${documentPath} from baseline commit ${resolvedSha}`);
}

// Diff the generated OpenAPI document against an explicitly supplied
// baseline. A valid baseline commit without the document is the only
// bootstrap case; all other baseline failures are fatal.
const path = "apps/http-worker/src/generated/openapi.json";

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--base-sha" || args[1] === undefined) {
    throw new Error("Usage: bun scripts/check-openapi-breaking.ts --base-sha <commit>");
  }
  const baseSha = args[1];
  const baseline = readBaselineDocument(baseSha, path);
  if (baseline.text === undefined) {
    console.log(`No ${path} existed at baseline ${baseSha}; treating as bootstrap.`);
    return;
  }

  const oldDoc = JSON.parse(baseline.text) as OpenApiDocument;
  const newDoc = JSON.parse(
    await readFile(process.env.OPENAPI_DOCUMENT_PATH ?? path, "utf8"),
  ) as OpenApiDocument;
  const policy = JSON.parse(
    await readFile(
      process.env.OPENAPI_BREAKING_CHANGE_POLICY_PATH ??
        new URL("../packages/contracts/breaking-change-waivers.json", import.meta.url),
      "utf8",
    ),
  ) as BreakingChangePolicy;
  assertNoObsoleteBreakingChangeWaivers(policy, baseline.resolvedSha, isCommitAncestorOfHead);
  const breaks = filterAllowedBreakingChanges(oldDoc, newDoc, policy, baseline.resolvedSha);
  if (breaks.length > 0) {
    console.error(
      "Breaking OpenAPI changes detected (000 §5: append-only within a major version):",
    );
    for (const violation of breaks) console.error(`  - ${violation}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
