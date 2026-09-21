import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  MODERATION_POLICY_CATEGORIES_V1,
  type ModerationPolicyCategoryV1,
} from "@pirate/contracts";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import {
  community,
  finalizedFixture,
  operationId,
  seedVideoActors,
  submissionId,
} from "./video-publication.pg-fixture.ts";
import { makeVideoSafetyEvidenceStore } from "./video-safety-evidence-repository.ts";
import type {
  VideoSafetyEvidence,
  VideoSafetyFrameClaimInput,
  VideoSafetyFrameProviderResult,
  VideoSafetyInput,
} from "./video-safety-provider.ts";
import { VideoSafetyModerationUnresolvedError } from "./video-safety-provider.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString)
  throw new Error("PostgreSQL required");
const suite = connectionString ? describe : describe.skip;
suite("private video safety evidence PostgreSQL fences", () => {
  const schema = `video_safety_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString });
  const scoped = new URL(connectionString ?? "postgresql://unused/unused");
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  const store = makeVideoSafetyEvidenceStore(
    makeDirectPostgresControlPlaneLayer(scoped.toString()),
  );
  const frame = (role: "poster" | "first" | "midpoint") => ({
    role,
    artifactRef: `media://derived/${role}.jpg`,
    sha256: "a".repeat(64),
    timestampMs: 1000,
    requestedTimestampMs: null,
  });
  const input: VideoSafetyInput = {
    submissionId,
    operationId,
    communityId: community,
    videoRevision: 1,
    creationRevision: 1,
    authorDeclaredRating: "general",
    caption: null,
    captionSha256: null,
    frames: [frame("poster"), frame("first"), frame("midpoint")],
  };
  const evidence = (held = false): VideoSafetyEvidence => ({
    requestId: "safety-request",
    inputDigest: "a".repeat(64),
    platformHeld: held,
    policy: null,
    inputs: [],
    fact: {
      requestId: "safety-request",
      evidenceRef: `evidence_${"b".repeat(64)}`,
      minorSafetyEvidenceRef: null,
      mediaSafety: held ? "blocked" : "review_required",
      captionSafety: "not_applicable",
      automatedRating: "general",
      policyRevision: "policy-v1",
      adapterRevision: "video-openai-safety-v1",
    },
  });
  const callInput: VideoSafetyFrameClaimInput = {
    operationId,
    submissionId,
    communityId: community,
    videoRevision: 1,
    creationRevision: 1,
    frameRole: "poster",
    frameArtifactRef: "media://derived/poster.jpg",
    frameSha256: "a".repeat(64),
    timestampMs: 1000,
    requestedTimestampMs: null,
    requestId: "video-safety-operation-1-c1:v1:poster",
  };
  const categories = Object.fromEntries(
    MODERATION_POLICY_CATEGORIES_V1.map((category) => [category, false]),
  ) as Record<ModerationPolicyCategoryV1, boolean>;
  const scores = Object.fromEntries(
    MODERATION_POLICY_CATEGORIES_V1.map((category) => [category, 0.01]),
  ) as Record<ModerationPolicyCategoryV1, number>;
  const appliedInputTypes = Object.fromEntries(
    MODERATION_POLICY_CATEGORIES_V1.map((category) => [category, ["image"] as const]),
  ) as Record<ModerationPolicyCategoryV1, readonly ["image"]>;
  const frameResult: VideoSafetyFrameProviderResult = {
    provider_id: "openai",
    requested_model: "fixture-model",
    returned_model: "fixture-model",
    input_sha256: callInput.frameSha256,
    matched_categories: [],
    evidence: {
      input_sha256: callInput.frameSha256,
      categories,
      scores,
      applied_input_types: appliedInputTypes,
    },
  };
  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await runPostgresMigrations({ connectionString: scoped.toString() });
    await seedVideoActors(admin);
    await finalizedFixture(scoped.toString());
  }, 120_000);
  beforeEach(async () => {
    await admin.query("DELETE FROM media_video_safety_provider_calls");
    await admin.query("DELETE FROM media_video_safety_evidence");
  });
  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });
  test("identical replay retains one fact and a divergent snapshot cannot overwrite it", async () => {
    const previous = evidence();
    const saved: VideoSafetyEvidence = {
      ...previous,
      ratingRuleRevision: "accepted-adult-signals-v2",
      fact: {
        ...previous.fact,
        adapterRevision: "video-openai-safety-v2",
        automatedRating: "adult_18",
      },
    };
    expect(await store.save(input, saved)).toEqual(saved.fact);
    expect(await store.save(input, saved)).toEqual(saved.fact);
    expect(await store.load(input, saved.inputDigest)).toEqual(saved.fact);
    await expect(store.save(input, evidence(true))).rejects.toThrow();
    await expect(store.load(input, "c".repeat(64))).rejects.toThrow();
    expect(
      (await admin.query("SELECT platform_held FROM media_video_safety_evidence")).rows,
    ).toEqual([{ platform_held: false }]);
  });
  test("automatic hold and evidence are one immutable row; superseded creation cannot write", async () => {
    await expect(store.save({ ...input, creationRevision: 2 }, evidence(true))).rejects.toThrow();
    expect(
      (await admin.query("SELECT count(*)::int AS n FROM media_video_safety_evidence")).rows[0].n,
    ).toBe(0);
    await store.save(input, evidence(true));
    expect(
      (await admin.query("SELECT platform_held FROM media_video_safety_evidence")).rows[0]
        .platform_held,
    ).toBe(true);
    await expect(
      admin.query("UPDATE media_video_safety_evidence SET platform_held=false"),
    ).rejects.toThrow("immutable");
  });
  test("a missing fact or invented visual allow cannot be persisted", async () => {
    for (const snapshot of [
      {},
      { ...evidence(), fact: { ...evidence().fact, mediaSafety: "allow" } },
    ])
      await expect(
        admin.query(
          `INSERT INTO media_video_safety_evidence (submission_id,video_revision,creation_revision,request_id,input_sha256,evidence_ref,evidence_snapshot,platform_held) VALUES ($1,1,1,'safety-request',$2,$3,$4::jsonb,false)`,
          [submissionId, "a".repeat(64), `evidence_${"b".repeat(64)}`, JSON.stringify(snapshot)],
        ),
      ).rejects.toThrow();
  });

  test("direct writes reject null and malformed succeeded provider results", async () => {
    const insertSucceeded = (role: "poster" | "first", result: unknown, token: string) =>
      admin.query(
        `INSERT INTO media_video_safety_provider_calls
          (operation_id,submission_id,community_id,video_revision,creation_revision,
           frame_role,frame_artifact_ref,input_sha256,timestamp_ms,requested_timestamp_ms,
           request_id,claim_token,state,provider_result,resolved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'succeeded',$13::jsonb,clock_timestamp())`,
        [
          callInput.operationId,
          callInput.submissionId,
          callInput.communityId,
          callInput.videoRevision,
          callInput.creationRevision,
          role,
          `media://derived/${role}.jpg`,
          callInput.frameSha256,
          callInput.timestampMs,
          callInput.requestedTimestampMs,
          `${callInput.requestId}:${role}`,
          token,
          result === null ? null : JSON.stringify(result),
        ],
      );
    await expect(
      insertSucceeded("poster", null, "00000000-0000-4000-8000-000000000001"),
    ).rejects.toThrow("result_shape");
    await expect(
      insertSucceeded("first", {}, "00000000-0000-4000-8000-000000000002"),
    ).rejects.toThrow("result_shape");

    const owner = await store.claimFrame(callInput);
    if (owner.status !== "dispatch") throw new Error("missing dispatch owner");
    for (const result of [null, {}])
      await expect(
        admin.query(
          `UPDATE media_video_safety_provider_calls
             SET state='succeeded',provider_result=$1::jsonb,resolved_at=clock_timestamp()
           WHERE operation_id=$2 AND video_revision=$3 AND creation_revision=$4 AND frame_role=$5`,
          [
            result === null ? null : JSON.stringify(result),
            callInput.operationId,
            callInput.videoRevision,
            callInput.creationRevision,
            callInput.frameRole,
          ],
        ),
      ).rejects.toThrow("result_shape");
  });

  test("concurrent claims admit one dispatch and persisted success replays", async () => {
    expect(await store.inspectFrame(callInput)).toEqual({ status: "absent" });
    const claims = await Promise.all([store.claimFrame(callInput), store.claimFrame(callInput)]);
    expect(claims.map((claim) => claim.status).sort()).toEqual(["dispatch", "unresolved"]);
    expect(await store.inspectFrame(callInput)).toEqual({ status: "unresolved" });
    const owner = claims.find((claim) => claim.status === "dispatch");
    if (owner?.status !== "dispatch") throw new Error("missing dispatch owner");
    expect(await store.succeedFrame(callInput, owner.claimToken, frameResult)).toEqual(frameResult);
    expect(await store.inspectFrame(callInput)).toEqual({
      status: "succeeded",
      result: frameResult,
    });
    expect(await store.claimFrame(callInput)).toEqual({ status: "succeeded", result: frameResult });
    expect(
      (await admin.query("SELECT count(*)::int AS n FROM media_video_safety_provider_calls"))
        .rows[0].n,
    ).toBe(1);
  });

  test("a crash before or after dispatch leaves an unresolved claim without redispatch", async () => {
    expect(await store.claimFrame(callInput)).toMatchObject({ status: "dispatch" });
    expect(await store.claimFrame(callInput)).toEqual({ status: "unresolved" });
    expect(await store.claimFrame(callInput)).toEqual({ status: "unresolved" });
  });

  test("a claim acquired after inspection atomically fences unavailable aggregate evidence", async () => {
    expect(await store.inspectFrame(callInput)).toEqual({ status: "absent" });
    expect(await store.claimFrame(callInput)).toMatchObject({ status: "dispatch" });
    await expect(store.save(input, evidence(), [callInput])).rejects.toBeInstanceOf(
      VideoSafetyModerationUnresolvedError,
    );
    expect(
      (await admin.query("SELECT count(*)::int AS n FROM media_video_safety_evidence")).rows[0].n,
    ).toBe(0);
  });

  test("aggregate evidence atomically fences a late provider-call claim", async () => {
    await store.save(input, evidence());
    await expect(store.claimFrame(callInput)).rejects.toThrow("aggregate evidence already exists");
    expect(
      (await admin.query("SELECT count(*)::int AS n FROM media_video_safety_provider_calls"))
        .rows[0].n,
    ).toBe(0);
  });

  test("stale and mismatched provider-call identities are rejected", async () => {
    const owner = await store.claimFrame(callInput);
    if (owner.status !== "dispatch") throw new Error("missing dispatch owner");
    await expect(
      store.claimFrame({ ...callInput, requestId: `${callInput.requestId}:stale` }),
    ).rejects.toThrow("identity mismatch");
    await expect(store.claimFrame({ ...callInput, frameSha256: "c".repeat(64) })).rejects.toThrow(
      "identity mismatch",
    );
    await expect(store.succeedFrame(callInput, "wrong-claim-token", frameResult)).rejects.toThrow(
      "completion mismatch",
    );
    await expect(
      admin.query(
        `UPDATE media_video_safety_provider_calls
          SET state='succeeded',provider_result=$1::jsonb,resolved_at=clock_timestamp()
          WHERE operation_id=$2 AND video_revision=$3 AND creation_revision=$4 AND frame_role=$5`,
        [
          JSON.stringify({ ...frameResult, input_sha256: "c".repeat(64) }),
          callInput.operationId,
          callInput.videoRevision,
          callInput.creationRevision,
          callInput.frameRole,
        ],
      ),
    ).rejects.toThrow("result_shape");
    await expect(
      store.succeedFrame(callInput, owner.claimToken, {
        ...frameResult,
        input_sha256: "c".repeat(64),
      }),
    ).rejects.toThrow("shape mismatch");
    await expect(
      store.claimFrame({ ...callInput, creationRevision: 2, requestId: "stale-creation" }),
    ).rejects.toThrow("authority superseded");
  });
});
