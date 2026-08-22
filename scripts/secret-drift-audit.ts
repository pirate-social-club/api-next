import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const CLOUDFLARE_WORKERS = [
  {
    workerId: "http",
    configPath: "apps/http-worker/wrangler.jsonc",
    environments: ["staging", "production"],
  },
  {
    workerId: "jobs",
    configPath: "apps/jobs-worker/wrangler.jsonc",
    environments: ["staging", "production"],
  },
] as const;

export type EnvironmentName = "staging" | "production";
export type DriftKind =
  | "declared-var-secret-collision"
  | "var-secret-collision"
  | "installed-secret-undeclared"
  | "declared-secret-not-installed"
  | "worker-not-deployed";

export type DeclaredBindings = Readonly<{
  vars: readonly string[];
  secrets: readonly string[];
}>;

export type RemoteSecretState =
  | Readonly<{ kind: "present"; names: readonly string[] }>
  | Readonly<{ kind: "missing" }>;

export type AuditTarget = Readonly<{
  workerId: string;
  environment: EnvironmentName;
  workerName: string;
  declared: DeclaredBindings;
  remote: RemoteSecretState;
}>;

export type ExpectedDrift = Readonly<{
  workerId: string;
  environment: EnvironmentName;
  kind: DriftKind;
  name?: string;
  reason: string;
}>;

export type Drift = Readonly<{
  workerId: string;
  environment: EnvironmentName;
  workerName: string;
  kind: DriftKind;
  name?: string;
  reason?: string;
}>;

export type AuditReport = Readonly<{
  checked: readonly AuditTarget[];
  acceptedDrift: readonly Drift[];
  violations: readonly Drift[];
}>;

export type WranglerConfig = Readonly<{
  name?: unknown;
  vars?: unknown;
  secrets?: unknown;
  env?: unknown;
}>;

type JsonObject = Record<string, unknown>;

/**
 * The Wrangler configs are JSONC. This parser deliberately handles comments
 * and trailing commas without evaluating JavaScript or touching values.
 */
export function parseJsonc<T>(source: string): T {
  const withoutComments = stripJsonComments(source);
  const withoutTrailingCommas = stripTrailingCommas(withoutComments);
  return JSON.parse(withoutTrailingCommas) as T;
}

function stripJsonComments(source: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (inString) {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }

    if (character === "/" && next === "/") {
      index += 1;
      while (index + 1 < source.length && source[index + 1] !== "\n") index += 1;
      result += "\n";
      continue;
    }

    if (character === "/" && next === "*") {
      index += 2;
      while (index + 1 < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
      continue;
    }

    result += character;
  }

  return result;
}

function stripTrailingCommas(source: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (inString) {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }

    if (character === ",") {
      let lookahead = index + 1;
      while (/\s/.test(source[lookahead] ?? "")) lookahead += 1;
      if (source[lookahead] === "}" || source[lookahead] === "]") continue;
    }

    result += character;
  }

  return result;
}

function asObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function objectKeys(value: unknown, label: string): readonly string[] {
  if (value === undefined) return [];
  return Object.keys(asObject(value, label)).sort();
}

function requiredSecretNames(value: unknown, label: string): readonly string[] {
  if (value === undefined) return [];
  const secrets = asObject(value, label);
  const required = secrets.required;
  if (required === undefined) return [];
  if (!Array.isArray(required) || required.some((name) => typeof name !== "string")) {
    throw new Error(`${label}.required must be an array of strings`);
  }
  return [...new Set(required)].sort();
}

export function declaredBindingsForEnvironment(
  config: WranglerConfig,
  environment: EnvironmentName,
): DeclaredBindings & { readonly workerName: string } {
  const root = asObject(config, "Wrangler config");
  const environments = root.env === undefined ? {} : asObject(root.env, "Wrangler config.env");
  const environmentConfig = asObject(environments[environment], `Wrangler env.${environment}`);
  const rootName = root.name;
  const environmentName = environmentConfig.name;
  const workerName = environmentName ?? rootName;
  if (typeof workerName !== "string" || workerName.length === 0) {
    throw new Error(`Wrangler env.${environment} has no Worker name`);
  }

  return {
    workerName,
    // Wrangler named environments inherit ordinary vars; explicitly merge the
    // root and overlay names so collision detection sees the effective set.
    vars: [
      ...new Set([
        ...objectKeys(root.vars, "Wrangler config.vars"),
        ...objectKeys(environmentConfig.vars, `Wrangler env.${environment}.vars`),
      ]),
    ].sort(),
    // `secrets.required` is not inherited by named environments.
    secrets: requiredSecretNames(environmentConfig.secrets, `Wrangler env.${environment}.secrets`),
  };
}

export function driftKey(input: Pick<Drift, "workerId" | "environment" | "kind" | "name">): string {
  return [input.workerId, input.environment, input.kind, input.name ?? ""].join("/");
}

export const EXPECTED_CLOUDFLARE_DRIFT: readonly ExpectedDrift[] = [
  {
    workerId: "http",
    environment: "production",
    kind: "worker-not-deployed",
    reason: "Production remains disabled; the production HTTP Worker is intentionally absent.",
  },
  {
    workerId: "jobs",
    environment: "production",
    kind: "worker-not-deployed",
    reason: "Production remains disabled; the production jobs Worker is intentionally absent.",
  },
];

export function auditCloudflareTargets(
  targets: readonly AuditTarget[],
  expectedDrift: readonly ExpectedDrift[] = EXPECTED_CLOUDFLARE_DRIFT,
): AuditReport {
  const expectedByKey = new Map(expectedDrift.map((entry) => [driftKey(entry), entry]));
  const acceptedDrift: Drift[] = [];
  const violations: Drift[] = [];

  const record = (drift: Drift): void => {
    const expected = expectedByKey.get(driftKey(drift));
    if (expected !== undefined) {
      acceptedDrift.push({ ...drift, reason: expected.reason });
    } else {
      violations.push(drift);
    }
  };

  for (const target of targets) {
    const declaredVars = new Set(target.declared.vars);
    const declaredSecrets = new Set(target.declared.secrets);

    for (const name of [...declaredVars].sort()) {
      if (declaredSecrets.has(name)) {
        record({
          workerId: target.workerId,
          environment: target.environment,
          workerName: target.workerName,
          kind: "declared-var-secret-collision",
          name,
        });
      }
    }

    if (target.remote.kind === "missing") {
      record({
        workerId: target.workerId,
        environment: target.environment,
        workerName: target.workerName,
        kind: "worker-not-deployed",
      });
      continue;
    }

    const installedSecrets = new Set(target.remote.names);
    for (const name of [...installedSecrets].sort()) {
      if (declaredVars.has(name)) {
        record({
          workerId: target.workerId,
          environment: target.environment,
          workerName: target.workerName,
          kind: "var-secret-collision",
          name,
        });
      } else if (!declaredSecrets.has(name)) {
        record({
          workerId: target.workerId,
          environment: target.environment,
          workerName: target.workerName,
          kind: "installed-secret-undeclared",
          name,
        });
      }
    }

    for (const name of [...declaredSecrets].sort()) {
      if (!installedSecrets.has(name)) {
        record({
          workerId: target.workerId,
          environment: target.environment,
          workerName: target.workerName,
          kind: "declared-secret-not-installed",
          name,
        });
      }
    }
  }

  return {
    checked: targets,
    acceptedDrift,
    violations,
  };
}

type CommandResult = Readonly<{ exitCode: number; stdout: string; stderr: string }>;
type CommandRunner = (command: readonly string[]) => Promise<CommandResult>;

async function runCommand(command: readonly string[]): Promise<CommandResult> {
  const child = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr] = await Promise.all([
    child.stdout === null ? Promise.resolve("") : new Response(child.stdout).text(),
    child.stderr === null ? Promise.resolve("") : new Response(child.stderr).text(),
  ]);
  return { exitCode: await child.exited, stdout, stderr };
}

function isMissingWorker(result: CommandResult): boolean {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    output.includes("10007") || output.includes("worker not found") || output.includes("not found")
  );
}

export async function listCloudflareWorkerSecrets(
  workerName: string,
  commandRunner: CommandRunner = runCommand,
): Promise<RemoteSecretState> {
  const result = await commandRunner([
    "bunx",
    "wrangler",
    "secret",
    "list",
    "--name",
    workerName,
    "--format",
    "json",
  ]);

  if (result.exitCode !== 0) {
    if (isMissingWorker(result)) return { kind: "missing" };
    throw new Error(`wrangler secret list failed for ${workerName} (exit ${result.exitCode})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`wrangler secret list returned invalid JSON for ${workerName}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`wrangler secret list returned a non-array response for ${workerName}`);
  }

  const names = parsed.map((entry, index) => {
    const object = asObject(entry, `wrangler secret list item ${index}`);
    const name = object.name;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(`wrangler secret list item ${index} has no name for ${workerName}`);
    }
    return name;
  });
  return { kind: "present", names: [...new Set(names)].sort() };
}

async function loadConfig(path: string): Promise<WranglerConfig> {
  return parseJsonc<WranglerConfig>(await Bun.file(path).text());
}

async function collectTargets(repositoryRoot: string): Promise<AuditTarget[]> {
  const targets: AuditTarget[] = [];
  for (const worker of CLOUDFLARE_WORKERS) {
    const config = await loadConfig(join(repositoryRoot, worker.configPath));
    for (const environment of worker.environments) {
      const declared = declaredBindingsForEnvironment(config, environment);
      targets.push({
        workerId: worker.workerId,
        environment,
        workerName: declared.workerName,
        declared,
        remote: await listCloudflareWorkerSecrets(declared.workerName),
      });
    }
  }
  return targets;
}

export async function main(): Promise<void> {
  const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
  const report = auditCloudflareTargets(await collectTargets(repositoryRoot));
  console.log(
    JSON.stringify(
      {
        axis: "cloudflare",
        checked: report.checked.map(({ workerId, environment, workerName, declared, remote }) => ({
          workerId,
          environment,
          workerName,
          declaredVars: declared.vars,
          declaredSecrets: declared.secrets,
          installedSecrets: remote.kind === "present" ? remote.names : null,
          remoteState: remote.kind,
        })),
        acceptedDrift: report.acceptedDrift,
        violations: report.violations,
      },
      null,
      2,
    ),
  );
  if (report.violations.length > 0) process.exitCode = 1;
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Cloudflare secret drift audit failed");
    process.exitCode = 1;
  });
}
