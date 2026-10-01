import { resolve } from "node:path";
import {
  type Binding,
  type CandidateBindings,
  object,
  runtime,
  string,
} from "./worker-binding-drift.ts";

const METADATA_FIELDS: Readonly<Record<string, readonly string[]>> = {
  r2_bucket: ["bucket_name", "jurisdiction", "raw"],
  durable_object_namespace: ["class_name", "script_name", "environment"],
  queue: ["queue_name", "delivery_delay", "raw"],
  service: ["service", "environment", "entrypoint", "props"],
  hyperdrive: ["id"],
  version_metadata: [],
  vpc_service: ["service_id"],
  vpc_network: ["network_id"],
  vectorize: ["index_name", "raw"],
  ai: [],
  browser: [],
  images: [],
  analytics_engine: ["dataset"],
  mtls_certificate: ["certificate_id"],
};

function remoteResources(value: unknown, previewField: string): readonly Record<string, unknown>[] {
  if (!Array.isArray(value))
    throw Error("staging binding preflight: invalid native resource inventory");
  return value.map((entry) => {
    const row = { ...object(entry, "native resource") };
    delete row[previewField];
    return row;
  });
}

export function deploymentBinding(name: string, input: unknown): Binding {
  const row = object(input, "candidate binding");
  const type = string(row.type, "candidate binding type");
  if (type === "plain_text") return { name, type, text: row.value };
  if (type === "json") return { name, type, json: row.value };
  if (type === "kv_namespace")
    return {
      name,
      type,
      namespace_id: string(row.id, "KV identity"),
      ...(row.raw === undefined ? {} : { raw: row.raw }),
    };
  if (type === "d1")
    return {
      name,
      type,
      id: string(row.database_id, "D1 identity"),
      ...(row.raw === undefined ? {} : { raw: row.raw }),
    };
  if (type === "workflow")
    return {
      name,
      type,
      workflow_name: string(row.name, "workflow identity"),
      class_name: string(row.class_name, "workflow class"),
      ...(row.script_name === undefined ? {} : { script_name: row.script_name }),
      ...(row.raw === undefined ? {} : { raw: row.raw }),
    };
  const fields = METADATA_FIELDS[type];
  if (fields === undefined)
    throw Error("staging binding preflight: unsupported candidate binding type");
  const selected = Object.fromEntries(
    fields.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]),
  );
  if (
    [
      "r2_bucket",
      "durable_object_namespace",
      "queue",
      "service",
      "hyperdrive",
      "vpc_service",
      "vpc_network",
      "vectorize",
      "mtls_certificate",
    ].includes(type)
  )
    string(selected[fields[0] ?? ""], "native binding identity");
  return { name, type, ...selected };
}

/** Use the installed Wrangler environment resolver and binding converter. */
export async function readCandidateBindings(
  root: string,
  configPath: string,
  environment: string,
): Promise<CandidateBindings> {
  const { unstable_readConfig, unstable_convertConfigBindingsToStartWorkerBindings } = await import(
    "wrangler"
  );
  const config = unstable_readConfig(
    { config: resolve(root, configPath), env: environment },
    { hideWarnings: true },
  );
  if (config.keep_vars)
    throw Error(
      "staging binding preflight: keep_vars requires a supported effective-binding resolver",
    );
  if (config.unsafe?.metadata || config.unsafe?.capnp || config.assets)
    throw Error("staging binding preflight: unsupported upload metadata override");
  // The public converter is for local development. Remove its preview IDs so
  // its result describes the normal remote upload rather than dev resources.
  const deploymentConfig = {
    ...config,
    kv_namespaces: remoteResources(config.kv_namespaces, "preview_id"),
    r2_buckets: remoteResources(config.r2_buckets, "preview_bucket_name"),
    d1_databases: remoteResources(config.d1_databases, "preview_database_id"),
  };
  const converted = unstable_convertConfigBindingsToStartWorkerBindings(deploymentConfig);
  const migration = config.migrations.at(-1);
  return {
    worker_name: string(config.name, "Worker name"),
    bindings: Object.entries(converted).map(([name, row]) => deploymentBinding(name, row)),
    runtime: runtime({
      compatibility_date: config.compatibility_date,
      compatibility_flags: config.compatibility_flags,
      migration_tag: migration?.tag ?? null,
      usage_model: "standard",
    }),
    required_secrets: config.secrets?.required ?? [],
  };
}
