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

export function entryPointsFromTexts(texts: readonly string[]): readonly string[] {
  const references = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(entryPointPattern)) references.add(match[0]);
  }
  return [...references]
    .filter((path) => !path.endsWith(".test.ts"))
    .sort((left, right) => left.localeCompare(right));
}

// Supported command syntax is a chain of `&&`-separated segments that are
// read plainly. Quoting, substitution, redirection, pipelines, semicolons,
// shell comments and other separators are unsupported and fail closed: a
// command this matcher cannot read word for word credits and reaches nothing.
// A `#` is rejected outright before any split, because a comment can swallow
// an `&&` and the invocation after it. This is a wiring assertion, not a
// shell interpreter.
const unsupportedCommandSyntax = /[#;|`\n<>()$\\'"]/;

function commandSegments(command: string): readonly string[] | undefined {
  if (unsupportedCommandSyntax.test(command)) return undefined;
  return command.split("&&");
}

// The repository's supported semantic typecheck is exactly
// `tsc --noEmit -p CONFIG` or `tsc --noEmit --project CONFIG`. Exact token
// matching rejects extra and duplicate options, so `--noCheck`, listing-only
// invocations and prefix-named configurations credit nothing.
function segmentTypechecksConfig(segment: string, config: string): boolean {
  const tokens = segment.trim().split(/\s+/);
  if (tokens.length !== 4) return false;
  const [executable, noEmit, flag, argument] = tokens;
  if (executable !== "tsc" || noEmit !== "--noEmit") return false;
  if (flag !== "-p" && flag !== "--project") return false;
  return argument === config;
}

export function commandTypechecksConfig(command: string, config: string): boolean {
  const segments = commandSegments(command);
  if (segments === undefined) return false;
  return segments.some((segment) => segmentTypechecksConfig(segment, config));
}

// A reachability edge is an executed `bun run SCRIPT` segment consisting of
// exactly those three tokens, so echoed, quoted or commented text and wrapped
// invocations never count as execution.
function segmentBunRunTarget(segment: string): string | undefined {
  const tokens = segment.trim().split(/\s+/);
  if (tokens.length !== 3) return undefined;
  const [executable, subcommand, target] = tokens;
  if (executable !== "bun" || subcommand !== "run") return undefined;
  return target;
}

// Bounded reachability over package-script names: the only edges are direct
// `bun run <script>` segments. This is a wiring check, not a shell
// interpreter.
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
    const segments = commandSegments(command);
    if (segments === undefined) continue;
    for (const segment of segments) {
      const target = segmentBunRunTarget(segment);
      if (target !== undefined && !reached.has(target)) pending.push(target);
    }
  }
  return reached;
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
