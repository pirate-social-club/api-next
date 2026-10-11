import { createHash } from "node:crypto";

type Row = Record<string, unknown>;
const lexical = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export type Binding = Readonly<Row & { name: string; type: string }>;
export type Runtime = Readonly<Row>;
export type CandidateBindings = Readonly<{
  worker_name: string;
  bindings: readonly Binding[];
  runtime: Runtime;
  required_secrets: readonly string[];
}>;
export type ServingVersion = Readonly<{
  version_id: string;
  percentage: number;
  bindings: readonly Binding[];
  runtime: Runtime;
}>;
export type DriftContext = Readonly<{
  source_sha: string;
  environment: string;
  config_path: string;
}>;
export type BindingDrift = Readonly<{
  kind: "binding" | "runtime";
  version_id: string;
  name: string;
  before_sha256: string | null;
  after_sha256: string | null;
}>;
export type BindingDriftReceipt = Readonly<{
  schema_version: 1;
  source_sha: string;
  environment: string;
  config_path: string;
  worker_name: string;
  observed_at: string;
  baseline_sha256: string;
  candidate_sha256: string;
  serving_versions: readonly Readonly<{ version_id: string; percentage: number }>[];
  changes: readonly BindingDrift[];
}>;

export function object(value: unknown, label: string): Row {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw Error(`staging binding preflight: invalid ${label}`);
  return value as Row;
}

export function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw Error(`staging binding preflight: missing ${label}`);
  return value;
}

export function parseJson(source: string, label: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    throw Error(`staging binding preflight: invalid ${label} JSON`);
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => lexical(a, b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

export function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export function isSecret(binding: Binding): boolean {
  return binding.type === "secret_text" || binding.type === "secret_key";
}

/** Secret values and raw version author metadata never enter a receipt or digest. */
export function bindings(value: unknown): readonly Binding[] {
  if (!Array.isArray(value)) throw Error("staging binding preflight: missing binding inventory");
  const seen = new Set<string>();
  return value
    .map((entry) => {
      const row = object(entry, "binding");
      const name = string(row.name, "binding name");
      const type = string(row.type, "binding type");
      if (seen.has(name)) throw Error("staging binding preflight: duplicate binding");
      seen.add(name);
      const binding = { ...row, name, type };
      const identities: Readonly<Record<string, readonly string[]>> = {
        kv_namespace: ["namespace_id"],
        r2_bucket: ["bucket_name"],
        d1: ["id"],
        hyperdrive: ["id"],
        queue: ["queue_name"],
        service: ["service"],
        workflow: ["workflow_name", "class_name"],
        durable_object_namespace: ["class_name"],
        vpc_service: ["service_id"],
        vpc_network: ["network_id"],
        vectorize: ["index_name"],
        analytics_engine: ["dataset"],
        mtls_certificate: ["certificate_id"],
        ai: [],
        browser: [],
        images: [],
        version_metadata: [],
        plain_text: [],
        json: [],
        secret_text: [],
        secret_key: [],
      };
      const required = identities[type];
      if (required === undefined)
        throw Error("staging binding preflight: unsupported binding inventory");
      for (const key of required) string(row[key], "binding identity");
      if (type === "plain_text" && typeof row.text !== "string")
        throw Error("staging binding preflight: incomplete plaintext binding");
      if (type === "json" && row.json === undefined)
        throw Error("staging binding preflight: incomplete JSON binding");
      return isSecret(binding) ? { name, type } : binding;
    })
    .sort((a, b) => lexical(a.name, b.name));
}

export function runtime(value: unknown): Runtime {
  const row = object(value, "runtime");
  const allowed = new Set([
    "compatibility_date",
    "compatibility_flags",
    "migration_tag",
    "usage_model",
  ]);
  if (Object.keys(row).some((key) => !allowed.has(key)))
    throw Error("staging binding preflight: unsupported runtime setting");
  const flags = row.compatibility_flags;
  if (!Array.isArray(flags) || flags.some((flag) => typeof flag !== "string"))
    throw Error("staging binding preflight: missing compatibility flags");
  return {
    compatibility_date: string(row.compatibility_date, "compatibility date"),
    compatibility_flags: [...flags].sort(),
    migration_tag: row.migration_tag ?? null,
    usage_model: string(row.usage_model, "usage model"),
  };
}

function comparable(binding: Binding): Binding {
  // Namespace IDs are assigned by Cloudflare. Their full values remain pinned in
  // the baseline digest; the upload selects a namespace by script/class tuple.
  if (binding.type === "durable_object_namespace") {
    const { namespace_id: _namespaceId, ...selection } = binding;
    return selection;
  }
  if (binding.type === "json" && typeof binding.json === "string") {
    try {
      return { ...binding, json: JSON.parse(binding.json) };
    } catch {
      throw Error("staging binding preflight: invalid JSON binding");
    }
  }
  return binding;
}

export function parseServingDeployments(source: string): readonly Readonly<{
  version_id: string;
  percentage: number;
}>[] {
  const rows: unknown = parseJson(source, "serving deployment");
  if (!Array.isArray(rows) || rows.length === 0)
    throw Error("staging binding preflight: no serving deployment");
  const deployments = rows.map((entry) => object(entry, "deployment"));
  if (
    deployments.some(
      (row) => !Number.isFinite(Date.parse(string(row.created_on, "deployment time"))),
    )
  )
    throw Error("staging binding preflight: invalid deployment time");
  deployments.sort((a, b) =>
    lexical(string(a.created_on, "deployment time"), string(b.created_on, "deployment time")),
  );
  const newest = deployments.at(-1);
  if (newest === undefined || !Array.isArray(newest.versions) || newest.versions.length === 0)
    throw Error("staging binding preflight: missing serving versions");
  const seen = new Set<string>();
  const versions = newest.versions.map((entry) => {
    const row = object(entry, "traffic allocation");
    const version_id = string(row.version_id, "serving version");
    const percentage = row.percentage;
    if (
      seen.has(version_id) ||
      typeof percentage !== "number" ||
      !Number.isFinite(percentage) ||
      percentage < 0 ||
      percentage > 100
    )
      throw Error("staging binding preflight: invalid traffic allocation");
    seen.add(version_id);
    return { version_id, percentage };
  });
  if (Math.abs(versions.reduce((sum, row) => sum + row.percentage, 0) - 100) > 0.000001)
    throw Error("staging binding preflight: incomplete traffic allocation");
  return versions
    .filter((row) => row.percentage > 0)
    .sort((a, b) => lexical(a.version_id, b.version_id));
}

export function compareServingBindings(
  context: DriftContext,
  candidate: CandidateBindings,
  serving: readonly ServingVersion[],
  now = new Date(),
): BindingDriftReceipt {
  if (
    !/^[a-f0-9]{40}$/.test(context.source_sha) ||
    context.environment !== "staging" ||
    serving.length === 0
  )
    throw Error("staging binding preflight: invalid release context");
  const versions = [...serving].sort((a, b) => lexical(a.version_id, b.version_id));
  const inventories = versions.map((row) => ({
    ...row,
    bindings: bindings(row.bindings),
    runtime: runtime(row.runtime),
  }));
  const secrets = inventories.map((row) => row.bindings.filter(isSecret));
  if (secrets.some((row) => digest(row) !== digest(secrets[0])))
    throw Error("staging binding preflight: ambiguous retained secret inventory");
  for (const name of candidate.required_secrets)
    if (!secrets[0]?.some((binding) => binding.name === name))
      throw Error("staging binding preflight: required secret missing");
  const declared = bindings(candidate.bindings);
  const effective = bindings([
    ...declared,
    ...(secrets[0] ?? []).filter(
      (secret) => !declared.some((binding) => binding.name === secret.name),
    ),
  ]);
  const desiredRuntime = runtime(candidate.runtime);
  const changes: BindingDrift[] = [];
  for (const row of inventories) {
    const before = new Map(
      row.bindings.map((binding) => [binding.name, digest(comparable(binding))]),
    );
    const after = new Map(effective.map((binding) => [binding.name, digest(comparable(binding))]));
    for (const name of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const before_sha256 = before.get(name) ?? null;
      const after_sha256 = after.get(name) ?? null;
      if (before_sha256 !== after_sha256)
        changes.push({
          kind: "binding",
          version_id: row.version_id,
          name,
          before_sha256,
          after_sha256,
        });
    }
    if (digest(row.runtime) !== digest(desiredRuntime))
      changes.push({
        kind: "runtime",
        version_id: row.version_id,
        name: "script_runtime",
        before_sha256: digest(row.runtime),
        after_sha256: digest(desiredRuntime),
      });
  }
  return {
    schema_version: 1,
    ...context,
    worker_name: candidate.worker_name,
    observed_at: now.toISOString(),
    baseline_sha256: digest(inventories),
    candidate_sha256: digest({
      worker_name: candidate.worker_name,
      bindings: effective,
      runtime: desiredRuntime,
    }),
    serving_versions: versions.map(({ version_id, percentage }) => ({ version_id, percentage })),
    changes,
  };
}

export function assertReviewedDrift(
  receipt: BindingDriftReceipt,
  review: unknown,
  now = new Date(),
): void {
  if (receipt.changes.length === 0 && review === undefined) return;
  if (review === undefined)
    throw Error(
      `staging binding drift refused: ${receipt.changes.map((change) => change.name).join(", ")}`,
    );
  const row = object(review, "binding review");
  const expected = [
    "schema_version",
    "source_sha",
    "environment",
    "config_path",
    "worker_name",
    "baseline_sha256",
    "candidate_sha256",
    "serving_versions",
    "changes",
  ] as const;
  const allowed = new Set<string>([
    ...expected,
    "observed_at",
    "reviewed_by_role",
    "review_expires_at",
  ]);
  if (Object.keys(row).some((key) => !allowed.has(key)))
    throw Error("staging binding preflight: unsupported review field");
  for (const key of expected)
    if (!(key in row) || digest(row[key]) !== digest(receipt[key]))
      throw Error("staging binding preflight: review does not match exact release");
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(string(row.reviewed_by_role, "reviewer role")))
    throw Error("staging binding preflight: invalid reviewer role");
  const expiry = Date.parse(string(row.review_expires_at, "review expiry"));
  if (!Number.isFinite(expiry) || expiry <= now.getTime() || expiry - now.getTime() > 30 * 60_000)
    throw Error("staging binding preflight: review expiry must be within thirty minutes");
}

export function assertUnchangedBaseline(
  before: BindingDriftReceipt,
  after: BindingDriftReceipt,
): void {
  if (
    before.source_sha !== after.source_sha ||
    before.environment !== after.environment ||
    before.config_path !== after.config_path ||
    before.worker_name !== after.worker_name ||
    before.baseline_sha256 !== after.baseline_sha256 ||
    before.candidate_sha256 !== after.candidate_sha256
  )
    throw Error(
      "staging binding preflight: serving or candidate configuration changed before upload",
    );
}
