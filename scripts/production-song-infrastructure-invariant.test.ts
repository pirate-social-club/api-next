import { describe, expect, test } from "bun:test";

const PRODUCTION_HYPERDRIVE_ID = "0c215865d7994c92b940d905f54ece37";
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
  gateway: productionOf(await readJsonc("apps/video-source-gateway/wrangler.jsonc")),
};

describe("disabled production song infrastructure", () => {
  test("keeps production song runtime gates disabled with the independent HNS cron", () => {
    expect(configs.http.vars).toMatchObject({
      MEDIA_UPLOADS_ENABLED: "false",
      SONG_PLAYBACK_ENABLED: "false",
      VIDEO_DELIVERY_ENABLED: "false",
      VIDEO_SONG_REFERENCE_ENABLED: "false",
      VIDEO_PCM_REFERENCE_GATE_ENABLED: "false",
      KARAOKE_FINALIZATION_RECOVERY_ENABLED: "false",
      STUDY_GENERATION_ENABLED: "false",
      STUDY_PROFILE_COVERAGE_ENABLED: "false",
      STUDY_SPOKEN_RERECORD_ENABLED: "false",
      GUEST_STUDY_SERVING_ENABLED: "false",
      MEGAPOT_REWARDS_ENABLED: "false",
    });
    expect(configs.jobs.vars).toMatchObject({
      COMMUNITY_MAINTENANCE_ENABLED: "false",
      MEDIA_PROCESSING_ENABLED: "false",
      VIDEO_ANALYSIS_ENABLED: "false",
      VIDEO_DELIVERY_ENABLED: "false",
      SONG_VIDEO_PCM_ADMISSION_ENABLED: "false",
      KARAOKE_FINALIZATION_RECOVERY_ENABLED: "false",
      DATA_REGISTRATION_ENABLED: "false",
      MEGAPOT_REWARDS_ENABLED: "false",
    });
    expect(configs.media.vars).toMatchObject({
      MEDIA_PROCESSING_ENABLED: "false",
      VIDEO_ANALYSIS_ENABLED: "false",
      VIDEO_DELIVERY_ENABLED: "false",
      VIDEO_CLOUDCONVERT_RENDER_ENABLED: "false",
      SONG_VIDEO_PCM_ADMISSION_ENABLED: "false",
      DATA_REGISTRATION_ENABLED: "false",
      DATA_REGISTRATION_CHAIN_ID: "1315",
    });
    expect(configs.data.vars).toMatchObject({
      API_NEXT_ENV: "production",
      DATA_REGISTRATION_ENABLED: "false",
      DATA_REGISTRATION_CHAIN_ID: "1315",
    });
    expect(configs.jobs.vars.HNS_ROOT_HEALTH_RENEWAL_ENABLED).toBe("true");
    expect(configs.jobs.vars.HNS_OWNERSHIP_ENABLED).toBe("false");
    expect(configs.jobs.triggers).toEqual({ crons: ["*/30 * * * *"] });
  });

  test("keeps queue and schedule Workers off public workers.dev routes", () => {
    for (const worker of [configs.jobs, configs.media, configs.data, configs.gateway]) {
      expect(worker.workers_dev).toBe(false);
      expect(worker.preview_urls).toBe(false);
    }
  });

  test("reuses the reviewed production Hyperdrive everywhere", () => {
    for (const worker of Object.values(configs)) {
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
      "MEDIA_DERIVED",
    ]);
    expect(resourceNames(configs.http.r2_buckets, "bucket_name")).toEqual([
      "pirate-media-ingress-production",
      "pirate-media-immutable-production",
      "pirate-learner-audio-production",
      "pirate-media-derived-production",
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
    expect(configs.jobs.r2_buckets).toEqual([
      { binding: "MEDIA_INGRESS", bucket_name: "pirate-media-ingress-production" },
      { binding: "LEARNER_AUDIO", bucket_name: "pirate-learner-audio-production" },
    ]);
    expect(configs.gateway.r2_buckets).toEqual([
      { binding: "MEDIA_IMMUTABLE_ORIGINALS", bucket_name: "pirate-media-immutable-production" },
    ]);
    expect(configs.http.vars).toMatchObject({
      SONG_PLAYBACK_R2_ACCOUNT_ID: ACCOUNT_ID,
      SONG_PLAYBACK_R2_BUCKET: "pirate-media-immutable-production",
    });
    expect(resourceNames(configs.data.r2_buckets, "bucket_name")).toEqual([
      "pirate-media-immutable-production",
    ]);
  });

  test("pins queue, DLQ, and Workflow names", () => {
    const jobsQueues = configs.jobs.queues as JsonRecord;
    expect(resourceNames(jobsQueues.producers, "queue")).toEqual([
      "pirate-community-telegram-production",
      "pirate-media-processing-production",
      "pirate-data-registration-production",
    ]);
    expect(resourceNames(configs.jobs.workflows, "name")).toEqual([
      "pirate-media-processing-production",
      "pirate-video-analysis-production",
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
      "pirate-video-analysis-production",
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
      "VIDEO_WORKFLOW_READ_TOKEN",
    ]);
  });

  test("prepares v1 provider declarations on their owning Workers while processing stays off", () => {
    expect(configs.media.vars.MEDIA_PROCESSING_ENABLED).toBe("false");
    expect((configs.media.secrets as JsonRecord).required).toEqual([
      "CLOUDCONVERT_RENDER_API_KEY",
      "VIDEO_WORKFLOW_READ_TOKEN",
      "VIDEO_STREAM_API_TOKEN",
      "ACRCLOUD_ACCESS_KEY",
      "ACRCLOUD_ACCESS_SECRET",
      "ELEVENLABS_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "QENCODE_API_KEY",
    ]);
    expect((configs.http.secrets as JsonRecord).required).toEqual(
      expect.arrayContaining([
        "ELEVENLABS_API_KEY",
        "OPENROUTER_API_KEY",
        "SONG_PLAYBACK_R2_ACCESS_KEY_ID",
        "SONG_PLAYBACK_R2_SECRET_ACCESS_KEY",
        "SONG_PLAYBACK_SOURCE_HMAC_BASE64",
        "VIDEO_STREAM_SIGNING_JWK_BASE64",
        "VIDEO_PLAYBACK_SOURCE_HMAC_BASE64",
      ]),
    );
    expect((configs.http.secrets as JsonRecord).required).not.toContain(
      "CLOUDCONVERT_RENDER_API_KEY",
    );
    for (const worker of [configs.jobs, configs.media]) {
      expect(worker.vars).toMatchObject({
        VIDEO_WORKFLOW_ACCOUNT_ID: ACCOUNT_ID,
        VIDEO_WORKFLOW_NAME: "pirate-video-analysis-production",
        VIDEO_WORKFLOW_SCRIPT_NAME: "pirate-media-processor-worker-production",
      });
    }
    // These require production provider evidence; staging values are not a substitute.
    expect(configs.http.vars.VIDEO_STREAM_CUSTOMER_HOST).toBe("");
    expect(configs.http.vars.VIDEO_STREAM_SIGNING_KEY_ID).toBe("");
    expect(configs.media.vars.VIDEO_SOURCE_GATEWAY_ORIGIN).toBe("");
    expect(configs.media.vars.ACRCLOUD_IDENTIFY_HOST).toBe("");
  });

  test("prepares wildcard upload-ingress CORS with only PUT and Content-Type", async () => {
    const policy = JSON.parse(
      await Bun.file("infra/cloudflare/song-production/media-ingress-production-cors.json").text(),
    ) as { rules: readonly JsonRecord[] };
    expect(policy.rules).toEqual([
      {
        allowed: {
          origins: ["*"],
          methods: ["PUT"],
          headers: ["Content-Type"],
        },
        exposeHeaders: ["ETag"],
        maxAgeSeconds: 3600,
      },
    ]);
  });
});
