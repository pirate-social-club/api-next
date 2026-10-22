import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  createReusablePostgresTestSchemaOwner,
} from "../../../scripts/postgres-test-baseline.ts";
import { executeDanceReviewCommand } from "../../application/src/use-cases/dance/moderator-review-services.ts";
import { MODERATED_DANCE_REPLAY_RETIRED } from "../../domain/src/dance/moderator-review.ts";
import { makeControlPlaneModeratorReviewStore } from "./dance-moderator-review-repository.ts";
import { historicalReview } from "./moderated-dance-authority.pg-fixture.ts";
import { seedModeratedDanceIntake as seed } from "./moderated-dance-intake.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && url === undefined)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = url === undefined ? describe.skip : describe,
  reusableSchema = createReusablePostgresTestSchemaOwner();
setDefaultTimeout(30_000);
afterAll(async () => {
  await reusableSchema.dispose();
});
type Fixture = Awaited<ReturnType<typeof seed>>;
async function withFixture(use: (f: Fixture, admin: Client) => Promise<void>) {
  if (url === undefined) throw new Error("Isolated target missing");
  await reusableSchema.run({
    baseConnectionString: url,
    schemaName: "moderated_dance_replay_retention_pg_v1",
    use: async ({ admin, schema }) => {
      const scoped = new URL(url);
      scoped.searchParams.set("options", `-c search_path=${schema}`);
      await applyPostgresTestBaselineConnection({ connectionString: scoped.toString() });
      await admin.query(`SET search_path TO "${schema.replaceAll('"', '""')}"`);
      await use(await seed(admin, scoped.toString()), admin);
    },
  });
}
type Review = Awaited<ReturnType<typeof historicalReview>>;
async function claims(f: Fixture, admin: Client, r: Review) {
  const expiry = r.capture.uploadedAtMs + f.facts.profile.replayRetentionMs;
  // Synthetic retained lineage, with real reserved/claim/retention ordering.
  // This does not assert a recording or provider has been exercised.
  await admin.query(
    "UPDATE dance_moderated_uploads_v1 SET replay_expires_at=to_timestamp($2::NUMERIC/1000) WHERE upload_id=$1",
    [r.capture.uploadId, expiry],
  );
  for (const kind of ["raw", "body"])
    await admin.query(
      `INSERT INTO dance_moderated_replay_claims_v1(scope,key_epoch,kind,digest,source_kind,source_id,expires_at,created_at)
    VALUES($1,$2,$3,$4,'attempt',$5,to_timestamp($6::NUMERIC/1000),to_timestamp($7::NUMERIC/1000))`,
      [
        f.facts.profile.replayScope,
        f.facts.profile.replayKeyEpoch,
        kind,
        kind === "body" ? r.capture.normalizedDigest : r.capture.sourceDigest,
        r.capture.uploadId,
        expiry,
        r.capture.uploadedAtMs,
      ],
    );
}
function store(f: Fixture, accountId: string) {
  return makeControlPlaneModeratorReviewStore(makeDirectPostgresControlPlaneLayer(f.connection), {
    account: () => Effect.succeed({ kind: "account", accountId }),
    worker: () => Effect.succeed({ kind: "worker", accountId: "test-worker" }),
  });
}
async function pass(f: Fixture, r: Review) {
  return Effect.runPromise(
    executeDanceReviewCommand(
      {
        version: "dance-owner-verdict-attestation-v1",
        operation: "verdict",
        idempotency_key: "retained-original-verdict",
        community_id: r.capture.communityId,
        review_id: r.capture.reviewId,
        expected_review_revision: r.revision,
        verdict: "passed",
      },
      store(f, "private-test-owner"),
    ),
  );
}
const drain = async (admin: Client) =>
  (await admin.query("SELECT drain_moderated_dance_replay_v1() packet")).rows[0]?.packet;

suite("native atomic private replay retention", () => {
  test("expired matching copies retire together while the real verdict, qualification, consent and exact command replay remain", async () =>
    withFixture(async (f, admin) => {
      const r = await historicalReview(f, admin, Date.now() + 60_000);
      await claims(f, admin, r);
      const receipt = await pass(f, r),
        reader = store(f, r.capture.accountId);
      const before = await Effect.runPromise(
        reader.getOwnResult(r.capture.communityId, r.capture.reviewId),
      );
      const audit = (
        await admin.query("SELECT to_jsonb(a) value FROM dance_moderated_verdict_audits_v1 a")
      ).rows;
      const qualifications = (
        await admin.query("SELECT to_jsonb(q) value FROM activity_qualifications q")
      ).rows;
      expect(qualifications.length).toBeGreaterThan(0);
      const consent = (
        await admin.query("SELECT to_jsonb(c) value FROM dance_moderated_consents_v1 c")
      ).rows;
      expect(await drain(admin)).toEqual({ retiredAttempts: 1 });
      expect(
        (
          await admin.query(
            "SELECT normalized_digest,replay_retired_at IS NOT NULL retired FROM dance_moderated_uploads_v1",
          )
        ).rows,
      ).toEqual([{ normalized_digest: null, retired: true }]);
      expect(
        (
          await admin.query(
            "SELECT state#>>'{capture,normalizedDigest}' digest FROM dance_moderated_reviews_v1",
          )
        ).rows,
      ).toEqual([{ digest: MODERATED_DANCE_REPLAY_RETIRED }]);
      expect(
        (await admin.query("SELECT normalized_digest FROM dance_moderated_review_evidence_v1"))
          .rows,
      ).toEqual([{ normalized_digest: null }]);
      expect(
        (await admin.query("SELECT count(*)::INTEGER n FROM dance_moderated_replay_claims_v1"))
          .rows[0],
      ).toEqual({ n: 0 });
      expect(
        (
          await admin.query(
            "SELECT removed_claims::INTEGER n,retired_at>=due_at valid FROM dance_moderated_replay_retirements_v1",
          )
        ).rows,
      ).toEqual([{ n: 2, valid: true }]);
      expect(
        await Effect.runPromise(reader.getOwnResult(r.capture.communityId, r.capture.reviewId)),
      ).toEqual(before);
      expect(await pass(f, r)).toEqual(receipt);
      expect(
        (await admin.query("SELECT to_jsonb(a) value FROM dance_moderated_verdict_audits_v1 a"))
          .rows,
      ).toEqual(audit);
      expect(
        (await admin.query("SELECT to_jsonb(q) value FROM activity_qualifications q")).rows,
      ).toEqual(qualifications);
      expect(
        (await admin.query("SELECT to_jsonb(c) value FROM dance_moderated_consents_v1 c")).rows,
      ).toEqual(consent);
      expect(await drain(admin)).toEqual({ retiredAttempts: 0 });
      await expect(
        admin.query("UPDATE dance_moderated_uploads_v1 SET normalized_digest=repeat('a',64)"),
      ).rejects.toMatchObject({ code: "DRV01" });
      await expect(
        admin.query(
          "UPDATE dance_moderated_review_evidence_v1 SET normalized_digest=repeat('a',64)",
        ),
      ).rejects.toMatchObject({ code: "DRV01" });
    }));
  test("retention cannot renew and a pending review pauses new intake instead of shortening its seven days", async () =>
    withFixture(async (f, admin) => {
      const r = await historicalReview(f, admin, Date.now() + 60_000);
      await claims(f, admin, r);
      await expect(
        admin.query(
          "UPDATE dance_moderated_uploads_v1 SET replay_expires_at=replay_expires_at+interval '1 day'",
        ),
      ).rejects.toMatchObject({ code: "DRV01" });
      expect(await drain(admin)).toEqual({ retiredAttempts: 0 });
      expect(
        (
          await admin.query(
            "SELECT state#>>'{capture,normalizedDigest}' digest,status FROM dance_moderated_reviews_v1",
          )
        ).rows,
      ).toEqual([{ digest: r.capture.normalizedDigest, status: "awaiting_review" }]);
      await admin.query("SELECT record_moderated_dance_maintenance_v1()");
      expect(
        (
          await admin.query(
            "SELECT count(*)::INTEGER n FROM dance_moderated_maintenance_readiness_v1",
          )
        ).rows[0],
      ).toEqual({ n: 0 });
      expect(
        (
          await admin.query(
            "SELECT count(*)::INTEGER n FROM dance_moderated_processor_readiness_v1",
          )
        ).rows[0],
      ).toEqual({ n: 0 });
    }));
  test("unexpired terminal evidence is retained; a forged early retirement cannot clear any copy", async () =>
    withFixture(async (f, admin) => {
      const r = await historicalReview(f, admin, Date.now() + 604_790_000);
      await claims(f, admin, r);
      await pass(f, r);
      expect(await drain(admin)).toEqual({ retiredAttempts: 0 });
      await expect(
        admin.query(
          "UPDATE dance_moderated_uploads_v1 SET normalized_digest=NULL,replay_retired_at=clock_timestamp()",
        ),
      ).rejects.toMatchObject({ code: "DRV01" });
      await expect(
        admin.query("UPDATE dance_moderated_review_evidence_v1 SET normalized_digest=NULL"),
      ).rejects.toMatchObject({ code: "DRV01" });
      await expect(
        admin.query(
          "UPDATE dance_moderated_reviews_v1 SET state=jsonb_set(state,'{capture,normalizedDigest}','\"keyed-replay-retired-v1\"')",
        ),
      ).rejects.toMatchObject({ code: "DRV01" });
    }));
  test("a locked review is skipped without deadlock and a rolled-back drain restores every matching copy", async () =>
    withFixture(async (f, admin) => {
      const r = await historicalReview(f, admin, Date.now() + 60_000);
      await claims(f, admin, r);
      await pass(f, r);
      const second = new Client({ connectionString: f.connection });
      await second.connect();
      try {
        await admin.query("BEGIN");
        await admin.query(
          "SELECT 1 FROM dance_moderated_reviews_v1 WHERE review_id=$1 FOR UPDATE",
          [r.capture.reviewId],
        );
        await second.query("SET statement_timeout='2s'");
        expect(await drain(second)).toEqual({ retiredAttempts: 0 });
        await admin.query("ROLLBACK");
        await admin.query("BEGIN");
        expect(await drain(admin)).toEqual({ retiredAttempts: 1 });
        await admin.query("ROLLBACK");
        expect(
          (await admin.query("SELECT normalized_digest FROM dance_moderated_uploads_v1")).rows,
        ).toEqual([{ normalized_digest: r.capture.normalizedDigest }]);
        expect(
          (
            await admin.query(
              "SELECT count(*)::INTEGER n FROM dance_moderated_replay_retirements_v1",
            )
          ).rows[0],
        ).toEqual({ n: 0 });
        expect(await drain(admin)).toEqual({ retiredAttempts: 1 });
      } finally {
        await admin.query("ROLLBACK");
        await second.end();
      }
    }));
});
