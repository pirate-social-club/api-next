import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const tscScript = resolve(repositoryRoot, "node_modules/typescript/bin/tsc");
const workflowDirectory = resolve(repositoryRoot, ".github/workflows");

// Every credited program, paired with the package scripts whose commands
// semantically typecheck it. The coverage below is derived from the compiler's
// own file list for each program, never from include strings; the wiring
// assertion proves each of these commands is reached from `bun run check`, so
// deleting a program's `tsc --noEmit` invocation cannot leave its files
// credited as checked.
export const programTypechecks: ReadonlyMap<string, readonly string[]> = new Map([
  ["tsconfig.json", ["check"]],
  ["tsconfig.workers.json", ["check"]],
  ["tsconfig.binding-contract.json", ["check:binding-contract"]],
  ["tsconfig.persona-collector.json", ["check:persona-collector"]],
  ["tsconfig.persona-executor.json", ["check:persona-collector"]],
  ["tsconfig.scripts.json", ["check:scripts"]],
]);

// Non-test TypeScript entry points named in package.json or a CI workflow that
// are knowingly not yet in a typecheck program. Each entry needs a recorded
// reason and a bounded follow-up; anything not listed here must be covered.
const deferredEntryPoints: ReadonlyMap<string, string> = new Map([
  [
    "scripts/generate-study-translation-corpus-candidates.ts",
    "imports scripts/study-translation-corpus-candidates.ts, which assigns a v1/v2/v3 prompt revision into the corpus schema's v2/v3 field; repairing it changes what the generator accepts, so it needs a product decision rather than a type-only edit",
  ],
]);

// Discovery is literal: only `scripts/<path>.ts` references spelled out in
// package.json commands and CI workflow text are entry points. A dynamically
// constructed path such as `scripts/${name}.ts` is intentionally not
// discovered, because this gate does not interpret shell or interpolate
// variables.
const entryPointPattern = /scripts\/[A-Za-z0-9._/-]+\.ts/g;
const scriptReferencePattern = /\bbun run ([A-Za-z0-9:_-]+)/g;

export function entryPointsFromTexts(texts: readonly string[]): readonly string[] {
  const references = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(entryPointPattern)) references.add(match[0]);
  }
  return [...references]
    .filter((path) => !path.endsWith(".test.ts"))
    .sort((left, right) => left.localeCompare(right));
}

// Bounded reachability over package-script names: the only edges are literal
// `bun run <script>` references in command strings. This is a wiring check,
// not a shell interpreter.
export function reachableScripts(
  scripts: Readonly<Record<string, string>>,
  roots: readonly string[],
): ReadonlySet<string> {
  const reached = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined || reached.has(name)) continue;
    const command = scripts[name];
    if (command === undefined) continue;
    reached.add(name);
    for (const match of command.matchAll(scriptReferencePattern)) {
      const target = match[1];
      if (target !== undefined && !reached.has(target)) pending.push(target);
    }
  }
  return reached;
}

// Supported command syntax is a chain of `&&`-separated segments that start
// with a direct `tsc` executable and spell `--noEmit` plus an exact `-p` or
// `--project` configuration argument. Everything else fails closed: quoted or
// echoed text, listing-only invocations, substituted or redirected commands,
// pipelines and other separators credit nothing, because this matcher reads
// commands plainly rather than interpreting shell.
const unsupportedCommandSyntax = /[;|`\n<>()$\\'"]/;

function segmentTypechecksConfig(segment: string, config: string): boolean {
  const tokens = segment.trim().split(/\s+/);
  if (tokens[0] !== "tsc") return false;
  if (!tokens.includes("--noEmit")) return false;
  if (tokens.includes("--listFilesOnly")) return false;
  for (let index = 1; index < tokens.length - 1; index += 1) {
    const flag = tokens[index];
    if (flag !== "-p" && flag !== "--project") continue;
    if (tokens[index + 1] === config) return true;
  }
  return false;
}

export function commandTypechecksConfig(command: string, config: string): boolean {
  if (unsupportedCommandSyntax.test(command)) return false;
  return command.split("&&").some((segment) => segmentTypechecksConfig(segment, config));
}

export function unwiredPrograms(
  programs: ReadonlyMap<string, readonly string[]>,
  scripts: Readonly<Record<string, string>>,
): readonly string[] {
  const reached = reachableScripts(scripts, ["check"]);
  const unwired: string[] = [];
  for (const [config, scriptNames] of programs) {
    const wired = scriptNames.some((name) => {
      if (!reached.has(name)) return false;
      const command = scripts[name];
      if (command === undefined) return false;
      return commandTypechecksConfig(command, config);
    });
    if (!wired) unwired.push(config);
  }
  return unwired;
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

function readPackageScripts(): Readonly<Record<string, string>> {
  const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")) as {
    readonly scripts?: Readonly<Record<string, string>>;
  };
  return packageJson.scripts ?? {};
}

function collectEntryPoints(scripts: Readonly<Record<string, string>>): readonly string[] {
  const texts: string[] = Object.values(scripts);
  for (const name of readdirSync(workflowDirectory)) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    texts.push(readFileSync(resolve(workflowDirectory, name), "utf8"));
  }
  return entryPointsFromTexts(texts);
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

export async function main(): Promise<void> {
  const scripts = readPackageScripts();

  // Wiring first: no program may credit files until its semantic typecheck is
  // demonstrably reached from the check chain.
  const unwired = unwiredPrograms(programTypechecks, scripts);
  if (unwired.length > 0) {
    throw new Error(
      [
        "Credited typecheck programs are not demonstrably executed by bun run check; restore each `tsc --noEmit -p <config>` in a package script the check chain reaches:",
        ...unwired.map((path) => `- ${path}`),
      ].join("\n"),
    );
  }

  const covered = new Set<string>();
  for (const config of programTypechecks.keys()) {
    for (const path of programFiles(config)) covered.add(path);
  }

  const entryPoints = collectEntryPoints(scripts);
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
    `Scripts typecheck coverage is complete for ${entryPoints.length} entry points across ${programTypechecks.size} programs (${deferredEntryPoints.size} reasoned deferral).`,
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
