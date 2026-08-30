import { spawnSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync, constants as zlibConstants } from "node:zlib";

const severityRank: Readonly<Record<string, number>> = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

export interface AdvisoryFinding {
  readonly advisory: string;
  readonly package: string;
  readonly severity: string;
  readonly title: string;
  readonly url: string;
}

interface AuditException {
  readonly advisory: string;
  readonly package: string;
  readonly reason: string;
  readonly reachability: string;
  readonly expires: string;
}

export interface DependencyAuditPolicy {
  readonly globalThreshold: string;
  readonly requestPathThreshold: string;
  readonly requestPathPackages: readonly string[];
  readonly exceptions: readonly AuditException[];
}

export interface AuditEvaluation {
  readonly blocking: readonly AdvisoryFinding[];
  readonly accepted: readonly (AdvisoryFinding & { readonly exception: AuditException })[];
  readonly observed: readonly AdvisoryFinding[];
  readonly expired: readonly AuditException[];
  readonly unused: readonly AuditException[];
}

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${context} needs a non-empty \`${key}\``);
  }
  return value;
}

function validateSeverity(value: string, key: string): string {
  if (severityRank[value] === undefined) {
    throw new Error(`${key} must be one of ${Object.keys(severityRank).join(", ")}; got ${value}`);
  }
  return value;
}

function expiryEpoch(expires: string, context: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(expires)) {
    throw new Error(`${context} needs an \`expires\` date in YYYY-MM-DD form`);
  }
  const epoch = Date.parse(`${expires}T23:59:59.999Z`);
  if (Number.isNaN(epoch)) throw new Error(`${context} has an invalid \`expires\` date`);
  return epoch;
}

export function parsePolicy(raw: string): DependencyAuditPolicy {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error("dependency audit policy must be a JSON object");

  const globalThreshold = validateSeverity(
    requiredString(parsed, "globalThreshold", "dependency audit policy"),
    "globalThreshold",
  );
  const requestPathThreshold = validateSeverity(
    requiredString(parsed, "requestPathThreshold", "dependency audit policy"),
    "requestPathThreshold",
  );
  if (
    !Array.isArray(parsed.requestPathPackages) ||
    !parsed.requestPathPackages.every((value) => typeof value === "string" && value.length > 0)
  ) {
    throw new Error("requestPathPackages must be an array of package names");
  }
  if (new Set(parsed.requestPathPackages).size !== parsed.requestPathPackages.length) {
    throw new Error("requestPathPackages must not contain duplicates");
  }
  if (!Array.isArray(parsed.exceptions)) throw new Error("exceptions must be an array");

  const exceptionKeys = new Set<string>();
  const exceptions = parsed.exceptions.map((value, index): AuditException => {
    const context = `exception ${index + 1}`;
    if (!isRecord(value)) throw new Error(`${context} must be an object`);
    const entry = {
      advisory: requiredString(value, "advisory", context),
      package: requiredString(value, "package", context),
      reason: requiredString(value, "reason", context),
      reachability: requiredString(value, "reachability", context),
      expires: requiredString(value, "expires", context),
    };
    expiryEpoch(entry.expires, context);
    const key = `${entry.package}|${entry.advisory}`;
    if (exceptionKeys.has(key)) throw new Error(`duplicate dependency audit exception ${key}`);
    exceptionKeys.add(key);
    return entry;
  });

  return {
    globalThreshold,
    requestPathThreshold,
    requestPathPackages: parsed.requestPathPackages,
    exceptions,
  };
}

export function decodeBunAuditOutput(raw: Uint8Array): string {
  const bytes = Buffer.from(raw);
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return gunzipSync(bytes, { finishFlush: zlibConstants.Z_SYNC_FLUSH }).toString("utf8");
  }
  return bytes.toString("utf8");
}

export function normalizeBunAudit(raw: string): readonly AdvisoryFinding[] {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error("bun audit output must be a JSON object");
  const findings: AdvisoryFinding[] = [];
  for (const [packageName, advisories] of Object.entries(parsed)) {
    if (!Array.isArray(advisories)) continue;
    for (const advisory of advisories) {
      if (!isRecord(advisory)) continue;
      const url = typeof advisory.url === "string" ? advisory.url : "";
      findings.push({
        advisory: url.split("/").pop() || "unknown-advisory",
        package: packageName,
        severity: String(advisory.severity ?? "info").toLowerCase(),
        title: typeof advisory.title === "string" ? advisory.title : "",
        url,
      });
    }
  }
  return findings;
}

function dedupe(findings: readonly AdvisoryFinding[]): readonly AdvisoryFinding[] {
  const unique = new Map<string, AdvisoryFinding>();
  for (const finding of findings) {
    const key = `${finding.package}|${finding.advisory}`;
    if (!unique.has(key)) unique.set(key, finding);
  }
  return [...unique.values()];
}

export function evaluateAudit(
  findings: readonly AdvisoryFinding[],
  policy: DependencyAuditPolicy,
  now = new Date(),
): AuditEvaluation {
  const requestPathPackages = new Set(policy.requestPathPackages);
  const exceptions = new Map(
    policy.exceptions.map((entry) => [`${entry.package}|${entry.advisory}`, entry]),
  );
  const matchedExceptions = new Set<string>();
  const blocking: AdvisoryFinding[] = [];
  const accepted: (AdvisoryFinding & { readonly exception: AuditException })[] = [];
  const observed: AdvisoryFinding[] = [];

  for (const finding of dedupe(findings)) {
    const rank = severityRank[finding.severity] ?? 0;
    const globallyBlocking =
      rank >= (severityRank[policy.globalThreshold] ?? Number.POSITIVE_INFINITY);
    const requestPathBlocking =
      requestPathPackages.has(finding.package) &&
      rank >= (severityRank[policy.requestPathThreshold] ?? Number.POSITIVE_INFINITY);
    if (!globallyBlocking && !requestPathBlocking) {
      observed.push(finding);
      continue;
    }

    const key = `${finding.package}|${finding.advisory}`;
    const exception = exceptions.get(key);
    if (exception !== undefined) matchedExceptions.add(key);
    if (exception !== undefined && expiryEpoch(exception.expires, key) >= now.getTime()) {
      accepted.push({ ...finding, exception });
    } else {
      blocking.push(finding);
    }
  }

  const expired = policy.exceptions.filter(
    (entry) => expiryEpoch(entry.expires, `${entry.package}|${entry.advisory}`) < now.getTime(),
  );
  const unused = policy.exceptions.filter(
    (entry) => !matchedExceptions.has(`${entry.package}|${entry.advisory}`),
  );
  return { blocking, accepted, observed, expired, unused };
}

function renderReport(
  findings: readonly AdvisoryFinding[],
  policy: DependencyAuditPolicy,
  evaluation: AuditEvaluation,
): string {
  const lines = [
    `policy global=${policy.globalThreshold} request-path=${policy.requestPathThreshold}`,
    `request-path packages=${policy.requestPathPackages.join(",") || "none"}`,
    `scanned ${findings.length} advisory instance(s)`,
  ];
  for (const finding of evaluation.blocking) {
    lines.push(
      `BLOCKING [${finding.severity}] ${finding.package} ${finding.advisory} — ${finding.title}`,
    );
  }
  for (const finding of evaluation.accepted) {
    lines.push(
      `accepted [${finding.severity}] ${finding.package} ${finding.advisory} — ${finding.exception.reachability} (expires ${finding.exception.expires})`,
    );
  }
  for (const finding of evaluation.observed) {
    lines.push(
      `observed [${finding.severity}] ${finding.package} ${finding.advisory} — below its policy threshold`,
    );
  }
  for (const entry of evaluation.expired) {
    lines.push(`EXPIRED ${entry.package} ${entry.advisory} — exception lapsed ${entry.expires}`);
  }
  for (const entry of evaluation.unused) {
    lines.push(`STALE ${entry.package} ${entry.advisory} — remove the unmatched exception`);
  }
  if (
    evaluation.blocking.length === 0 &&
    evaluation.expired.length === 0 &&
    evaluation.unused.length === 0
  ) {
    lines.push("no policy action required");
  }
  return lines.join("\n");
}

function policyPath(argv: readonly string[]): string {
  const index = argv.indexOf("--policy");
  if (index === -1 || argv[index + 1] === undefined) {
    throw new Error("dependency audit requires --policy <path>");
  }
  return argv[index + 1];
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const policy = parsePolicy(await readFile(policyPath(argv), "utf8"));
  const result = spawnSync(process.execPath, ["audit", "--json"], {
    cwd: repositoryRoot,
    encoding: null,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.stdout.length === 0) {
    throw new Error(
      `bun audit produced no output (exit ${result.status ?? "unknown"}): ${result.stderr.toString("utf8").slice(0, 400)}`,
    );
  }

  const findings = normalizeBunAudit(decodeBunAuditOutput(result.stdout));
  const evaluation = evaluateAudit(findings, policy);
  const report = renderReport(findings, policy, evaluation);
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## Dependency audit\n\n\`\`\`\n${report}\n\`\`\`\n`,
    );
  }
  if (
    evaluation.blocking.length > 0 ||
    evaluation.expired.length > 0 ||
    evaluation.unused.length > 0
  ) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Dependency audit failed");
    process.exitCode = 1;
  });
}
