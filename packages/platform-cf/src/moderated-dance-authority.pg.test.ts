import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Effect, Schema } from "effect";
import type { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  createReusablePostgresTestSchemaOwner,
} from "../../../scripts/postgres-test-baseline.ts";
import { executeDanceReviewCommand } from "../../application/src/use-cases/dance/moderator-review-services.ts";
import { transitionModeratorReview } from "../../domain/src/dance/moderator-review.ts";
import { ModeratorReviewFactsSchema } from "../../domain/src/dance/moderator-review-schema.ts";
import { makeControlPlaneModeratorReviewStore } from "./dance-moderator-review-repository.ts";
import {
  claimMedia,
  crossDeadline,
  historicalReview,
  reserveUpload,
  reviewCommit,
  runBlockedQuery,
} from "./moderated-dance-authority.pg-fixture.ts";
import { seedModeratedDanceIntake as seed } from "./moderated-dance-intake.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

// These native cases use the maintained baseline and fictional bootstrap inputs.
// They make no provider request, upload or real-recording acceptance claim.
const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && url === undefined)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = url === undefined ? describe.skip : describe;
const reusableSchema = createReusablePostgresTestSchemaOwner();
setDefaultTimeout(30_000);
afterAll(async () => {
  await reusableSchema.dispose();
});
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;

async function withFixture(
  use: (f: Awaited<ReturnType<typeof seed>>, admin: Client) => Promise<void>,
) {
  if (url === undefined) throw new Error("Isolated target not configured");
  return reusableSchema.run({
    baseConnectionString: url,
    schemaName: "moderated_dance_authority_pg_v1",
    use: async ({ admin, schema }) => {
      const scoped = new URL(url);
      scoped.searchParams.set("options", `-c search_path=${schema}`);
      await applyPostgresTestBaselineConnection({ connectionString: scoped.toString() });
      await admin.query(`SET search_path TO ${quote(schema)}`);
      expect(
        (
          await admin.query(
            "SELECT to_regprocedure('read_moderated_dance_capture_options_v1(text,text,text,text)') IS NOT NULL AS present",
          )
        ).rows[0]?.present,
      ).toBe(true);
      await use(await seed(admin, scoped.toString()), admin);
    },
  });
}

suite("moderated Dance authority after real blocking locks", () => {
  test("a future terminal timestamp cannot persist premature review expiry", async () =>
    withFixture(async (f, admin) => {
      const before = await historicalReview(f, admin, Date.now() + 60_000);
      const actor = { kind: "account", accountId: before.capture.accountId } as const;
      const future = before.reviewDeadlineMs + 1;
      const facts = Schema.decodeUnknownSync(ModeratorReviewFactsSchema)(
        (
          await admin.query(
            "SELECT moderated_dance_review_facts_v1($1,$2::jsonb,'visibility',$3) AS packet",
            [before.capture.reviewId, JSON.stringify(actor), future],
          )
        ).rows[0]?.packet,
      );
      const transition = transitionModeratorReview(
        before,
        {
          kind: "visibility",
          showPublicly: false,
          disclosureVersion: before.capture.policy.disclosureVersion,
        },
        actor,
        before.revision,
        future,
        facts,
      );
      expect(transition.state.state).toBe("review_expired");
      await expect(
        admin.query("SELECT commit_moderated_dance_review_v1($1::jsonb)", [
          JSON.stringify(
            reviewCommit(before, transition, actor, "visibility", "premature-expiry", future),
          ),
        ]),
      ).rejects.toMatchObject({ code: "DRV05", message: "premature or invalid review expiry" });
      expect((await admin.query("SELECT status FROM dance_moderated_reviews_v1")).rows).toEqual([
        { status: "awaiting_review" },
      ]);
      expect(
        (await admin.query("SELECT count(*)::INTEGER n FROM dance_moderated_result_events_v1"))
          .rows[0]?.n,
      ).toBe(0);
      expect(
        (await admin.query("SELECT count(*)::INTEGER n FROM dance_moderated_command_receipts_v1"))
          .rows[0]?.n,
      ).toBe(0);
    }));

  test("an uploaded predecessor cannot masquerade as an expired submitted review", async () =>
    withFixture(async (f, admin) => {
      const before = await historicalReview(f, admin, Date.now() - 1000, "uploaded");
      const actor = { kind: "account", accountId: before.capture.accountId } as const;
      const now = Date.now();
      const facts = Schema.decodeUnknownSync(ModeratorReviewFactsSchema)(
        (
          await admin.query(
            "SELECT moderated_dance_review_facts_v1($1,$2::jsonb,'visibility',$3) AS packet",
            [before.capture.reviewId, JSON.stringify(actor), now],
          )
        ).rows[0]?.packet,
      );
      const original = transitionModeratorReview(
        before,
        {
          kind: "visibility",
          showPublicly: false,
          disclosureVersion: before.capture.policy.disclosureVersion,
        },
        actor,
        before.revision,
        now,
        facts,
      );
      expect(original.state.state).toBe("expired");
      const forged = {
        ...original,
        state: { ...original.state, state: "review_expired" as const },
      };
      await expect(
        admin.query("SELECT commit_moderated_dance_review_v1($1::jsonb)", [
          JSON.stringify(
            reviewCommit(before, forged, actor, "visibility", "wrong-predecessor", now),
          ),
        ]),
      ).rejects.toMatchObject({ code: "DRV05", message: "premature or invalid review expiry" });
      expect((await admin.query("SELECT status FROM dance_moderated_reviews_v1")).rows).toEqual([
        { status: "uploaded" },
      ]);
    }));

  test("an account command at the real deadline records one expired result and inbox item", async () =>
    withFixture(async (f, admin) => {
      const before = await historicalReview(f, admin, Date.now() - 1000);
      const actor = { kind: "account", accountId: before.capture.accountId } as const;
      const store = makeControlPlaneModeratorReviewStore(f.runtime, {
        account: () => Effect.succeed(actor),
        worker: () => Effect.succeed({ kind: "worker", accountId: "fixture-worker" }),
      });
      const command = {
        version: "dance-review-visibility-v1",
        operation: "visibility",
        idempotency_key: "actual-expiry",
        community_id: before.capture.communityId,
        review_id: before.capture.reviewId,
        expected_review_revision: before.revision,
        show_publicly_if_passed: false,
        publication_disclosure_version: before.capture.policy.disclosureVersion,
      } as const;
      const receipt = await Effect.runPromise(executeDanceReviewCommand(command, store));
      expect(receipt.result.state).toBe("review_expired");
      expect(receipt.refusal_code).toBe("review_deadline_reached");
      expect(await Effect.runPromise(executeDanceReviewCommand(command, store))).toEqual(receipt);
      expect(
        (await admin.query("SELECT count(*)::INTEGER n FROM dance_moderated_result_events_v1"))
          .rows[0]?.n,
      ).toBe(1);
      expect(
        (
          await admin.query(
            "SELECT count(*)::INTEGER n FROM notification_inbox WHERE dance_result_event_id IS NOT NULL",
          )
        ).rows[0]?.n,
      ).toBe(1);
      expect(
        (await admin.query("SELECT count(*)::INTEGER n FROM activity_qualifications")).rows[0]?.n,
      ).toBe(0);
    }));

  test("recipient advisory lock precedes user locks on the actual verdict path", async () =>
    withFixture(async (f, admin) => {
      const before = await historicalReview(f, admin, Date.now() + 60_000);
      const actor = { kind: "account", accountId: "private-test-owner" } as const;
      const command = {
        actor,
        operation: "verdict",
        idempotencyKey: "lock-order",
        requestHash: "a".repeat(64),
        receiptId: "lock-order",
        communityId: before.capture.communityId,
        reviewId: before.capture.reviewId,
      };
      const result = await runBlockedQuery(
        f.connection,
        admin,
        {
          text: "SELECT pg_advisory_xact_lock(hashtextextended('notifications-recipient-v1:'||$1,0))",
          values: [before.capture.accountId],
        },
        {
          text: "SELECT lock_moderated_dance_review_v1($1::jsonb) AS packet",
          values: [JSON.stringify(command)],
        },
        async () => {
          await admin.query("SET LOCAL lock_timeout='250ms'");
          await admin.query("SELECT 1 FROM users WHERE user_id=$1 FOR UPDATE", [
            before.capture.accountId,
          ]);
          expect(
            (await admin.query("SELECT count(*)::INTEGER n FROM activity_qualifications")).rows[0]
              ?.n,
          ).toBe(0);
        },
      );
      if (!("result" in result)) throw result.error;
      expect(result.result.rows[0]?.packet.capture.reviewId).toBe(before.capture.reviewId);
      const store = makeControlPlaneModeratorReviewStore(
        makeDirectPostgresControlPlaneLayer(f.connection),
        {
          account: () => Effect.succeed(actor),
          worker: () => Effect.succeed({ kind: "worker", accountId: "fixture-worker" }),
        },
      );
      const receipt = await Effect.runPromise(
        executeDanceReviewCommand(
          {
            version: "dance-owner-verdict-attestation-v1",
            operation: "verdict",
            idempotency_key: "actual-verdict",
            community_id: before.capture.communityId,
            review_id: before.capture.reviewId,
            expected_review_revision: before.revision,
            verdict: "passed",
          },
          store,
        ),
      );
      expect(receipt.result.verdict).toBe("passed");
      expect(
        (
          await admin.query(
            "SELECT activity_key,streak_day::TEXT,qualification_count::INTEGER FROM song_streak_day_activities WHERE account_id=$1 AND post_id=$2",
            [before.capture.accountId, before.capture.songPostId],
          )
        ).rows,
      ).toEqual([
        { activity_key: "dance", streak_day: before.submissionDay?.day, qualification_count: 1 },
      ]);
      expect(
        (
          await admin.query(
            "SELECT streak_day::TEXT,first_qualification_id FROM community_streak_days WHERE account_id=$1 AND community_id=$2",
            [before.capture.accountId, before.capture.communityId],
          )
        ).rows,
      ).toEqual([
        { streak_day: before.submissionDay?.day, first_qualification_id: before.capture.reviewId },
      ]);
      expect(
        (
          await admin.query(
            "SELECT count(*)::INTEGER n FROM activity_qualifications WHERE activity_key='dance'",
          )
        ).rows[0]?.n,
      ).toBe(1);
      expect(
        (
          await admin.query(
            "SELECT count(*)::INTEGER n FROM notification_inbox WHERE dance_result_event_id IS NOT NULL",
          )
        ).rows[0]?.n,
      ).toBe(1);
    }));

  test("a seal claim blocked past original expiry grants nothing", async () =>
    withFixture(async (f, admin) => {
      const uploadId = await reserveUpload(f);
      const deadline = (
        await admin.query(
          "UPDATE dance_moderated_uploads_v1 SET expires_at=clock_timestamp()+interval '2 seconds' WHERE upload_id=$1 RETURNING expires_at",
          [uploadId],
        )
      ).rows[0]?.expires_at;
      const result = await runBlockedQuery(
        f.connection,
        admin,
        { text: "SELECT 1 FROM users WHERE user_id=$1 FOR UPDATE", values: [f.facts.accountId] },
        claimMedia(f, "blocked-seal"),
        async () => {
          expect(
            (await admin.query("SELECT clock_timestamp()<$1::TIMESTAMPTZ AS before", [deadline]))
              .rows[0]?.before,
          ).toBe(true);
          await crossDeadline(admin, deadline);
        },
      );
      if (!("result" in result)) throw result.error;
      expect(result.result.rows[0]?.packet).toBeNull();
      expect(
        (
          await admin.query(
            "SELECT seal_dispatched_at FROM dance_moderated_uploads_v1 WHERE upload_id=$1",
            [uploadId],
          )
        ).rows[0]?.seal_dispatched_at,
      ).toBeNull();
    }));

  test("a provider-budget wait past expiry rolls back both dispatch and charge", async () =>
    withFixture(async (f, admin) => {
      const uploadId = await reserveUpload(f);
      const claim = claimMedia(f, "budget-seal");
      const seal = (await admin.query(claim.text, claim.values)).rows[0]?.packet;
      expect(seal.action).toBe("seal");
      const ingress = (
        await admin.query(
          "SELECT private_object_key FROM dance_moderated_uploads_v1 WHERE upload_id=$1",
          [uploadId],
        )
      ).rows[0]?.private_object_key;
      await Bun.sleep(2);
      await admin.query("SELECT persist_moderated_dance_seal_v1($1,$2,$3::jsonb)", [
        uploadId,
        seal.token,
        JSON.stringify({
          outcome: "sealed",
          destination_ref: `moderated-dance/originals/${uploadId}/source`,
          version: "fixture-original",
          etag: "fixture-etag",
          size_bytes: 1000,
          canonical_sha256: "a".repeat(64),
          firstStoredAtMs: Date.now(),
          ingress_identity: {
            key: ingress,
            version: "fixture-ingress",
            etag: "fixture-ingress-etag",
            size: 1000,
          },
        }),
      ]);
      const width = f.facts.profile.windowMs;
      const bucket = (
        await admin.query(
          "SELECT (floor(extract(epoch FROM clock_timestamp())*1000)::BIGINT/$1::BIGINT)*$1::BIGINT AS bucket",
          [width],
        )
      ).rows[0]?.bucket;
      await admin.query(
        "INSERT INTO dance_moderated_provider_usage_v1 VALUES('global',$1,$2,0),($3,$1,$2,0)",
        [bucket, width, `account:${f.facts.accountId}`],
      );
      const deadline = (
        await admin.query(
          "UPDATE dance_moderated_uploads_v1 SET expires_at=clock_timestamp()+interval '2 seconds' WHERE upload_id=$1 RETURNING expires_at",
          [uploadId],
        )
      ).rows[0]?.expires_at;
      const result = await runBlockedQuery(
        f.connection,
        admin,
        {
          text: "SELECT 1 FROM dance_moderated_provider_usage_v1 WHERE scope='global' AND window_start_ms=$1 AND window_ms=$2 FOR UPDATE",
          values: [bucket, width],
        },
        claimMedia(f, "blocked-provider"),
        async () => {
          expect(
            (await admin.query("SELECT clock_timestamp()<$1::TIMESTAMPTZ AS before", [deadline]))
              .rows[0]?.before,
          ).toBe(true);
          await crossDeadline(admin, deadline);
        },
      );
      expect(result).toMatchObject({ error: { code: "DRV05" } });
      expect(
        (
          await admin.query(
            "SELECT state,charged_calls FROM dance_moderated_processing_v1 WHERE upload_id=$1",
            [uploadId],
          )
        ).rows,
      ).toEqual([{ state: "ready", charged_calls: "0" }]);
      expect(
        (
          await admin.query(
            "SELECT sum(charged_microunits)::TEXT AS total FROM dance_moderated_provider_usage_v1",
          )
        ).rows[0]?.total,
      ).toBe("0");
    }));

  test("a private playback lease cannot be issued after a blocking read-budget wait crosses expiry", async () =>
    withFixture(async (f, admin) => {
      const before = await historicalReview(f, admin, Date.now() + 2000);
      const width = f.facts.profile.windowMs;
      const bucket = (
        await admin.query(
          "SELECT (floor(extract(epoch FROM clock_timestamp())*1000)::BIGINT/$1::BIGINT)*$1::BIGINT AS bucket",
          [width],
        )
      ).rows[0]?.bucket;
      await admin.query(
        "INSERT INTO dance_moderated_intake_usage_v1 VALUES('private-test-owner',$1,$2,0,0,0)",
        [bucket, width],
      );
      const result = await runBlockedQuery(
        f.connection,
        admin,
        {
          text: "SELECT 1 FROM dance_moderated_intake_usage_v1 WHERE account_id='private-test-owner' AND window_start_ms=$1 AND window_ms=$2 FOR UPDATE",
          values: [bucket, width],
        },
        {
          text: "SELECT issue_moderated_dance_media_lease_v1($1,$2,$3,$4,'owner',$5) AS packet",
          values: [
            "private-test-owner",
            before.capture.communityId,
            before.capture.reviewId,
            before.revision,
            "L".repeat(43),
          ],
        },
        async () => {
          expect(
            (
              await admin.query("SELECT clock_timestamp()<$1::TIMESTAMPTZ AS before", [
                new Date(before.reviewDeadlineMs),
              ])
            ).rows[0]?.before,
          ).toBe(true);
          await crossDeadline(admin, new Date(before.reviewDeadlineMs));
        },
      );
      expect(result).toMatchObject({ error: { code: "DRV02" } });
      expect(
        (await admin.query("SELECT count(*)::INTEGER n FROM dance_moderated_media_leases_v1"))
          .rows[0]?.n,
      ).toBe(0);
      expect(
        (
          await admin.query(
            "SELECT reads FROM dance_moderated_intake_usage_v1 WHERE account_id='private-test-owner'",
          )
        ).rows[0]?.reads,
      ).toBe("0");
    }));
  test("an existing private lease yields no bytes after a blocking budget wait crosses its deadline", async () =>
    withFixture(async (f, admin) => {
      const before = await historicalReview(f, admin, Date.now() + 2000);
      const lease = "R".repeat(43);
      await admin.query("SELECT issue_moderated_dance_media_lease_v1($1,$2,$3,$4,'owner',$5)", [
        "private-test-owner",
        before.capture.communityId,
        before.capture.reviewId,
        before.revision,
        lease,
      ]);
      const values = [
        "private-test-owner",
        before.capture.communityId,
        before.capture.reviewId,
        lease,
      ];
      const initial = (
        await admin.query(
          "SELECT resolve_moderated_dance_media_lease_v1($1,$2,$3,$4,FALSE) AS packet",
          values,
        )
      ).rows[0]?.packet;
      expect(initial.object.canonicalSha256).toBe(before.capture.sourceDigest);
      const usage = (
        await admin.query(
          "SELECT window_start_ms,window_ms FROM dance_moderated_intake_usage_v1 WHERE account_id='private-test-owner'",
        )
      ).rows[0];
      const result = await runBlockedQuery(
        f.connection,
        admin,
        {
          text: "SELECT 1 FROM dance_moderated_intake_usage_v1 WHERE account_id='private-test-owner' AND window_start_ms=$1 AND window_ms=$2 FOR UPDATE",
          values: [usage.window_start_ms, usage.window_ms],
        },
        {
          text: "SELECT resolve_moderated_dance_media_lease_v1($1,$2,$3,$4,TRUE) AS packet",
          values,
        },
        async () => {
          expect(
            (
              await admin.query("SELECT clock_timestamp()<$1::TIMESTAMPTZ AS before", [
                new Date(before.reviewDeadlineMs),
              ])
            ).rows[0]?.before,
          ).toBe(true);
          await crossDeadline(admin, new Date(before.reviewDeadlineMs));
        },
      );
      if (!("result" in result)) throw result.error;
      expect(result.result.rows[0]?.packet).toBeNull();
      expect(
        (await admin.query("SELECT count(*)::INTEGER n FROM dance_moderated_media_leases_v1"))
          .rows[0]?.n,
      ).toBe(1);
      expect(
        (
          await admin.query(
            "SELECT sum(reads)::INTEGER reads FROM dance_moderated_intake_usage_v1 WHERE account_id='private-test-owner'",
          )
        ).rows[0]?.reads,
      ).toBe(2);
    }));
});
