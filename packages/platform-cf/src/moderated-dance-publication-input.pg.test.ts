import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Schema } from "effect";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import {
  applyPostgresTestBaselineConnection,
  createReusablePostgresTestSchemaOwner,
} from "../../../scripts/postgres-test-baseline.ts";
import { prepareDancePublicationInput } from "../../application/src/use-cases/dance/publication-input.ts";
import {
  type ModeratorReview,
  transitionModeratorReview,
} from "../../domain/src/dance/moderator-review.ts";
import { ModeratorReviewFactsSchema } from "../../domain/src/dance/moderator-review-schema.ts";
import {
  crossDeadline,
  historicalReview,
  reviewCommit,
  runBlockedQuery,
} from "./moderated-dance-authority.pg-fixture.ts";
import { seedModeratedDanceIntake as seed } from "./moderated-dance-intake.pg-fixture.ts";
import { makeModeratedDancePublicationInput } from "./moderated-dance-publication-input.ts";
import { makeControlPlaneVideoPublicationStore } from "./video-publication-repository.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && url === undefined)
  throw new Error("Native target required");
const suite = url === undefined ? describe.skip : describe,
  reusableSchema = createReusablePostgresTestSchemaOwner();
setDefaultTimeout(30_000);
afterAll(async () => {
  await reusableSchema.dispose();
});
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
const sql = "SELECT moderated_dance_publication_input_v1($1,$2,$3::jsonb) packet";
const token = "original-handoff";
async function withFixture(
  use: (
    f: Awaited<ReturnType<typeof seed>>,
    admin: Client,
    review: ModeratorReview,
  ) => Promise<void>,
  remainingMs?: number,
  migrated = false,
) {
  if (url === undefined) throw new Error("Native target missing");
  const setup = async ({ admin, schema }: { admin: Client; schema: string }) => {
    const scoped = new URL(url);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    if (migrated)
      await runPostgresMigrations({ connectionString: scoped.toString(), dryRun: false });
    else await applyPostgresTestBaselineConnection({ connectionString: scoped.toString() });
    await admin.query(`SET search_path TO ${quote(schema)}`);
    const f = await seed(admin, scoped.toString(), undefined, { transferWithinMs: 300000 });
    // Synthetic ordinary published song/timing/PCM lineage only. All commands
    // under test run with guards ON. No real camera, provider or R2 is claimed.
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role=replica");
      await admin.query("INSERT INTO persona_profiles(persona_id) VALUES($1)", [f.facts.personaId]);
      await admin.query(
        "INSERT INTO community_memberships(community_id,membership_id,user_id,status,joined_at,created_at,updated_at) VALUES($1,'dance-member',$2,'member',clock_timestamp(),clock_timestamp(),clock_timestamp())",
        [f.facts.communityId, f.facts.accountId],
      );
      await admin.query(
        "INSERT INTO song_owner_policy_revisions(community_id,post_id,audio_revision,owner_account_id,policy_revision,third_party_reward_legs,pool_leg,derivative_video,policy_hash) VALUES($1,$2,$3,'private-test-owner',1,'allowed','allowed','allowed',song_owner_policy_hash_v1($1,$2,$3,'private-test-owner',1,'allowed','allowed','allowed'))",
        [f.facts.communityId, f.facts.songPostId, f.facts.audioRevision],
      );
      await admin.query(
        "INSERT INTO song_owner_policies(community_id,post_id,audio_revision,owner_account_id,current_policy_revision,current_policy_hash) SELECT community_id,post_id,audio_revision,owner_account_id,policy_revision,policy_hash FROM song_owner_policy_revisions",
      );
      await admin.query(
        "INSERT INTO media_song_canonical_timings(song_post_id,audio_revision,song_community_id,canonical_audio_sha256,state,duration_samples,prober_identity,prober_policy_revision,measured_at) VALUES($1,$2,$3,$4,'ready',8640000,'fixture-decoder',1,clock_timestamp())",
        [f.facts.songPostId, f.facts.audioRevision, f.facts.communityId, "a".repeat(64)],
      );
      await admin.query(
        "INSERT INTO media_song_video_pcm_references(song_post_id,audio_revision,canonical_audio_sha256,duration_samples,pcm_object_key,pcm_object_version,pcm_object_etag,pcm_sha256,pcm_byte_length,decoder_recipe) VALUES($1,$2,$3,8640000,'song-video-pcm/fixture','v1','etag',$3,34560000,'fixture')",
        [f.facts.songPostId, f.facts.audioRevision, "a".repeat(64)],
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
    let review = await historicalReview(f, admin, Date.now() + 604200000);
    for (const operation of ["visibility", "verdict"] as const) {
      const actor = {
        kind: "account",
        accountId: operation === "visibility" ? f.facts.accountId : "private-test-owner",
      } as const;
      const at =
        operation === "visibility"
          ? review.capture.uploadedAtMs + 10
          : remainingMs === undefined
            ? Date.now()
            : Date.now() - f.publication.disposition.transferWithinMs + remainingMs;
      const facts = Schema.decodeUnknownSync(ModeratorReviewFactsSchema)(
        (
          await admin.query("SELECT moderated_dance_review_facts_v1($1,$2::jsonb,$3,$4) packet", [
            review.capture.reviewId,
            JSON.stringify(actor),
            operation,
            at,
          ])
        ).rows[0]?.packet,
      );
      const change = transitionModeratorReview(
        review,
        operation === "visibility"
          ? {
              kind: "visibility",
              showPublicly: true,
              disclosureVersion: review.capture.policy.disclosureVersion,
            }
          : { kind: "verdict", verdict: "passed", version: "dance-owner-verdict-attestation-v1" },
        actor,
        review.revision,
        at,
        facts,
      );
      expect(change.refusal).toBeNull();
      await admin.query("SELECT commit_moderated_dance_review_v1($1::jsonb)", [
        JSON.stringify(reviewCommit(review, change, actor, operation, operation, at)),
      ]);
      review = change.state;
    }
    expect(review.publication).toBe("pending");
    await use(f, admin, review);
  };
  if (!migrated)
    return reusableSchema.run({
      baseConnectionString: url,
      schemaName: "dance_publication_input_pg_v1",
      use: setup,
    });
  const admin = new Client({ connectionString: url }),
    schema = `dance_input_acl_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA ${quote(schema)}`);
    await setup({ admin, schema });
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
    await admin.end();
  }
}
const command = (
  admin: Client,
  reviewId: string,
  action: string,
  input: Record<string, unknown> = {},
) =>
  admin
    .query(sql, [reviewId, action, JSON.stringify({ ...input, token, videoTrackEnabled: true })])
    .then((r) => r.rows[0]?.packet);
const protocol = (admin: Client, reviewId: string) =>
  makeModeratedDancePublicationInput({
    reviewId,
    token,
    videoTrackEnabled: true,
    call: async (_label, text, values) => (await admin.query(text, [...values])).rows[0]?.packet,
  });
async function stored(admin: Client, r: ModeratorReview) {
  const id = r.capture.reviewId,
    h = await command(admin, id, "begin"),
    c = r.capture;
  const body = {
    key: h.destination_key,
    sha256: "9".repeat(64),
    size: 1000,
    sourceSha256: c.sourceDigest,
    bodyStartMs: c.bodyStartMs,
    bodyEndMs: c.bodyEndMs,
    durationMs: c.bodyEndMs - c.bodyStartMs,
    transformRevision: "dance-publication-body-v1",
  };
  await command(admin, id, "plan", { body });
  expect((await command(admin, id, "put")).status).toBe("put");
  await command(admin, id, "observe", {
    body: { ...body, version: "independent-v1", etag: "independent-etag" },
  });
  return { h, body };
}

suite("native private Dance input adoption and irreversible copy grants", () => {
  test("a lost put reply cannot authorize another write; one adopted input enters normal analysis without multipart fiction", async () =>
    withFixture(async (f, admin, r) => {
      const { h } = await stored(admin, r),
        id = r.capture.reviewId,
        p = protocol(admin, id);
      expect(await p.put()).toEqual({ status: "unknown" });
      const before = (
        await admin.query("SELECT state FROM dance_moderated_reviews_v1 WHERE review_id=$1", [id])
      ).rows[0]?.state;
      const originalReceipt = (
        await admin.query(
          "SELECT receipt FROM dance_moderated_command_receipts_v1 WHERE operation='verdict'",
        )
      ).rows[0]?.receipt;
      const result = await p.adopt();
      expect(await p.adopt()).toEqual(result);
      expect(
        (
          await admin.query(
            "SELECT count(*)::INTEGER n FROM media_post_submissions WHERE submission_id=$1",
            [h.submission_id],
          )
        ).rows[0]?.n,
      ).toBe(1);
      expect(
        (
          await admin.query(
            "SELECT phase,status,video_revision,event_sequence FROM media_post_submissions WHERE submission_id=$1",
            [h.submission_id],
          )
        ).rows[0],
      ).toEqual({
        phase: "analysis",
        status: "processing",
        video_revision: "1",
        event_sequence: "2",
      });
      expect(
        (
          await admin.query(
            "SELECT input_source,state,multipart_upload_id,multipart_completed_at FROM media_upload_reservations WHERE reservation_id=$1",
            [h.reservation_id],
          )
        ).rows[0],
      ).toEqual({
        input_source: "dance_handoff",
        state: "sealed",
        multipart_upload_id: null,
        multipart_completed_at: null,
      });
      expect(
        (
          await admin.query(
            "SELECT count(*)::INTEGER n FROM media_video_analysis_outbox WHERE submission_id=$1",
            [h.submission_id],
          )
        ).rows[0]?.n,
      ).toBe(1);
      const after = (
        await admin.query("SELECT state FROM dance_moderated_reviews_v1 WHERE review_id=$1", [id])
      ).rows[0]?.state;
      expect(after).toEqual({
        ...before,
        publication: "transferred",
        publicationRevision: before.publicationRevision + 1,
      });
      expect(
        (
          await admin.query(
            "SELECT receipt FROM dance_moderated_command_receipts_v1 WHERE operation='verdict'",
          )
        ).rows[0]?.receipt,
      ).toEqual(originalReceipt);
      expect((await command(admin, id, "inspect")).source_identity).toBeNull();
      expect(await p.cleanup()).toBeNull();
      const normal = makeControlPlaneVideoPublicationStore(f.runtime);
      expect(
        await normal.getReservationForAccount({
          reservationId: h.reservation_id,
          actorAccountId: f.facts.accountId,
        }),
      ).toBeNull();
      await admin.query("SELECT begin_moderated_dance_account_erasure_v1($1)", [f.facts.accountId]);
      expect(await p.adopt()).toEqual(result);
      expect(await p.cleanup()).toBeNull();
    }));
  test("changed source/body/song/persona and disabled video cannot create a Post; every failed transaction leaves no partial adoption", async () =>
    withFixture(async (_f, admin, r) => {
      const { body } = await stored(admin, r),
        id = r.capture.reviewId;
      const prepared = prepareDancePublicationInput(await command(admin, id, "packet"));
      for (const changed of [
        { ...prepared, review: { ...prepared.review, qualificationRef: "forged" } },
        { ...prepared, initial: { ...prepared.initial, authorPersonaId: "foreign" } },
        { ...prepared, sealed: { ...prepared.sealed, phase: "publish" } },
        {
          ...prepared,
          initial: {
            ...prepared.initial,
            songPlan: { ...prepared.initial.songPlan, clipStartSamples: 0 },
          },
        },
      ])
        await expect(command(admin, id, "adopt", { prepared: changed })).rejects.toMatchObject({
          code: "DRV06",
        });
      await expect(
        command(admin, id, "plan", { body: { ...body, sourceSha256: "8".repeat(64) } }),
      ).rejects.toMatchObject({ code: "DRV06" });
      await expect(
        admin.query(sql, [
          id,
          "adopt",
          JSON.stringify({ token, videoTrackEnabled: false, prepared }),
        ]),
      ).rejects.toMatchObject({ code: "DRV05" });
      expect(
        (await admin.query("SELECT count(*)::INTEGER n FROM media_post_submissions")).rows[0]?.n,
      ).toBe(0);
      await protocol(admin, id).adopt();
    }));
  test("a new song-owner prohibition after trimming refuses adoption without touching the passed verdict", async () =>
    withFixture(async (f, admin, r) => {
      await stored(admin, r);
      const id = r.capture.reviewId,
        p = protocol(admin, id);
      const before = (
        await admin.query("SELECT state FROM dance_moderated_reviews_v1 WHERE review_id=$1", [id])
      ).rows[0]?.state;
      await admin.query(
        "SELECT append_song_owner_policy_revision_v1($1,$2,'private-test-owner',1,'allowed','allowed','blocked')",
        [f.facts.communityId, f.facts.songPostId],
      );
      await expect(p.adopt()).rejects.toMatchObject({ code: "DRV05" });
      expect(
        (await admin.query("SELECT count(*)::INTEGER n FROM media_post_submissions")).rows[0]?.n,
      ).toBe(0);
      expect(
        (await admin.query("SELECT state FROM dance_moderated_reviews_v1 WHERE review_id=$1", [id]))
          .rows[0]?.state,
      ).toEqual(before);
    }));
  test("cleanup wins permanently before a late observation or adoption and does not change the passed qualification", async () =>
    withFixture(async (_f, admin, r) => {
      const { h } = await stored(admin, r),
        id = r.capture.reviewId,
        p = protocol(admin, id);
      const before = (
        await admin.query("SELECT state FROM dance_moderated_reviews_v1 WHERE review_id=$1", [id])
      ).rows[0]?.state;
      expect(await p.abandon()).toMatchObject({ key: h.destination_key });
      await expect(p.adopt()).rejects.toMatchObject({ code: "DRV05" });
      await expect(
        admin.query(sql, [id, "cleaned", JSON.stringify({ token, keyFenced: false })]),
      ).rejects.toMatchObject({ code: "DRV05" });
      expect(await p.cleaned()).toEqual({ status: "cleaned" });
      expect(await p.cleanup()).toEqual({ status: "cleaned" });
      expect((await command(admin, id, "inspect")).body_identity).toBeNull();
      expect(
        (await admin.query("SELECT state FROM dance_moderated_reviews_v1 WHERE review_id=$1", [id]))
          .rows[0]?.state,
      ).toEqual(before);
      expect(
        (await admin.query("SELECT count(*)::INTEGER n FROM media_post_submissions")).rows[0]?.n,
      ).toBe(0);
    }));
  test("adoption waits on the actual account fence and then refuses erasure", async () =>
    withFixture(async (f, admin, r) => {
      await stored(admin, r);
      const id = r.capture.reviewId,
        prepared = prepareDancePublicationInput(await command(admin, id, "packet"));
      const other = new Client({ connectionString: f.connection });
      await other.connect();
      const otherPid = (await other.query("SELECT pg_backend_pid() pid")).rows[0]?.pid;
      try {
        await admin.query("BEGIN");
        await admin.query(
          "UPDATE dance_review_account_fences_v1 SET erasing=TRUE,revision=revision+1 WHERE account_id=$1",
          [f.facts.accountId],
        );
        const pending = other
          .query(sql, [id, "adopt", JSON.stringify({ token, videoTrackEnabled: true, prepared })])
          .then(
            () => null,
            (error) => error,
          );
        // Observe the actual row-lock wait before committing invalidation.
        const until = Date.now() + 3000;
        let blocked = false;
        while (Date.now() < until) {
          blocked =
            (
              await admin.query("SELECT pg_backend_pid()=ANY(pg_blocking_pids($1)) blocked", [
                otherPid,
              ])
            ).rows[0]?.blocked === true;
          if (blocked) break;
          await Bun.sleep(5);
        }
        expect(blocked).toBe(true);
        await admin.query("COMMIT");
        expect(await pending).toMatchObject({ code: "DRV05" });
      } finally {
        await admin.query("ROLLBACK");
        await other.end();
      }
    }));
  test("a delayed adoption cannot extend the original transfer deadline", async () =>
    withFixture(async (f, admin, r) => {
      await stored(admin, r);
      const id = r.capture.reviewId,
        prepared = prepareDancePublicationInput(await command(admin, id, "packet"));
      const deadline = new Date(r.transferDeadlineMs ?? 0);
      const outcome = await runBlockedQuery(
        f.connection,
        admin,
        {
          text: "SELECT * FROM song_owner_policies WHERE post_id=$1 FOR UPDATE",
          values: [f.facts.songPostId],
        },
        {
          text: sql,
          values: [id, "adopt", JSON.stringify({ token, videoTrackEnabled: true, prepared })],
        },
        () => crossDeadline(admin, deadline),
      );
      expect("error" in outcome ? outcome.error : null).toMatchObject({ code: "DRV05" });
      expect(await protocol(admin, id).cleanup()).toMatchObject({ status: "cleanup" });
    }, 1500));
  test("the media role can adopt through its function but cannot read raw private state, call the helper or rewrite ordinary upload authority", async () =>
    withFixture(
      async (f, admin, r) => {
        await stored(admin, r);
        const id = r.capture.reviewId,
          role = `dance_input_${crypto.randomUUID().replaceAll("-", "")}`,
          password = crypto.randomUUID();
        await admin.query(
          `CREATE ROLE ${quote(role)} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`,
        );
        const schema = (await admin.query("SELECT current_schema() s")).rows[0]?.s;
        let confined: Client | undefined;
        try {
          await admin.query(`GRANT USAGE ON SCHEMA ${quote(schema)} TO ${quote(role)}`);
          await admin.query("SELECT grant_moderated_dance_runtime_v1($1,'media')", [role]);
          const target = new URL(f.connection);
          target.username = role;
          target.password = password;
          confined = new Client({ connectionString: target.toString() });
          await confined.connect();
          await expect(
            confined.query("SELECT * FROM dance_moderated_publication_inputs_v1"),
          ).rejects.toMatchObject({ code: "42501" });
          await expect(
            confined.query("SELECT moderated_dance_publication_song_v1('{}')"),
          ).rejects.toMatchObject({ code: "42501" });
          const p = protocol(confined, id);
          await p.adopt();
          expect(await p.cleanup()).toBeNull();
        } finally {
          await confined?.end();
          await admin.query(`DROP OWNED BY ${quote(role)}`);
          await admin.query(`DROP ROLE ${quote(role)}`);
        }
      },
      undefined,
      true,
    ));
});
