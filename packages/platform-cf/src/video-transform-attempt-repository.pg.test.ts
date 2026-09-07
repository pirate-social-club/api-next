import { describe, expect, test } from "bun:test";
import type { MediaTransformAttempt } from "@pirate/application/media/transform";
import { Effect } from "effect";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeQencodeMediaTransform } from "./qencode-media-transform.ts";
import { makeControlPlaneVideoAnalysisOutboxRepository } from "./video-analysis-outbox-repository.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString ? describe : describe.skip;

suite("video transform attempt PostgreSQL fences", () => {
  test("drill 1 submit boundary: accepted start with lost response recovers from persisted submitting", async () => {
    const schema = `video_submit_${crypto.randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(connectionString ?? "");
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    try {
      await runPostgresMigrations({ connectionString: scoped.toString() });
      // As in the binding-fence case below, only parent FK triggers are disabled.
      scoped.searchParams.set(
        "options",
        `-c search_path=${schema} -c session_replication_role=replica`,
      );
      const store = makeControlPlaneVideoAnalysisOutboxRepository(
        makeDirectPostgresControlPlaneLayer(scoped.toString()),
      );
      const binding = {
        operationId: "operation",
        videoRevision: 1,
        analysisRevision: 1,
        creationRevision: 1,
        canonicalVideoSha256: "a".repeat(64),
        requestId: "probe-request",
      };
      const initialAttempt: MediaTransformAttempt = {
        version: "media-transform-attempt-v1",
        runtimeFence: { submittedAtMs: 1000, runtimeDeadlineMs: 10000 },
      };
      const ledger = {
        submissionId: "submission",
        binding,
        capability: "probe" as const,
        initialAttempt,
      };
      const request = (attempt: MediaTransformAttempt) => ({
        version: "media-transform-video-probe-input-v1" as const,
        binding,
        attempt,
        source: {
          objectKey: "sealed/video.mp4",
          sha256: binding.canonicalVideoSha256,
          byteLength: 1024,
          mediaType: "video/mp4" as const,
        },
      });
      let starts = 0;
      const adapter = makeQencodeMediaTransform({
        enabled: true,
        apiKey: "fixture-api-key",
        clock: () => 2000,
        transport: {
          createTask: async () => "b".repeat(32),
          startTask: async () => {
            starts++;
            throw new Error("accepted response lost");
          },
          getStatus: async () => ({ state: "processing" }),
        },
        sourceGateway: {
          issue: async (input) => ({
            url: "https://source.example.invalid/grant",
            expiresAtMs: input.expiresAtMs,
          }),
        },
        artifacts: {
          readJson: async () => {
            throw new Error("unexpected output");
          },
          seal: async () => {
            throw new Error("unexpected seal");
          },
        },
      });
      const allocated = await Effect.runPromise(
        adapter.allocate(request(await store.loadOrCreate(ledger))),
      );
      expect(allocated.status).toBe("submitted");
      await store.advance({ ...ledger, attempt: allocated.attempt });
      await expect(
        Effect.runPromise(adapter.submit(request(allocated.attempt))),
      ).rejects.toMatchObject({ reason: "invalid_job_phase" });
      expect(starts).toBe(0);
      const submitting = await store.advance({
        ...ledger,
        attempt: { ...allocated.attempt, providerJobPhase: "submitting" },
      });
      expect((await Effect.runPromise(adapter.submit(request(submitting)))).status).toBe(
        "retryable_failure",
      );
      const restored = await store.loadOrCreate(ledger);
      expect(restored.providerJobPhase).toBe("submitting");
      const observed = await Effect.runPromise(adapter.observe(request(restored)));
      expect(observed.status).toBe("processing");
      await store.advance({ ...ledger, attempt: observed.attempt });
      expect((await store.loadOrCreate(ledger)).providerJobPhase).toBe("started");
      expect(starts).toBe(1);
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  }, 120_000);

  test("drill 7 store boundary: fresh creation preserves replay and forbids skipped or reversed submit phases", async () => {
    const schema = `video_attempt_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(connectionString ?? "");
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    try {
      await runPostgresMigrations({ connectionString: scoped.toString() });
      // This store-boundary test isolates binding/phase SQL. Parent admission
      // remains covered by the composed publication repository suite. Disable
      // FK triggers only; CHECK, UNIQUE and primary-index fences remain active.
      scoped.searchParams.set(
        "options",
        `-c search_path=${schema} -c session_replication_role=replica`,
      );
      const store = makeControlPlaneVideoAnalysisOutboxRepository(
        makeDirectPostgresControlPlaneLayer(scoped.toString()),
      );
      const binding = {
        operationId: "operation",
        videoRevision: 1,
        analysisRevision: 1,
        creationRevision: 1,
        canonicalVideoSha256: "a".repeat(64),
        requestId: "first",
      };
      const initialAttempt: MediaTransformAttempt = {
        version: "media-transform-attempt-v1",
        runtimeFence: { submittedAtMs: 1000, runtimeDeadlineMs: 10000 },
      };
      const input = {
        submissionId: "submission",
        binding,
        capability: "frames" as const,
        initialAttempt,
      };
      expect(await store.loadOrCreate(input)).toEqual(initialAttempt);
      const allocated = {
        ...initialAttempt,
        providerJobId: "provider-task",
        providerJobPhase: "allocated" as const,
      };
      const advance = (attempt: MediaTransformAttempt) => store.advance({ ...input, attempt });
      await expect(advance({ ...allocated, providerJobPhase: "started" })).rejects.toMatchObject({
        reason: "invalid-row",
      });
      expect(await advance(allocated)).toEqual(allocated);
      expect(await advance(allocated)).toEqual(allocated);
      await expect(advance({ ...allocated, providerJobPhase: "started" })).rejects.toMatchObject({
        reason: "invalid-row",
      });
      const submitting = { ...allocated, providerJobPhase: "submitting" as const };
      expect(await advance(submitting)).toEqual(submitting);
      expect(await store.loadOrCreate(input)).toEqual(submitting);
      await expect(advance(allocated)).rejects.toMatchObject({ reason: "invalid-row" });
      const started = { ...allocated, providerJobPhase: "started" as const };
      expect(await advance(started)).toEqual(started);
      await expect(advance({ ...started, providerJobId: "other-task" })).rejects.toMatchObject({
        reason: "invalid-row",
      });
      await expect(
        advance({ ...started, runtimeFence: { submittedAtMs: 1000, runtimeDeadlineMs: 20000 } }),
      ).rejects.toMatchObject({ reason: "invalid-row" });
      await expect(
        store.loadOrCreate({ ...input, binding: { ...binding, creationRevision: 2 } }),
      ).rejects.toMatchObject({ reason: "invalid-row" });
      const retry = {
        ...input,
        binding: { ...binding, requestId: "retry", creationRevision: 2 },
        initialAttempt: {
          ...initialAttempt,
          runtimeFence: { submittedAtMs: 20000, runtimeDeadlineMs: 30000 },
        },
      };
      expect(await store.loadOrCreate(retry)).toEqual(retry.initialAttempt);
      expect(await store.loadOrCreate(input)).toEqual(started);
      const rows = await admin.query(
        `SELECT count(*)::integer AS count FROM "${schema}".media_video_transform_attempts`,
      );
      expect(rows.rows).toEqual([{ count: 2 }]);
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  }, 120_000);
});
