/** Change one isolated fixture binding while preserving serving Worker code. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import pg from "pg";

const accountId = "08a4c22cf52e2ecae883e36f80a33f4a";
const wrangler = `${import.meta.dir}/../../../node_modules/.bin/wrangler`;
const oldAttestation = "megapot-e2e-sepolia-20260926-r1";
const newAttestation = "megapot-e2e-sepolia-20260928-r2";
const workerNames = {
  http: "pirate-http-worker-megapot-e2e-staging",
  jobs: "pirate-jobs-worker-megapot-e2e-staging",
} as const;
type Worker = keyof typeof workerNames;
type Phase = "disable" | "select-r2" | "enable";
type Binding = { name: string; type: string; text?: string; [key: string]: unknown };
type State = {
  worker: Worker;
  version: string;
  latest: string;
  etag: string;
  runtime: unknown;
  bindings: Binding[];
  settings: Record<string, unknown>;
};

const args = Bun.argv.slice(2);
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
const allowed = new Set(["--worker", "--phase", "--expected-version", "--expected-etag", "--execute"]);
for (let i = 0; i < args.length; i++) {
  if (!allowed.has(args[i] ?? "")) throw new Error("unknown option");
  if (args[i] !== "--execute") i++;
}
const worker = option("--worker") as Worker;
const phase = option("--phase") as Phase;
const expectedVersion = option("--expected-version");
const expectedEtag = option("--expected-etag");
const execute = args.includes("--execute");
if (!(worker in workerNames) || !["disable", "select-r2", "enable"].includes(phase) ||
    !/^[0-9a-f-]{36}$/u.test(expectedVersion ?? "") ||
    !/^[0-9a-f]{64}$/u.test(expectedEtag ?? "")) {
  throw new Error("worker, phase, full expected version and code etag are required");
}
const recordRoot = process.env.E2E_GUARD_RECORD_DIR;
if (execute && (!recordRoot || !isAbsolute(recordRoot) || recordRoot.startsWith("/tmp/"))) {
  throw new Error("durable E2E_GUARD_RECORD_DIR is required for execute");
}

function command<T>(...argv: string[]): T {
  return JSON.parse(execFileSync(wrangler, argv, { encoding: "utf8" })) as T;
}
function deployVersion(version: string, name: string): void {
  execFileSync(wrangler, ["versions", "deploy", `${version}@100%`, "--name", name, "--yes"], {
    encoding: "utf8",
  });
}
const credentials = command<{ token?: string; apiToken?: string; api_token?: string }>("auth", "token", "--json");
const token = credentials.token ?? credentials.apiToken ?? credentials.api_token;
if (!token) throw new Error("Wrangler token unavailable");
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

async function settings(name: string): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${name}/settings`, {
    headers: { Authorization: headers.Authorization },
  });
  const body = await response.json() as { success?: boolean; result?: Record<string, unknown> };
  if (!response.ok || !body.success || !body.result) throw new Error("Worker settings read failed");
  return body.result;
}
function bindingValue(state: State, name: string): string {
  const value = state.bindings.find((item) => item.name === name);
  if (value?.type !== "plain_text" || typeof value.text !== "string") {
    throw new Error(`expected plain-text ${name}`);
  }
  return value.text;
}
async function state(which: Worker): Promise<State> {
  const name = workerNames[which];
  const versions = command<Array<{ id: string }>>("versions", "list", "--name", name, "--json");
  const deployed = command<{ versions: Array<{ version_id: string; percentage: number }> }>(
    "deployments", "status", "--name", name, "--json",
  );
  const latest = versions.at(-1)?.id;
  const serving = deployed.versions.length === 1 && deployed.versions[0]?.percentage === 100
    ? deployed.versions[0]?.version_id : undefined;
  if (!latest || !serving) throw new Error(`${which} has no single 100% serving version`);
  const version = command<{ resources?: { script?: { etag?: string }; bindings?: Binding[] }; runtime?: unknown }>(
    "versions", "view", serving, "--name", name, "--json",
  );
  const current = await settings(name);
  const bindings = current.bindings as Binding[] | undefined;
  if (!Array.isArray(bindings) || bindings.length !== version.resources?.bindings?.length ||
      !/^[0-9a-f]{64}$/u.test(version.resources.script?.etag ?? "")) {
    throw new Error(`${which} version/settings mismatch`);
  }
  const names = bindings.map((item) => item.name);
  if (new Set(names).size !== names.length) throw new Error(`${which} duplicate binding name`);
  return { worker: which, version: serving, latest, etag: version.resources.script!.etag!,
    runtime: version.runtime, bindings, settings: current };
}
function fingerprint(bindings: Binding[]): string {
  return createHash("sha256").update(JSON.stringify([...bindings].sort((a, b) => a.name.localeCompare(b.name)))).digest("hex");
}
function expectedTransition(phase: Phase) {
  if (phase === "disable") return { name: "MEGAPOT_REWARDS_ENABLED", before: "true", after: "false",
    attestation: oldAttestation };
  if (phase === "select-r2") return { name: "MEGAPOT_ATTESTATION_ID", before: oldAttestation,
    after: newAttestation, rewards: "false" };
  return { name: "MEGAPOT_REWARDS_ENABLED", before: "false", after: "true",
    attestation: newAttestation };
}
async function requireR2Database(): Promise<void> {
  const adminUrl = process.env.MEGAPOT_E2E_ADMIN_POSTGRES_URL;
  if (!adminUrl || !new URL(adminUrl).username.startsWith("pscale_api_i6jmpxeg4gvr.5ufdugrgjptk")) {
    throw new Error("isolated admin database URL required for activation");
  }
  const db = new pg.Client({ connectionString: adminUrl });
  await db.connect();
  try {
    await db.query("SET search_path TO api_next,public");
    const result = await db.query<{ attestation_id: string }>(
      "SELECT attestation_id FROM megapot_deployment_attestations WHERE environment='staging' AND status='active'",
    );
    if (result.rows.length !== 1 || result.rows[0]?.attestation_id !== newAttestation) {
      throw new Error("isolated database has not selected r2");
    }
  } finally { await db.end(); }
}

const before = await state(worker);
const other = await state(worker === "http" ? "jobs" : "http");
if (before.version !== expectedVersion || before.latest !== before.version || before.etag !== expectedEtag ||
    other.latest !== other.version) throw new Error("serving version or source changed");
const transition = expectedTransition(phase);
if (bindingValue(before, transition.name) !== transition.before ||
    ("attestation" in transition && bindingValue(before, "MEGAPOT_ATTESTATION_ID") !== transition.attestation) ||
    ("rewards" in transition && bindingValue(before, "MEGAPOT_REWARDS_ENABLED") !== transition.rewards)) {
  throw new Error("target binding baseline changed");
}
if (phase === "select-r2" && bindingValue(other, "MEGAPOT_REWARDS_ENABLED") !== "false") {
  throw new Error("both Workers must have rewards off before selecting r2");
}
if (phase === "enable") {
  if (bindingValue(other, "MEGAPOT_ATTESTATION_ID") !== newAttestation) {
    throw new Error("both Workers must point at r2 before activation");
  }
  await requireR2Database();
}
const changed = before.bindings.map((item) => item.name === transition.name
  ? { ...item, text: transition.after } : item);
const body = { settings: {
  bindings: before.bindings.map((item) => item.name === transition.name
    ? { name: item.name, type: "plain_text", text: transition.after }
    : { name: item.name, type: "inherit" }),
  annotations: { "workers/message": `Isolated Megapot r2 ${phase}` },
} };
const plan = { worker, phase, version: before.version, scriptEtag: before.etag,
  bindingCount: before.bindings.length, beforeHash: fingerprint(before.bindings),
  afterHash: fingerprint(changed), changedBinding: transition.name,
  beforeValue: transition.before, afterValue: transition.after,
  patchHash: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
if (!execute) {
  console.log(JSON.stringify({ action: "dry-run", ...plan }));
  process.exit(0);
}
const recordPath = `${recordRoot}/worker-${worker}-${phase}-${Date.now()}.json`;
let modified = false;
let result: Record<string, unknown> = { action: "execute", ...plan, startedAt: new Date().toISOString() };
try {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerNames[worker]}/settings`,
    { method: "PATCH", headers, body: JSON.stringify(body) },
  );
  modified = true;
  const patch = await response.json() as { success?: boolean };
  if (!response.ok || !patch.success) throw new Error("settings patch refused or outcome unknown");
  let after = await state(worker);
  if (after.latest === before.version || after.latest === after.version) {
    if (after.latest === before.version) throw new Error("patch did not create a new version");
  } else if (after.version === before.version) {
    deployVersion(after.latest, workerNames[worker]);
    after = await state(worker);
  }
  if (after.version !== after.latest || after.version === before.version ||
      after.etag !== before.etag || JSON.stringify(after.runtime) !== JSON.stringify(before.runtime) ||
      fingerprint(after.bindings) !== fingerprint(changed)) {
    throw new Error("Worker code, runtime or binding readback mismatch");
  }
  result = { ...result, outcome: "verified", newVersion: after.version, checkedAt: new Date().toISOString() };
} catch (error) {
  result = { ...result, outcome: "failed", reason: error instanceof Error ? error.message : "unknown" };
  if (modified) {
    try {
      deployVersion(before.version, workerNames[worker]);
      const restored = await state(worker);
      result = { ...result, rollbackVerified: restored.version === before.version &&
        restored.etag === before.etag && fingerprint(restored.bindings) === fingerprint(before.bindings) };
    } catch { result = { ...result, rollbackVerified: false }; }
  }
  throw error;
} finally {
  await writeFile(recordPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
}
console.log(JSON.stringify({ recordPath, outcome: result.outcome, newVersion: result.newVersion }));
