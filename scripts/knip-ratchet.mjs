import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), "..");
const baselinePath = resolve(root, "docs/api-next/knip-hygiene-baseline.json");
const baselineDocumentPath = resolve(root, "docs/api-next/knip-hygiene-baseline.md");
const trackedIssues = ["files", "exports", "types", "duplicates"];

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

export function countKnipIssues(report) {
  if (!isRecord(report) || !Array.isArray(report.issues)) {
    throw new TypeError("Knip JSON must contain an issues array");
  }

  const counts = Object.fromEntries(trackedIssues.map((issue) => [issue, 0]));
  for (const finding of report.issues) {
    if (!isRecord(finding)) throw new TypeError("Knip issue entries must be objects");
    for (const issue of trackedIssues) {
      if (!Array.isArray(finding[issue])) {
        throw new TypeError(`Knip issue entry is missing ${issue}`);
      }
      counts[issue] += finding[issue].length;
    }
  }
  return counts;
}

export function parseMachineBaseline(input) {
  const baseline = JSON.parse(input);
  if (!isRecord(baseline) || baseline.schema_version !== 1 || !isRecord(baseline.counts)) {
    throw new TypeError("Knip baseline must use schema version 1 and contain counts");
  }
  for (const issue of trackedIssues) {
    if (!Number.isSafeInteger(baseline.counts[issue]) || baseline.counts[issue] < 0) {
      throw new TypeError(`Knip baseline count ${issue} must be a non-negative integer`);
    }
  }
  return baseline.counts;
}

export function parseDocumentedBaseline(markdown) {
  const match = markdown.match(
    /Unused exports: (\d+)\. Unused exported types: (\d+)\. Unused files: (\d+)\. Duplicate\s+exports: (\d+)\./u,
  );
  if (!match) throw new TypeError("Knip baseline document is missing its canonical count sentence");
  return {
    files: Number(match[3]),
    exports: Number(match[1]),
    types: Number(match[2]),
    duplicates: Number(match[4]),
  };
}

export function evaluateRatchet(actual, baseline) {
  return trackedIssues.flatMap((issue) =>
    actual[issue] > baseline[issue]
      ? [`${issue}: ${actual[issue]} exceeds documented baseline ${baseline[issue]}`]
      : [],
  );
}

export function evaluateBaselineAgreement(machine, documented) {
  return trackedIssues.flatMap((issue) =>
    machine[issue] !== documented[issue]
      ? [
          `${issue}: machine baseline ${machine[issue]} disagrees with document ${documented[issue]}`,
        ]
      : [],
  );
}

function runKnip() {
  const executable = resolve(root, "node_modules/.bin/knip");
  const result = spawnSync(executable, ["--reporter", "json", "--no-progress", "--no-exit-code"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Knip process exited ${result.status}: ${result.stderr.trim()}`);
  }
  if (result.stderr.trim())
    throw new Error(`Knip reported an analysis error: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout);
}

export function main() {
  const machine = parseMachineBaseline(readFileSync(baselinePath, "utf8"));
  const documented = parseDocumentedBaseline(readFileSync(baselineDocumentPath, "utf8"));
  const agreementFailures = evaluateBaselineAgreement(machine, documented);
  if (agreementFailures.length > 0) {
    throw new Error(`Knip baselines disagree:\n${agreementFailures.join("\n")}`);
  }

  const actual = countKnipIssues(runKnip());
  const ratchetFailures = evaluateRatchet(actual, machine);
  const summary = trackedIssues
    .map((issue) => `${issue} ${actual[issue]}/${machine[issue]}`)
    .join(", ");
  if (ratchetFailures.length > 0) {
    throw new Error(`Knip hygiene regression (${summary}):\n${ratchetFailures.join("\n")}`);
  }
  process.stdout.write(`knip-ratchet: ${summary}\n`);
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`knip-ratchet: ${message}\n`);
    process.exitCode = 1;
  }
}
