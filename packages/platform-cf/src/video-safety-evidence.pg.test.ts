import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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
import type { VideoSafetyEvidence, VideoSafetyInput } from "./video-safety-provider.ts";

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
  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await runPostgresMigrations({ connectionString: scoped.toString() });
    await seedVideoActors(admin);
    await finalizedFixture(scoped.toString());
  }, 120_000);
  beforeEach(async () => {
    await admin.query("DELETE FROM media_video_safety_evidence");
  });
  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });
  test("identical replay retains one fact and a divergent snapshot cannot overwrite it", async () => {
    const saved = evidence();
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
});
