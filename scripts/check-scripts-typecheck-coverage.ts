import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const tscScript = resolve(repositoryRoot, "node_modules/typescript/bin/tsc");
const workflowDirectory = resolve(repositoryRoot, ".github/workflows");

// Every program bun run check builds. Coverage is derived from the compiler's
// own file list for each program, never from include strings.
const programConfigs = [
  "tsconfig.json",
  "tsconfig.workers.json",
  "tsconfig.binding-contract.json",
  "tsconfig.persona-collector.json",
  "tsconfig.persona-executor.json",
  "tsconfig.scripts.json",
] as const;

// Non-test TypeScript entry points named in package.json or a CI workflow that
// are knowingly not yet in a typecheck program. Each entry needs a recorded
// reason and a bounded follow-up; anything not listed here must be covered.
const deferredEntryPoints: ReadonlyMap<string, string> = new Map([
  [
    "scripts/generate-study-translation-corpus-candidates.ts",
    "imports scripts/study-translation-corpus-candidates.ts, which assigns a v1/v2/v3 prompt revision into the corpus schema's v2/v3 field; repairing it changes what the generator accepts, so it needs a product decision rather than a type-only edit",
  ],
]);

const entryPointPattern = /scripts\/[A-Za-z0-9._/-]+\.ts/g;

function collectEntryPoints(): readonly string[] {
  const references = new Set<string>();
  const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")) as {
    readonly scripts?: Readonly<Record<string, string>>;
  };
  for (const command of Object.values(packageJson.scripts ?? {})) {
    for (const match of command.matchAll(entryPointPattern)) references.add(match[0]);
  }
  for (const name of readdirSync(workflowDirectory)) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    const workflow = readFileSync(resolve(workflowDirectory, name), "utf8");
    for (const match of workflow.matchAll(entryPointPattern)) references.add(match[0]);
  }
  return [...references]
    .filter((path) => !path.endsWith(".test.ts"))
    .sort((left, right) => left.localeCompare(right));
}

function programFiles(configPath: string): readonly string[] {
  const result = spawnSync(
    process.execPath,
    [tscScript, "--noEmit", "--listFilesOnly", "-p", configPath],
    { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.error !== undefined) {
    throw new Error(`Unable to list ${configPath}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Unable to list ${configPath}: ${result.stderr.trim()}`);
  }
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => relative(repositoryRoot, line))
    .filter((path) => path.length > 0 && !path.startsWith(".."));
}

export function findUncovered(
  entryPoints: readonly string[],
  covered: ReadonlySet<string>,
  deferred: ReadonlySet<string>,
): { readonly uncovered: readonly string[]; readonly staleDeferred: readonly string[] } {
  const uncovered: string[] = [];
  const staleDeferred: string[] = [];
  for (const entryPoint of entryPoints) {
    if (covered.has(entryPoint)) {
      if (deferred.has(entryPoint)) staleDeferred.push(entryPoint);
      continue;
    }
    if (!deferred.has(entryPoint)) uncovered.push(entryPoint);
  }
  return { uncovered, staleDeferred };
}

export async function main(): Promise<void> {
  const covered = new Set<string>();
  for (const config of programConfigs) {
    for (const path of programFiles(config)) covered.add(path);
  }

  const entryPoints = collectEntryPoints();
  const { uncovered, staleDeferred } = findUncovered(
    entryPoints,
    covered,
    new Set(deferredEntryPoints.keys()),
  );

  for (const [entryPoint, reason] of deferredEntryPoints) {
    if (!staleDeferred.includes(entryPoint)) {
      console.warn(`Scripts coverage deferred: ${entryPoint} (${reason})`);
    }
  }

  if (staleDeferred.length > 0) {
    throw new Error(
      [
        "Deferred scripts coverage entries are now typechecked; remove them from deferredEntryPoints:",
        ...staleDeferred.map((path) => `- ${path}`),
      ].join("\n"),
    );
  }
  if (uncovered.length > 0) {
    throw new Error(
      [
        "TypeScript entry points are in no typecheck program; add each to tsconfig.scripts.json (or its environment's program) or record a reasoned deferral in scripts/check-scripts-typecheck-coverage.ts:",
        ...uncovered.map((path) => `- ${path}`),
      ].join("\n"),
    );
  }

  console.log(
    `Scripts typecheck coverage is complete for ${entryPoints.length} entry points across ${programConfigs.length} programs (${deferredEntryPoints.size} reasoned deferral).`,
  );
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Scripts typecheck coverage check failed",
    );
    process.exitCode = 1;
  });
}
