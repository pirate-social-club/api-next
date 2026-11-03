import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./secret-drift-audit.ts";
import { type Binding, bindings, digest } from "./worker-binding-drift.ts";

const workspace = "/media/t42/codedrive/Code/pirate-workspace";
const preparation = `${workspace}/.archive/telegram-production-practice-preparation-20261102`;

/** One reviewed application. Neither CLI arguments nor environment select these identities. */
export const TELEGRAM_RELEASE = {
  operation: "telegram-production-practice-20261103-v1",
  task: "api-telegram-community-study-production",
  source: "5a12186516e29f57e12ba0182f8b2e0c18a8aff9",
  tree: "120799192523685cf82bfcfe2229c45382e21d7b",
  applicationBranch: "release/telegram-production-practice-20261103",
  candidateSha256: "63da409610b6152bc3a736d3b9215eea0c6df99491451fa5667b6f42be8c71b9",
  submissionSha256: "b36b7916d810ed22817c82865789843e212cab7d4e314cd5c89f55f1bd259b83",
  account: "08a4c22cf52e2ecae883e36f80a33f4a",
  resources: [
    "managed-login:cloudflare",
    "managed-login:infisical",
    "database:mqfaju65wdm3",
    "worker:pirate-http-worker-production",
    "worker:pirate-jobs-worker-production",
    "vault:fac45f92-9450-42fb-8c2f-f20d043fdfab:prod:/services/api-next",
    "queue:pirate-community-telegram-production",
  ],
  database: {
    host: "aws-us-east-1-4.pg.psdb.cloud",
    name: "postgres",
    schema: "api_next",
    branch: "mqfaju65wdm3",
    owner: "pscale_api_exl4hoyn673g",
    runtime: "pscale_api_4bxas7gq43a4",
    hyperdrive: "0c215865d7994c92b940d905f54ece37",
    predecessor: 333,
    ledger: 334,
    migration: "0334_study_learner_catalogue_decisions.sql",
    migrationSha256: "46c1565f74e8de9b0498c456205b3073f1bd1bb6e6f9ac81944e75ecef1287c8",
  },
  canary: {
    community: "community_8fef8004-3860-4afe-a3c7-535d1240d1bd",
    post: "media-post-media-operation-20df1594-abcd-4704-a2c8-951c496080ee",
    policy: "telegram_en_general_practice_v1",
    audioRevision: 1,
    lyricsRevision: 1,
    profileRevision: 1,
    lyricsSha256: "ebf59eb1350f14aeb0ab02e2ac2ffbfabd6266022cc4766c2bce1f9deaad8064",
    audioSha256: "c1cd8f562c7aad2c37b815ce74f2a83335143ccca1f7ac5bc49563fcaf73b179",
    decisionRevision: 1,
  },
  vault: {
    project: "fac45f92-9450-42fb-8c2f-f20d043fdfab",
    environment: "prod",
    path: "/services/api-next",
    name: "TELEGRAM_SECRETS_JSON",
    transcription: "ELEVENLABS_API_KEY",
    keyVersion: "v1",
  },
  queue: "pirate-community-telegram-production",
  workers: {
    http: {
      name: "pirate-http-worker-production",
      baseline: "74e1c103-bf85-41b0-a4b6-8c1e222eefa1",
      source: "8ad7bdea62e418a8a67efa5fc791797a196fe7fe",
      baselineModule: "2e47a64ad16579c217a0ca6110086cec22c706ae96ec56f1fe44767a7d88c130",
      module: "6786d069f434ba41ad28ea4f4154f0a5752533204e3f8b4bf5c91eae2eeb4e40",
      config: "apps/http-worker/wrangler.jsonc",
      configSha256: "fd458d283ca8c165f9d4418e0af332ac3138f0a9daf0371e0d595d24fda76eb1",
    },
    jobs: {
      name: "pirate-jobs-worker-production",
      baseline: "e1820cf2-9d3e-4d0f-8f90-7b3c3ca19581",
      source: "6862fa976a2fc387ee0e0274ba9f1b2abc447427",
      baselineModule: "f6a13f53244a2df3001a68845fb83e848a3ed211d8ef0e704be59450b9af5635",
      module: "07c2d949b5e45295e0110eac78043b1f1a13613f029494c69feb7bb774b86a59",
      config: "apps/jobs-worker/wrangler.jsonc",
      configSha256: "a10336231857dca0023ec6fff4b43c4db9c6588cdeb001aa252de065dce67a0f",
    },
  },
  paths: {
    tooling: fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, ""),
    application: `${workspace}/.worktrees/api-next/api-telegram-production-application-20261103`,
    preparation,
    submission: `${preparation}/source-preparation-20261103`,
    artifacts: `${preparation}/source-preparation-20261103/application-artifacts`,
    operation: `${preparation}/operation-20261103`,
    processQualification: `${preparation}/source-preparation-20261103/process-qualification`,
  },
} as const;

export type TelegramWorker = keyof typeof TELEGRAM_RELEASE.workers;
export const TELEGRAM_PHASES = {
  migration: { action: "database-334", predecessors: [] },
  grants: { action: "runtime-grants", predecessors: ["migration"] },
  vault: { action: "wrapping-key-create", predecessors: ["grants"] },
  "install-jobs": { action: "workers-install-disabled", predecessors: ["vault"] },
  "install-http": { action: "workers-install-disabled", predecessors: ["install-jobs"] },
  "connect-jobs": { action: "connect-only", predecessors: ["install-http"] },
  "connect-http": { action: "connect-only", predecessors: ["connect-jobs"] },
  catalogue: { action: "catalogue-canary", predecessors: ["connect-http"] },
  "practice-jobs": { action: "community-practice-enable", predecessors: ["catalogue"] },
  "practice-http": { action: "community-practice-enable", predecessors: ["practice-jobs"] },
  "pause-intent": { action: "recover-disabled", predecessors: [] },
  "pause-http": { action: "recover-disabled", predecessors: ["pause-intent"] },
  "pause-jobs": { action: "recover-disabled", predecessors: ["pause-http"] },
  "recover-http": { action: "recover-disabled", predecessors: ["pause-jobs"] },
  "recover-jobs": { action: "recover-disabled", predecessors: ["recover-http"] },
} as const;
export type TelegramPhase = keyof typeof TELEGRAM_PHASES;
export type TelegramAction = (typeof TELEGRAM_PHASES)[TelegramPhase]["action"];

export class TelegramReleaseRefused extends Error {}
export function requireTelegram(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new TelegramReleaseRefused(reason);
}

/** Jobs must accept the mode before HTTP can admit its first learner. */
export function telegramMode(phase: TelegramPhase) {
  return {
    version: 1,
    enabled: phase.startsWith("connect-") || phase.startsWith("practice-"),
    linking_enabled: false,
    practice_enabled: false,
    community_practice_enabled: phase.startsWith("practice-"),
    public_origin: "https://pirate.sc",
    webhook_origin: "https://api-next.pirate.sc",
    credential_active_version: TELEGRAM_RELEASE.vault.keyVersion,
    ...(phase.startsWith("practice-")
      ? { community_practice_policy_revision: TELEGRAM_RELEASE.canary.policy }
      : {}),
  } as const;
}

function configObject(value: unknown): Record<string, unknown> {
  requireTelegram(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "phase-config-object-required",
  );
  return value as Record<string, unknown>;
}
export function telegramPhaseConfig(worker: TelegramWorker, phase: TelegramPhase, source: string) {
  const root = parseJsonc<Record<string, unknown>>(source),
    production = configObject(configObject(root.env).production);
  const config = { ...root, ...production };
  delete config.env;
  delete config.$schema;
  config.main = resolve(TELEGRAM_RELEASE.paths.artifacts, worker, "bundle/index.js");
  config.vars = {
    ...configObject(production.vars),
    TELEGRAM_CONFIG_JSON: JSON.stringify(telegramMode(phase)),
  };
  const secrets = config.secrets === undefined ? {} : configObject(config.secrets);
  const required = secrets.required === undefined ? [] : secrets.required;
  requireTelegram(
    Array.isArray(required) && required.every((name) => typeof name === "string"),
    "secret-declaration-refused",
  );
  config.secrets = {
    ...secrets,
    required: [
      ...new Set([
        ...required,
        TELEGRAM_RELEASE.vault.name,
        ...(worker === "jobs" ? [TELEGRAM_RELEASE.vault.transcription] : []),
      ]),
    ],
  };
  requireTelegram(
    config.name === TELEGRAM_RELEASE.workers[worker].name &&
      config.account_id === TELEGRAM_RELEASE.account,
    "phase-config-target-differs",
  );
  return config;
}

/** Only the Telegram intent and the two named secret additions may differ. */
export function telegramBindingDelta(
  worker: TelegramWorker,
  before: readonly Binding[],
  after: readonly Binding[],
  phase: TelegramPhase,
  initial: boolean,
) {
  const left = bindings(before),
    right = bindings(after);
  const permitted = new Set([
    "TELEGRAM_CONFIG_JSON",
    TELEGRAM_RELEASE.vault.name,
    ...(worker === "jobs" ? [TELEGRAM_RELEASE.vault.transcription] : []),
  ]);
  requireTelegram(
    digest(left.filter((r) => !permitted.has(r.name))) ===
      digest(right.filter((r) => !permitted.has(r.name))),
    "unrelated-worker-binding-drift",
  );
  const mode = right.find((r) => r.name === "TELEGRAM_CONFIG_JSON");
  requireTelegram(
    mode?.type === "plain_text" && mode.text === JSON.stringify(telegramMode(phase)),
    "telegram-mode-differs",
  );
  for (const name of [...permitted].filter((name) => name !== "TELEGRAM_CONFIG_JSON")) {
    const previous = left.find((r) => r.name === name),
      current = right.find((r) => r.name === name);
    requireTelegram(
      current?.type === "secret_text" && (!previous || digest(previous) === digest(current)),
      "telegram-secret-binding-differs",
    );
    if (initial) requireTelegram(!previous, "unexpected-preexisting-secret-binding");
  }
}
export function telegramQueueConsumer(queue: unknown, consumers: unknown) {
  const q = configObject(queue);
  requireTelegram(
    q.queue_name === TELEGRAM_RELEASE.queue &&
      typeof q.queue_id === "string" &&
      Array.isArray(consumers),
    "production-telegram-queue-missing",
  );
  const rows = consumers.map(configObject);
  requireTelegram(
    rows.length === 1 &&
      rows[0]?.type === "worker" &&
      rows[0]?.script_name === TELEGRAM_RELEASE.workers.jobs.name &&
      (rows[0]?.environment === undefined || rows[0]?.environment === "production"),
    "telegram-consumer-not-the-production-jobs-worker",
  );
  return { queue: q.queue_name, id: q.queue_id, consumers: rows };
}

export function assertTelegramHyperdriveOrigin(value: unknown) {
  const origin = configObject(value);
  requireTelegram(
    origin.scheme === "postgres" &&
      origin.host === TELEGRAM_RELEASE.database.host &&
      origin.database === TELEGRAM_RELEASE.database.name &&
      Number(origin.port) === 5432 &&
      origin.user === `${TELEGRAM_RELEASE.database.runtime}.${TELEGRAM_RELEASE.database.branch}`,
    "actual-hyperdrive-origin-differs",
  );
  return {
    host: String(origin.host),
    database: String(origin.database),
    port: 5432,
    user: String(origin.user),
    hyperdrive: TELEGRAM_RELEASE.database.hyperdrive,
  };
}
