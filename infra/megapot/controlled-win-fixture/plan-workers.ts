/** Generate isolated Worker configs without contacting Cloudflare. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

type Entry = Record<string, unknown>;

const root = resolve(import.meta.dir, "../../..");
const names = {
  http: "pirate-http-worker-megapot-e2e-staging",
  jobs: "pirate-jobs-worker-megapot-e2e-staging",
} as const;
const apiOrigin = "https://api-megapot-e2e-staging.pirate.sc";
const webOrigin = "https://web-megapot-e2e-staging.pirate.sc";
const isolatedBuckets: Readonly<Record<string, string>> = {
  MEDIA_INGRESS: "pirate-media-ingress-megapot-e2e-staging",
  MEDIA_IMMUTABLE_ORIGINALS: "pirate-media-immutable-megapot-e2e-staging",
  LEARNER_AUDIO: "pirate-learner-audio-megapot-e2e-staging",
  MEDIA_DERIVED: "pirate-media-derived-megapot-e2e-staging",
  AVATAR_INGRESS: "pirate-avatar-ingress-megapot-e2e-staging",
  AVATAR_SEALED: "pirate-avatar-sealed-megapot-e2e-staging",
  MEGAPOT_COMMITMENTS: "pirate-megapot-commitments-e2e-staging",
};
const sharedHyperdriveId = "8cb7658a0f7143359c1becfec6a15c23";

function object(value: unknown, label: string): Entry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Entry;
}

function array(value: unknown, label: string): Entry[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry) => object(entry, label));
}

function env(name: string, pattern: RegExp): string {
  const value = process.env[name];
  if (value === undefined || !pattern.test(value)) throw new Error(`${name} is required`);
  return value;
}

function isolateBucket(binding: Entry): Entry {
  const name = binding.binding;
  if (typeof name !== "string" || isolatedBuckets[name] === undefined) {
    throw new Error(`unexpected R2 binding: ${String(name)}`);
  }
  const bucketName = isolatedBuckets[name];
  return {
    ...binding,
    bucket_name: bucketName,
    ...(binding.preview_bucket_name === undefined ? {} : { preview_bucket_name: bucketName }),
  };
}

/** Disabled HNS features must not inherit shared staging's secret-bound settings. */
function withoutSharedHnsSettings(vars: Entry): Entry {
  return Object.fromEntries(Object.entries(vars).filter(([name]) => !name.startsWith("HNS_")));
}

async function stagingConfig(kind: "http" | "jobs"): Promise<Entry> {
  const app = kind === "http" ? "http-worker" : "jobs-worker";
  const path = resolve(root, `apps/${app}/wrangler.jsonc`);
  const parsed = object(Bun.JSONC.parse(await readFile(path, "utf8")), `${app} config`);
  const staging = object(object(parsed.env, `${app} environments`).staging, `${app} staging`);
  const { env: _env, ...base } = parsed;
  return {
    ...base,
    ...structuredClone(staging),
    main: resolve(root, `apps/${app}/src/index.ts`),
    name: names[kind],
  };
}

function isolateHttp(config: Entry, hyperdriveId: string, attestationId: string): Entry {
  const vars = object(config.vars, "HTTP vars");
  const hyperdrive = array(config.hyperdrive, "HTTP Hyperdrive");
  if (hyperdrive.length !== 1 || hyperdrive[0]?.binding !== "CONTROL_PLANE") {
    throw new Error("HTTP database binding drifted");
  }
  const r2 = array(config.r2_buckets, "HTTP R2 buckets");
  array(config.workflows, "HTTP workflows");
  return {
    ...config,
    routes: [{ pattern: new URL(apiOrigin).host, custom_domain: true }],
    workers_dev: true,
    preview_urls: false,
    hyperdrive: [{ ...hyperdrive[0], id: hyperdriveId }],
    workflows: [],
    r2_buckets: r2.map(isolateBucket),
    queues: { producers: [] },
    services: [],
    secrets: {
      required: [
        "PIRATE_APP_JWT_PRIVATE_KEY",
        "PRIVY_APP_SECRET",
        "VERY_WEB_SEALING_KEY",
        "COMMUNITY_PURCHASE_FUNDING_RPC_URL",
        "MEGAPOT_V2_RPC_URL",
        "ELEVENLABS_API_KEY",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "SONG_PLAYBACK_R2_ACCESS_KEY_ID",
        "SONG_PLAYBACK_R2_SECRET_ACCESS_KEY",
        "SONG_PLAYBACK_SOURCE_HMAC_BASE64",
      ],
    },
    vars: {
      ...withoutSharedHnsSettings(vars),
      API_NEXT_ENV: "staging",
      PIRATE_API_PUBLIC_ORIGIN: apiOrigin,
      CORS_ORIGIN: webOrigin,
      MEGAPOT_REWARDS_ENABLED: "false",
      MEGAPOT_ATTESTATION_ID: attestationId,
      MEGAPOT_GAS_TOPUP_PLATFORM_DAILY_WEI: "100000000000000",
      HNS_OWNERSHIP_ENABLED: "false",
      HNS_COMMUNITY_APP_API_ENABLED: "false",
      HNS_HANDLE_HOST_API_ENABLED: "false",
      HNS_EDGE_STATUS_ENABLED: "false",
      SPACES_RUNTIME_ENABLED: "false",
      SPACES_TAPROOT_RECIPIENT_ENABLED: "false",
      TELEGRAM_ENABLED: "false",
      TELEGRAM_PUBLIC_ORIGIN: webOrigin,
      TELEGRAM_WEBHOOK_ORIGIN: apiOrigin,
      MEDIA_INGRESS_R2_BUCKET_NAME: isolatedBuckets.MEDIA_INGRESS,
      AVATAR_R2_BUCKET_NAME: isolatedBuckets.AVATAR_INGRESS,
      // The existing song's immutable audio stays on shared staging. This
      // credential signs GET only; every writable R2 binding stays isolated.
      SONG_PLAYBACK_R2_BUCKET: "pirate-media-immutable-staging",
      VIDEO_DELIVERY_ENABLED: "false",
      VIDEO_SONG_REFERENCE_ENABLED: "false",
      MEDIA_UPLOADS_ENABLED: "false",
      STUDY_GENERATION_ENABLED: "false",
      SONG_PLAYBACK_ENABLED: "true",
      KARAOKE_FINALIZATION_RECOVERY_ENABLED: "false",
      SELF_PASS_ENABLED: "false",
      ZKPASSPORT_ENABLED: "false",
      ZKPASSPORT_DOMAIN: new URL(webOrigin).host,
    },
  };
}

function isolateJobs(config: Entry, hyperdriveId: string, attestationId: string): Entry {
  const vars = object(config.vars, "jobs vars");
  const hyperdrive = array(config.hyperdrive, "jobs Hyperdrive");
  if (hyperdrive.length !== 1 || hyperdrive[0]?.binding !== "CONTROL_PLANE") {
    throw new Error("jobs database binding drifted");
  }
  const r2 = array(config.r2_buckets, "jobs R2 buckets");
  const durable = object(config.durable_objects, "jobs durable objects");
  return {
    ...config,
    workers_dev: true,
    preview_urls: false,
    hyperdrive: [{ ...hyperdrive[0], id: hyperdriveId }],
    durable_objects: {
      ...durable,
      bindings: array(durable.bindings, "jobs durable object bindings").map((binding) =>
        binding.name === "KARAOKE_ATTEMPT" ? { ...binding, script_name: names.http } : binding,
      ),
    },
    queues: { producers: [], consumers: [] },
    r2_buckets: r2.map(isolateBucket),
    workflows: [],
    secrets: {
      required: [
        "COMMUNITY_PURCHASE_FUNDING_RPC_URL",
        "MEGAPOT_V2_RPC_URL",
        "MEGAPOT_CUSTODY_PRIVATE_KEY",
        "MEGAPOT_COMMITMENT_PUBLIC_ORIGIN",
        "MEGAPOT_GAS_TOPUP_PRIVATE_KEY",
      ],
    },
    vars: {
      ...withoutSharedHnsSettings(vars),
      API_NEXT_ENV: "staging",
      TELEGRAM_PUBLIC_ORIGIN: webOrigin,
      TELEGRAM_WEBHOOK_ORIGIN: apiOrigin,
      VIDEO_WORKFLOW_NAME: "",
      VIDEO_WORKFLOW_SCRIPT_NAME: "",
      MEGAPOT_REWARDS_ENABLED: "false",
      MEGAPOT_ATTESTATION_ID: attestationId,
      TELEGRAM_ENABLED: "false",
      AVATAR_CLEANUP_ENABLED: "false",
      COMMUNITY_MAINTENANCE_ENABLED: "false",
      MEDIA_PROCESSING_ENABLED: "false",
      VIDEO_ANALYSIS_ENABLED: "false",
      VIDEO_DELIVERY_ENABLED: "false",
      DATA_REGISTRATION_ENABLED: "false",
      SPACES_RECONCILIATION_ENABLED: "false",
      KARAOKE_FINALIZATION_RECOVERY_ENABLED: "false",
      HNS_OWNERSHIP_ENABLED: "false",
      HNS_ROOT_HEALTH_RENEWAL_ENABLED: "false",
      MEGAPOT_APPROVED_ALLOWANCE_ATOMIC: "10000",
      MEGAPOT_EXTERNAL_SPONSOR_DAILY_TICKET_CEILING: "1",
      MEGAPOT_EXTERNAL_SPONSOR_DAILY_SPEND_CEILING_ATOMIC: "10000",
      MEGAPOT_SHARED_SPONSOR_DAILY_TICKET_CEILING: "1",
      MEGAPOT_SHARED_SPONSOR_DAILY_SPEND_CEILING_ATOMIC: "10000",
    },
  };
}

function assertIsolation(http: Entry, jobs: Entry, hyperdriveId: string): void {
  if (hyperdriveId === sharedHyperdriveId || hyperdriveId === "00000000000000000000000000000000") {
    throw new Error("isolated Hyperdrive must be a real, distinct configuration");
  }
  for (const [kind, config] of [["HTTP", http], ["jobs", jobs]] as const) {
    const database = array(config.hyperdrive, `${kind} Hyperdrive`);
    if (database.length !== 1 || database[0]?.id !== hyperdriveId) {
      throw new Error(`${kind} database is not isolated`);
    }
    for (const binding of array(config.r2_buckets, `${kind} R2 buckets`)) {
      const expected = isolatedBuckets[String(binding.binding)];
      if (expected === undefined || binding.bucket_name !== expected) {
        throw new Error(`${kind} R2 bucket is not isolated: ${String(binding.binding)}`);
      }
    }
    const queues = object(config.queues, `${kind} queues`);
    if (array(queues.producers, `${kind} queue producers`).length > 0 ||
        (queues.consumers !== undefined && array(queues.consumers, `${kind} queue consumers`).length > 0)) {
      throw new Error(`${kind} has shared queue bindings`);
    }
    if (object(config.vars, `${kind} vars`).MEGAPOT_REWARDS_ENABLED !== "false") {
      throw new Error(`${kind} must deploy with rewards off`);
    }
  }
  if (array(http.workflows, "HTTP workflows").length > 0 ||
      array(http.services, "HTTP services").length > 0 ||
      array(jobs.workflows, "jobs workflows").length > 0) {
    throw new Error("isolated Workers retain shared service or workflow bindings");
  }
}

async function main() {
  const hyperdriveId = env("E2E_HYPERDRIVE_ID", /^[0-9a-f]{32}$/u);
  const attestationId = env("E2E_ATTESTATION_ID", /^megapot-e2e-sepolia-[0-9]{8}-r[0-9]+$/u);
  const outDir = resolve(env("E2E_CONFIG_OUT_DIR", /^\/[^\0]+$/u));
  if (!isAbsolute(outDir)) throw new Error("output directory must be absolute");
  const relation = relative(root, outDir);
  if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) {
    throw new Error("write generated configs outside the repository");
  }
  const http = isolateHttp(await stagingConfig("http"), hyperdriveId, attestationId);
  const jobs = isolateJobs(await stagingConfig("jobs"), hyperdriveId, attestationId);
  assertIsolation(http, jobs, hyperdriveId);
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(resolve(outDir, "http.json"), `${JSON.stringify(http, null, 2)}\n`, { mode: 0o600 }),
    writeFile(resolve(outDir, "jobs.json"), `${JSON.stringify(jobs, null, 2)}\n`, { mode: 0o600 }),
  ]);
  console.log(JSON.stringify({ outDir, http: names.http, jobs: names.jobs, apiOrigin, webOrigin }));
}

if (import.meta.main) await main();
