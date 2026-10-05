import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const isolatedOrigins = {
  api: "https://api-megapot-e2e-staging.pirate.sc",
  web: "https://web-megapot-e2e-staging.pirate.sc",
};
export const isolatedWorkers = {
  http: "pirate-http-worker-megapot-e2e-staging",
  jobs: "pirate-jobs-worker-megapot-e2e-staging",
};
export const isolatedCommitmentOrigin =
  "https://pirate-jobs-worker-megapot-e2e-staging.piratesocialclub.workers.dev";
const buckets = {
  MEDIA_INGRESS: "pirate-media-ingress-megapot-e2e-staging",
  MEDIA_IMMUTABLE_ORIGINALS: "pirate-media-immutable-megapot-e2e-staging",
  LEARNER_AUDIO: "pirate-learner-audio-megapot-e2e-staging",
  MEDIA_DERIVED: "pirate-media-derived-megapot-e2e-staging",
  AVATAR_INGRESS: "pirate-avatar-ingress-megapot-e2e-staging",
  AVATAR_SEALED: "pirate-avatar-sealed-megapot-e2e-staging",
  MEGAPOT_COMMITMENTS: "pirate-megapot-commitments-e2e-staging",
};
const deniedHyperdrives = new Set([
  "8cb7658a0f7143359c1becfec6a15c23",
  "884b68c5a7904982a86620ed90032b77",
  "cf1afd643ad7469fba79694ccac74df3",
  "00000000000000000000000000000000",
]);

/** Flatten the current source configuration and replace every external writable target. */
export function planIsolatedWorker(source, kind, { hyperdriveId, databaseHost, attestationId }) {
  if (
    !["http", "jobs"].includes(kind) ||
    !/^[a-f0-9]{32}$/.test(hyperdriveId) ||
    deniedHyperdrives.has(hyperdriveId) ||
    !/^[a-z0-9.-]+\.pg\.psdb\.cloud$/.test(databaseHost) ||
    !/^megapot-e2e-sepolia-[0-9]{8}-r[0-9]+$/.test(attestationId)
  ) {
    throw new Error("Isolated Worker target identity refused");
  }
  const { env: _environments, ...base } = source;
  const config = { ...base, ...structuredClone(source.env.staging) };
  if (config.hyperdrive?.length !== 1 || config.hyperdrive[0].binding !== "CONTROL_PLANE") {
    throw new Error("Worker database binding inventory changed");
  }
  for (const key of [
    "d1_databases",
    "kv_namespaces",
    "unsafe",
    "dispatch_namespaces",
    "analytics_engine_datasets",
  ]) {
    if (config[key]) throw new Error(`Unreviewed external binding: ${key}`);
  }
  config.name = isolatedWorkers[kind];
  config.main = kind === "http" ? "./dist/http.bundle.mjs" : "../../apps/jobs-worker/src/index.ts";
  config.placement = { mode: "targeted", host: `${databaseHost}:5432` };
  config.hyperdrive = [{ binding: "CONTROL_PLANE", id: hyperdriveId }];
  config.routes =
    kind === "http" ? [{ pattern: new URL(isolatedOrigins.api).host, custom_domain: true }] : [];
  config.services = [];
  config.vpc_services = [];
  config.workflows = [];
  config.queues = { producers: [], consumers: [] };
  delete config.images;
  config.r2_buckets = config.r2_buckets.map((binding) => {
    const name = buckets[binding.binding];
    if (!name) throw new Error(`Unreviewed R2 binding: ${binding.binding}`);
    return { ...binding, bucket_name: name, preview_bucket_name: name };
  });
  config.durable_objects = {
    bindings: (config.durable_objects?.bindings ?? []).map((binding) => {
      if (binding.script_name && binding.name !== "KARAOKE_ATTEMPT") {
        throw new Error(`Unreviewed Durable Object target: ${binding.name}`);
      }
      return binding.script_name ? { ...binding, script_name: isolatedWorkers.http } : binding;
    }),
  };
  config.triggers = { crons: kind === "jobs" ? ["* * * * *"] : [] };
  config.vars = Object.fromEntries(
    Object.entries(config.vars).map(([key, value]) => [
      key,
      key.endsWith("_ENABLED") ? "false" : value,
    ]),
  );
  Object.assign(config.vars, {
    API_NEXT_ENV: "development",
    CORS_ORIGIN: isolatedOrigins.web,
    PIRATE_API_PUBLIC_ORIGIN: isolatedOrigins.api,
    TELEGRAM_PUBLIC_ORIGIN: isolatedOrigins.web,
    TELEGRAM_WEBHOOK_ORIGIN: isolatedOrigins.api,
    MEGAPOT_ATTESTATION_ID: attestationId,
    MEGAPOT_REWARDS_ENABLED: "false",
    MEGAPOT_APPROVED_ALLOWANCE_ATOMIC: "20000",
    MEGAPOT_EXTERNAL_SPONSOR_DAILY_TICKET_CEILING: "2",
    MEGAPOT_EXTERNAL_SPONSOR_DAILY_SPEND_CEILING_ATOMIC: "20000",
    MEGAPOT_SHARED_SPONSOR_DAILY_TICKET_CEILING: "2",
    MEGAPOT_SHARED_SPONSOR_DAILY_SPEND_CEILING_ATOMIC: "20000",
    MEGAPOT_GAS_TOPUP_PLATFORM_DAILY_WEI: "200000000000000",
    KARAOKE_FINALIZATION_RECOVERY_ENABLED: "true",
    SONG_PLAYBACK_ENABLED: "true",
    // The exact historical audio is copied to the runner-owned bucket.
    SONG_PLAYBACK_R2_BUCKET: buckets.MEDIA_IMMUTABLE_ORIGINALS,
    MEDIA_INGRESS_R2_BUCKET_NAME: buckets.MEDIA_INGRESS,
    AVATAR_R2_BUCKET_NAME: buckets.AVATAR_INGRESS,
    VIDEO_WORKFLOW_NAME: "",
    VIDEO_WORKFLOW_SCRIPT_NAME: "",
    ZKPASSPORT_DOMAIN: new URL(isolatedOrigins.web).host,
  });
  if (kind === "jobs") config.vars.MEGAPOT_COMMITMENT_PUBLIC_ORIGIN = isolatedCommitmentOrigin;
  config.secrets = {
    required:
      kind === "http"
        ? [
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
          ]
        : [
            "COMMUNITY_PURCHASE_FUNDING_RPC_URL",
            "MEGAPOT_V2_RPC_URL",
            "MEGAPOT_CUSTODY_PRIVATE_KEY",
            "MEGAPOT_GAS_TOPUP_PRIVATE_KEY",
          ],
  };
  return config;
}

export async function loadIsolatedWorkerPlan(root, identity) {
  async function load(kind) {
    const source = Bun.JSONC.parse(
      await readFile(
        resolve(root, `apps/${kind === "http" ? "http" : "jobs"}-worker/wrangler.jsonc`),
        "utf8",
      ),
    );
    return planIsolatedWorker(source, kind, identity);
  }
  return { http: await load("http"), jobs: await load("jobs") };
}
