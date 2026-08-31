import { describe, expect, test } from "bun:test";

const PRODUCTION_HYPERDRIVE_ID = "884b68c5a7904982a86620ed90032b77";
const ACCOUNT_ID = "08a4c22cf52e2ecae883e36f80a33f4a";

type JsonRecord = Record<string, unknown>;

const readJsonc = async (path: string): Promise<JsonRecord> =>
  Bun.JSONC.parse(await Bun.file(path).text()) as JsonRecord;

const productionOf = (config: JsonRecord): JsonRecord => {
  const env = config.env as Record<string, JsonRecord> | undefined;
  const production = env?.production;
  if (production === undefined) throw new Error("production environment is undeclared");
  return production;
};

const bindingNames = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value
        .map((entry) => (entry as { binding?: unknown }).binding)
        .filter((binding): binding is string => typeof binding === "string")
    : [];

const resourceNames = (
  value: unknown,
  field: "bucket_name" | "name" | "queue",
): readonly string[] =>
  Array.isArray(value)
    ? value
        .map((entry) => (entry as Record<string, unknown>)[field])
        .filter((name): name is string => typeof name === "string")
    : [];

const configs = {
  data: productionOf(await readJsonc("apps/data-registration-worker/wrangler.jsonc")),
  http: productionOf(await readJsonc("apps/http-worker/wrangler.jsonc")),
  jobs: productionOf(await readJsonc("apps/jobs-worker/wrangler.jsonc")),
  media: productionOf(await readJsonc("apps/media-processor-worker/wrangler.jsonc")),
};

describe("disabled production song infrastructure", () => {
  test("restores every production song runtime gate and schedule to disabled", () => {
    expect(configs.http.vars).toMatchObject({
      MEDIA_UPLOADS_ENABLED: "false",
      MEGAPOT_REWARDS_ENABLED: "false",
    });
    expect(configs.jobs.vars).toMatchObject({
      COMMUNITY_MAINTENANCE_ENABLED: "false",
      MEDIA_PROCESSING_ENABLED: "false",
      DATA_REGISTRATION_ENABLED: "false",
      MEGAPOT_REWARDS_ENABLED: "false",
    });
    expect(configs.media.vars).toMatchObject({
      MEDIA_PROCESSING_ENABLED: "false",
      DATA_REGISTRATION_ENABLED: "false",
      DATA_REGISTRATION_CHAIN_ID: "1315",
    });
    expect(configs.data.vars).toMatchObject({
      API_NEXT_ENV: "production",
      DATA_REGISTRATION_ENABLED: "false",
      DATA_REGISTRATION_CHAIN_ID: "1315",
    });
    expect(configs.jobs.triggers).toEqual({ crons: [] });
  });

  test("keeps queue and schedule Workers off public workers.dev routes", () => {
    for (const worker of [configs.jobs, configs.media, configs.data]) {
      expect(worker.workers_dev).toBe(false);
      expect(worker.preview_urls).toBe(false);
    }
  });

  test("reuses the reviewed production Hyperdrive everywhere", () => {
    for (const worker of [configs.http, configs.jobs, configs.media, configs.data]) {
      expect(worker.hyperdrive).toEqual([
        {
          binding: "CONTROL_PLANE",
          id: PRODUCTION_HYPERDRIVE_ID,
          localConnectionString: "postgres://postgres:postgres@127.0.0.1:5432/postgres",
        },
      ]);
    }
  });

  test("pins the exact R2 topology and the ingress presigner boundary", () => {
    expect(bindingNames(configs.http.r2_buckets)).toEqual([
      "MEDIA_INGRESS",
      "MEDIA_IMMUTABLE_ORIGINALS",
      "LEARNER_AUDIO",
    ]);
    expect(resourceNames(configs.http.r2_buckets, "bucket_name")).toEqual([
      "pirate-media-ingress-production",
      "pirate-media-immutable-production",
      "pirate-learner-audio-production",
    ]);
    expect(configs.http.vars).toMatchObject({
      MEDIA_INGRESS_R2_ACCOUNT_ID: ACCOUNT_ID,
      MEDIA_INGRESS_R2_BUCKET_NAME: "pirate-media-ingress-production",
    });
    expect((configs.http.secrets as JsonRecord).required).toEqual(
      expect.arrayContaining([
        "MEDIA_INGRESS_R2_PRESIGN_ACCESS_KEY_ID",
        "MEDIA_INGRESS_R2_PRESIGN_SECRET_ACCESS_KEY",
      ]),
    );
    expect(resourceNames(configs.media.r2_buckets, "bucket_name")).toEqual([
      "pirate-media-immutable-production",
      "pirate-media-derived-production",
    ]);
    expect(resourceNames(configs.data.r2_buckets, "bucket_name")).toEqual([
      "pirate-media-immutable-production",
    ]);
  });

  test("pins queue, DLQ, and Workflow names", () => {
    const jobsQueues = configs.jobs.queues as JsonRecord;
    expect(resourceNames(jobsQueues.producers, "queue")).toEqual([
      "pirate-media-processing-production",
      "pirate-data-registration-production",
    ]);
    expect(resourceNames(configs.jobs.workflows, "name")).toEqual([
      "pirate-media-processing-production",
      "pirate-data-registration-production",
    ]);

    const mediaQueues = configs.media.queues as JsonRecord;
    expect(mediaQueues.consumers).toEqual([
      expect.objectContaining({
        queue: "pirate-media-processing-production",
        dead_letter_queue: "pirate-media-processing-production-dlq",
      }),
    ]);
    expect(resourceNames(configs.media.workflows, "name")).toEqual([
      "pirate-media-processing-production",
    ]);

    const dataQueues = configs.data.queues as JsonRecord;
    expect(dataQueues.consumers).toEqual([
      expect.objectContaining({
        queue: "pirate-data-registration-production",
        dead_letter_queue: "pirate-data-registration-production-dlq",
      }),
    ]);
    expect(resourceNames(configs.data.workflows, "name")).toEqual([
      "pirate-data-registration-production",
    ]);
  });

  test("keeps DATA secrets exact and Aeneid-only", () => {
    expect((configs.data.secrets as JsonRecord).required).toEqual([
      "DATA_REGISTRATION_PRODUCTION_AENEID_PRIVATE_KEY",
      "FILEBASE_IPFS_TOKEN",
    ]);
    expect(configs.data.vars).toMatchObject({
      DATA_REGISTRATION_RPC_URL: "https://aeneid.storyrpc.io",
      DATA_REGISTRATION_SIGNER_ADDRESS: "0x91016D653FDa20E7C8eb2a1E6710a6504C5d1E7d",
    });
  });

  test("does not require a dormant production Megapot RPC", () => {
    expect(configs.jobs.vars.MEGAPOT_REWARDS_ENABLED).toBe("false");
    expect((configs.jobs.secrets as JsonRecord).required).toEqual([
      "COMMUNITY_PURCHASE_FUNDING_RPC_URL",
    ]);
  });

  test("does not require provider credentials while media processing is disabled", () => {
    expect(configs.media.vars.MEDIA_PROCESSING_ENABLED).toBe("false");
    expect((configs.media.secrets as JsonRecord).required).toEqual([]);
  });

  test("keeps browser CORS aligned with the reviewed production origins", async () => {
    const policy = JSON.parse(
      await Bun.file("infra/cloudflare/song-production/media-ingress-production-cors.json").text(),
    ) as { rules: readonly JsonRecord[] };
    expect(policy.rules).toEqual([
      {
        allowed: {
          origins: ["https://app.pirate", "https://pirate.app", "https://pirate.sc"],
          methods: ["PUT"],
          headers: ["Content-Type"],
        },
        exposeHeaders: ["ETag"],
        maxAgeSeconds: 3600,
      },
    ]);
  });
});
