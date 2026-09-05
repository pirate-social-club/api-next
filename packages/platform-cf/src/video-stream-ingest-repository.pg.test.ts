import { describe, expect, test } from "bun:test";
import type { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  withReusablePostgresTestSchema,
} from "../../../scripts/postgres-test-baseline.ts";
import { consumeVideoStreamIngest } from "../../application/src/video/stream-ingest.ts";
import {
  prepareVideoStreamCopy,
  type VideoStreamIngestState,
} from "../../domain/src/video-stream-ingest.ts";
import {
  attachVideoDecision,
  decideOriginalAudioVideo,
  publishOriginalVideo,
} from "../../domain/src/video-submission.ts";
import {
  finalizedFixture,
  operationId,
  seedVideoActors,
  trustedAnalysis,
} from "./video-publication.pg-fixture.ts";
import { makeVideoStreamIngestStore } from "./video-stream-ingest-repository.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connectionString === undefined)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = connectionString === undefined ? describe.skip : describe;
const effectIdentity = `video-enrichment:${operationId}:stream`;

async function fixture(
  use: (input: Awaited<ReturnType<typeof published>>, admin: Client) => Promise<void>,
) {
  if (!connectionString) throw new Error("Postgres configuration missing");
  await withReusablePostgresTestSchema({
    baseConnectionString: connectionString,
    schemaName: "packages_platform_cf_src_video_stream_ingest_repository_pg_test_ts",
    use: async ({ admin, schema }) => {
      const connection = `${connectionString}${connectionString.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
      await admin.query(`SET search_path TO "${schema.replaceAll('"', '""')}"`);
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await seedVideoActors(admin);
      await use(await published(connection), admin);
    },
  });
}

async function published(connection: string) {
  const { layer, store, finalized } = await finalizedFixture(connection);
  const analysis = trustedAnalysis();
  const decision = decideOriginalAudioVideo({
    state: finalized.state,
    analysis,
    canonicalCaptionSha256: null,
    decidedAt: "2026-09-06T00:00:00.000Z",
  });
  const ready = await store.commitAnalysisDecision({
    submission: finalized.state,
    analysis,
    decision,
    nextState: attachVideoDecision(finalized.state, analysis, decision),
  });
  const publication = publishOriginalVideo(ready.state, "post-video-ingest");
  await store.publish({
    state: publication.state,
    decision,
    originalSound: publication.originalSound,
    poster: {
      artifactRef: analysis.frames.extracted[0].artifactRef,
      canonicalSha256: analysis.frames.extracted[0].sha256,
    },
    derivedArtifacts: analysis.frames.extracted.map((frame) => ({
      artifactRef: frame.artifactRef,
      artifactKind: frame.role,
      canonicalSha256: frame.sha256,
    })),
  });
  const ingest = makeVideoStreamIngestStore(layer, {
    leaseOwner: "delivery-fixture",
    leaseMs: 60_000,
  });
  return { layer, ingest };
}

const deadlines = (now: number) => ({
  acceptanceDeadlineMs: now + 30_000,
  encodingDeadlineMs: now + 300_000,
});
const expire = (admin: Client) =>
  admin.query(
    "UPDATE media_video_enrichment_outbox SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE effect_identity=$1",
    [effectIdentity],
  );

suite("video Stream ingest durable PostgreSQL", () => {
  test("migration refuses legacy in-flight state instead of inventing deadlines", async () => {
    const migration = await Bun.file(
      new URL("../../../db/postgres/migrations/0124_video_delivery_ingest.sql", import.meta.url),
    ).text();
    for (const started of [false, true]) {
      await fixture(async ({ ingest }, admin) => {
        const claim = await ingest.claim(effectIdentity);
        if (!claim) throw new Error("claim missing");
        if (started) {
          const nowMs = Date.now();
          await ingest.transition(
            claim,
            prepareVideoStreamCopy({
              current: claim.state,
              identity: claim.identity,
              nowMs,
              ...deadlines(nowMs),
            }).next,
            false,
          );
        }
        // The guard runs before DDL, so replaying against this fixture is non-mutating.
        await expect(admin.query(migration)).rejects.toThrow(
          started ? "preexisting ingest attempts" : "preexisting running enrichment",
        );
        expect(
          (
            await admin.query(
              "SELECT state FROM media_video_stream_ingests WHERE operation_id=$1",
              [operationId],
            )
          ).rows[0].state,
        ).toBe(started ? "sending" : "not_started");
      });
    }
  });
  test("concurrent ownership, revision CAS, expiry recovery and immutable deadlines", async () => {
    await fixture(async ({ layer, ingest }, admin) => {
      const other = makeVideoStreamIngestStore(layer, {
        leaseOwner: "delivery-other",
        leaseMs: 60_000,
      });
      const [first, second] = await Promise.all([
        ingest.claim(effectIdentity),
        other.claim(effectIdentity),
      ]);
      expect([first, second].filter(Boolean)).toHaveLength(1);
      const winner = first ?? second;
      if (!winner) throw new Error("claim missing");
      const owner = first ? ingest : other;
      expect(winner.identity.creator).toMatch(/^[a-f0-9]{64}$/u);
      const nowMs = Date.now();
      const intent = prepareVideoStreamCopy({
        current: winner.state,
        identity: winner.identity,
        nowMs,
        ...deadlines(nowMs),
      }).next;
      const sending = await owner.transition(winner, intent, false);
      expect(sending?.state.state).toBe("sending");
      expect(await owner.transition(winner, intent, false)).toBeNull();
      await expire(admin);
      const recovered = await ingest.claim(effectIdentity);
      if (!sending || !recovered) throw new Error("recovery missing");
      expect(recovered.fence).toBe(winner.fence + 1);
      expect(recovered.state).toEqual(sending.state);
      expect(await owner.transition(sending, sending.state, true)).toBeNull();
      if (recovered.state.state === "not_started") throw new Error("intent lost");
      expect(
        await ingest.transition(
          recovered,
          { ...recovered.state, acceptanceDeadlineMs: nowMs + 40_000 },
          true,
        ),
      ).toBeNull();
      expect(await ingest.transition(recovered, recovered.state, true)).not.toBeNull();
    });
  });

  test("lost copy and lost completion responses converge on one encode and durable ready", async () => {
    await fixture(async ({ ingest }, admin) => {
      let copies = 0;
      let ready = false;
      const services = {
        store: ingest,
        nowMs: Date.now,
        deadlines,
        transport: {
          copy: async () => {
            copies++;
            throw new Error("copy accepted, response lost");
          },
          observe: async (identity: { creator: string; sourceSha256: string }) => [
            {
              ...identity,
              providerVideoId: "stream-fixture",
              encoding: ready ? ("ready" as const) : ("pending" as const),
              requireSignedURLs: true,
              downloadsEnabled: false,
            },
          ],
        },
      };
      expect(await consumeVideoStreamIngest(effectIdentity, services)).toBe("retry");
      await expire(admin);
      expect(await consumeVideoStreamIngest(effectIdentity, services)).toBe("pending");
      expect(
        (
          await admin.query("SELECT state FROM media_video_stream_ingests WHERE operation_id=$1", [
            operationId,
          ])
        ).rows[0].state,
      ).toBe("bound");
      ready = true;
      const complete = ingest.transition;
      services.store = {
        ...ingest,
        transition: async (...args: Parameters<typeof complete>) => {
          const result = await complete(...args);
          if (result && args[1].state === "ready") throw new Error("completion response lost");
          return result;
        },
      };
      await expect(consumeVideoStreamIngest(effectIdentity, services)).rejects.toThrow(
        "completion response lost",
      );
      expect(await consumeVideoStreamIngest(effectIdentity, services)).toBe("unclaimed");
      expect(copies).toBe(1);
      expect(
        (
          await admin.query(
            "SELECT state,lease_owner,lease_expires_at FROM media_video_enrichment_outbox WHERE effect_identity=$1",
            [effectIdentity],
          )
        ).rows[0],
      ).toEqual({ state: "ready", lease_owner: null, lease_expires_at: null });
      expect(
        (
          await admin.query(
            "SELECT state,provider_video_id FROM media_video_stream_ingests WHERE operation_id=$1",
            [operationId],
          )
        ).rows[0],
      ).toEqual({ state: "ready", provider_video_id: "stream-fixture" });
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM posts WHERE post_id='post-video-ingest'",
          )
        ).rows[0].n,
      ).toBe(1);
    });
  });

  test("payload forgery grants no authority and forged publication revisions fence writes", async () => {
    await fixture(async ({ ingest }, admin) => {
      await admin.query(
        "UPDATE media_video_enrichment_outbox SET payload=$2::jsonb WHERE effect_identity=$1",
        [
          effectIdentity,
          JSON.stringify({
            source_ref: "https://attacker.invalid",
            canonical_video_sha256: "f".repeat(64),
          }),
        ],
      );
      const claim = await ingest.claim(effectIdentity);
      if (!claim) throw new Error("claim missing");
      expect(claim.sealedSourceRef).toBe(`media://immutable/${operationId}/video/1`);
      expect(claim.identity.sourceSha256).toBe("a".repeat(64));
      await expect(
        admin.query(
          "UPDATE media_publication_projections SET creation_revision=creation_revision+1 WHERE operation_id=$1",
          [operationId],
        ),
      ).rejects.toThrow("accepted evidence is immutable");
      const nowMs = Date.now();
      const next = prepareVideoStreamCopy({
        current: claim.state,
        identity: claim.identity,
        nowMs,
        ...deadlines(nowMs),
      }).next;
      expect(
        await ingest.transition(
          {
            ...claim,
            authority: {
              ...claim.authority,
              creationRevision: claim.authority.creationRevision + 1,
            },
          },
          next,
          false,
        ),
      ).toBeNull();
      expect(
        (
          await admin.query("SELECT state FROM media_video_stream_ingests WHERE operation_id=$1", [
            operationId,
          ])
        ).rows[0].state,
      ).toBe("not_started");
    });
  });

  test("initial deadline refusal rolls back and expired leases cannot write", async () => {
    await fixture(async ({ ingest }, admin) => {
      const claim = await ingest.claim(effectIdentity);
      if (!claim) throw new Error("claim missing");
      const next: VideoStreamIngestState = {
        state: "sending",
        identity: claim.identity,
        acceptanceDeadlineMs: 1,
        encodingDeadlineMs: 2,
      };
      await expect(ingest.transition(claim, next, false)).rejects.toThrow(
        "initial deadline expired",
      );
      expect(
        (
          await admin.query(
            "SELECT ingest_revision::text,state FROM media_video_stream_ingests WHERE operation_id=$1",
            [operationId],
          )
        ).rows[0],
      ).toEqual({ ingest_revision: "0", state: "not_started" });
      await expire(admin);
      expect(await ingest.transition(claim, next, false)).toBeNull();
    });
  });

  test("encoding failure atomically stops enrichment and preserves the published Post", async () => {
    await fixture(async ({ ingest }, admin) => {
      expect(
        await consumeVideoStreamIngest(effectIdentity, {
          store: ingest,
          nowMs: Date.now,
          deadlines,
          transport: {
            copy: async () => {},
            observe: async (identity) => [
              {
                ...identity,
                providerVideoId: "failed-stream",
                encoding: "error",
                requireSignedURLs: true,
                downloadsEnabled: false,
              },
            ],
          },
        }),
      ).toBe("failed");
      expect(
        (
          await admin.query(
            "SELECT state,failure_reason,provider_video_id FROM media_video_stream_ingests WHERE operation_id=$1",
            [operationId],
          )
        ).rows[0],
      ).toEqual({
        state: "failed",
        failure_reason: "encoding_failed",
        provider_video_id: "failed-stream",
      });
      expect(
        (
          await admin.query(
            "SELECT state FROM media_video_enrichment_outbox WHERE effect_identity=$1",
            [effectIdentity],
          )
        ).rows[0].state,
      ).toBe("failed");
      expect(
        (await admin.query("SELECT status FROM posts WHERE post_id='post-video-ingest'")).rows[0]
          .status,
      ).toBe("published");
      expect(await ingest.claim(effectIdentity)).toBeNull();
    });
  });
});
