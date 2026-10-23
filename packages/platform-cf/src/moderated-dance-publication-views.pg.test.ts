import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Schema } from "effect";
import { Client } from "pg";
import { createReusablePostgresTestSchemaOwner } from "../../../scripts/postgres-test-baseline.ts";
import {
  type ModeratorReview,
  transitionModeratorReview,
} from "../../domain/src/dance/moderator-review.ts";
import { ModeratorReviewFactsSchema } from "../../domain/src/dance/moderator-review-schema.ts";
import { reviewCommit } from "./moderated-dance-authority.pg-fixture.ts";
import {
  command,
  makePublicationInputFixture,
  protocol,
  stored,
} from "./moderated-dance-publication-input.pg-fixture.ts";

const suite = process.env.CONTROL_PLANE_POSTGRES_TEST_URL === undefined ? describe.skip : describe;
const reusableSchema = createReusablePostgresTestSchemaOwner(),
  withFixture = makePublicationInputFixture(reusableSchema);
setDefaultTimeout(30000);
afterAll(async () => {
  await reusableSchema.dispose();
});
const drain = (db: Client) => db.query("SELECT drain_moderated_dance_publication_intents_v1()");
async function cancel(db: Client, review: ModeratorReview) {
  const actor = { kind: "worker", accountId: "publication-maintenance" } as const;
  const now = Math.max(Date.now(), review.terminalAtMs ?? 0) + 1;
  const facts = Schema.decodeUnknownSync(ModeratorReviewFactsSchema)(
    (
      await db.query(
        "SELECT moderated_dance_review_facts_v1($1,$2::jsonb,'publication_failed',$3) packet",
        [review.capture.reviewId, JSON.stringify(actor), now],
      )
    ).rows[0]?.packet,
  );
  const change = transitionModeratorReview(
    review,
    { kind: "publication_failed", generation: review.generation },
    actor,
    review.revision,
    now,
    facts,
  );
  expect(change.refusal).toBeNull();
  await db.query("SELECT commit_moderated_dance_review_v1($1::jsonb)", [
    JSON.stringify(
      reviewCommit(review, change, actor, "publication_failed", "cancel-handoff", now),
    ),
  ]);
  return change.state;
}
async function read(db: Client, account: string, community: string, review: string) {
  return (
    await db.query("SELECT read_owned_moderated_dance_publication_v1($1,$2,$3) packet", [
      account,
      community,
      review,
    ])
  ).rows[0]?.packet;
}

suite("native Dance ordinary-Post links, reference credit and intent closure", () => {
  test("only the current account sees its adopted ordinary submission; private review and original receipt do not change", async () =>
    withFixture(async (f, db, r) => {
      const args = [f.facts.accountId, f.facts.communityId, r.capture.reviewId] as const;
      expect(await read(db, ...args)).toEqual({
        version: "dance-moderated-publication-v1",
        review_id: args[2],
        status: "pending",
        submission: null,
      });
      expect(await read(db, "foreign", args[1], args[2])).toBeNull();
      expect(await read(db, args[0], "foreign", args[2])).toBeNull();
      const before = (
        await db.query(
          "SELECT receipt FROM dance_moderated_command_receipts_v1 ORDER BY actor_kind,actor_id,operation,idempotency_key",
        )
      ).rows;
      await stored(db, r);
      const receipt = Schema.decodeUnknownSync(
        Schema.Struct({ submission_id: Schema.String, href: Schema.String }),
      )(await protocol(db, args[2]).adopt());
      expect(await read(db, ...args)).toEqual({
        version: "dance-moderated-publication-v1",
        review_id: args[2],
        status: "transferred",
        submission: { submission_id: receipt.submission_id, href: receipt.href },
      });
      const row = (
        await db.query("SELECT start_input FROM media_post_submissions WHERE submission_id=$1", [
          receipt.submission_id,
        ])
      ).rows[0];
      expect(row?.start_input.dance_credit).toEqual({
        choreography_id: r.capture.choreographyId,
        revision: r.capture.choreographyRevision,
        reference_video_post_id: "private-reference",
      });
      expect(Object.keys(row?.start_input.dance_credit).sort()).toEqual([
        "choreography_id",
        "reference_video_post_id",
        "revision",
      ]);
      await expect(
        db.query(
          "UPDATE media_post_submissions SET start_input=start_input-'dance_credit' WHERE submission_id=$1",
          [receipt.submission_id],
        ),
      ).rejects.toMatchObject({ code: "DRV01" });
      expect(
        (
          await db.query(
            "SELECT receipt FROM dance_moderated_command_receipts_v1 ORDER BY actor_kind,actor_id,operation,idempotency_key",
          )
        ).rows,
      ).toEqual(before);
      await db.query("SELECT begin_moderated_dance_account_erasure_v1($1)", [args[0]]);
      expect(await read(db, ...args)).toBeNull();
    }));
  test("logical prepare acknowledgement makes no physical input, and no-input cancellation closes only its original release", async () =>
    withFixture(async (f, db, r) => {
      await drain(db);
      expect(
        (await db.query("SELECT count(*)::INTEGER n FROM dance_moderated_publication_inputs_v1"))
          .rows[0]?.n,
      ).toBe(0);
      expect(
        (
          await db.query(
            "SELECT status,disposition->>'status' disposition FROM dance_moderated_review_intents_v1 WHERE kind='handoff_prepare'",
          )
        ).rows,
      ).toEqual([{ status: "completed", disposition: "logical_preparation_recorded" }]);
      const cancelled = await cancel(db, r);
      await drain(db);
      const rows = (
        await db.query(
          "SELECT kind,status,disposition->>'status' disposition FROM dance_moderated_review_intents_v1 WHERE kind IN('handoff_cancel','handoff_release') ORDER BY kind",
        )
      ).rows;
      expect(rows).toEqual([
        { kind: "handoff_cancel", status: "completed", disposition: "no_physical_input" },
        { kind: "handoff_release", status: "completed", disposition: "cancelled" },
      ]);
      await drain(db);
      expect(
        (
          await db.query("SELECT state FROM dance_moderated_reviews_v1 WHERE review_id=$1", [
            r.capture.reviewId,
          ])
        ).rows[0]?.state,
      ).toEqual(cancelled);
      expect(
        await read(db, f.facts.accountId, f.facts.communityId, r.capture.reviewId),
      ).toMatchObject({ status: "failed", submission: null });
    }));
  test("cancellation stays pending until both the storage fence and original provider liability close", async () =>
    withFixture(
      async (_f, db, r) => {
        const id = r.capture.reviewId;
        await command(db, id, "begin");
        const w = (
          await db.query(
            "SELECT claim_moderated_dance_publication_v1('observer','test-media',true) packet",
          )
        ).rows[0]?.packet;
        const fields = {
          inputToken: w.inputToken,
          leaseToken: w.leaseToken,
          videoTrackEnabled: true,
          capabilitySha256: "d".repeat(64),
        };
        for (const action of ["source", "create"])
          await db.query("SELECT moderated_dance_publication_provider_v1($1,$2,$3::jsonb)", [
            id,
            action,
            JSON.stringify(fields),
          ]);
        const cancelled = await cancel(db, r);
        await drain(db);
        const status = async () =>
          (
            await db.query(
              "SELECT status FROM dance_moderated_review_intents_v1 WHERE kind='handoff_cancel'",
            )
          ).rows[0]?.status;
        expect(await status()).toBe("pending");
        await command(db, id, "cleanup");
        // SQL protocol fixture only: actual R2 fence conformance is a separate test.
        await command(db, id, "cleaned", { keyFenced: true });
        await drain(db);
        expect(await status()).toBe("pending");
        const claim = (
          await db.query("SELECT claim_moderated_dance_provider_cleanup_v1('dispose') packet")
        ).rows[0]?.packet;
        expect(claim.tag).toBe(w.tag);
        await db.query(
          "SELECT identify_moderated_dance_provider_cleanup_v1($1,$2,'original-job',$3)",
          [claim.effectId, claim.token, claim.tag],
        );
        await db.query("SELECT finish_moderated_dance_provider_cleanup_v1($1,$2,$3::jsonb)", [
          claim.effectId,
          claim.token,
          JSON.stringify({ outcome: "observed_absent", jobId: "original-job", tag: claim.tag }),
        ]);
        await drain(db);
        expect(await status()).toBe("completed");
        expect(
          (
            await db.query(
              "SELECT disposition FROM dance_moderated_review_intents_v1 WHERE kind='handoff_cancel'",
            )
          ).rows[0]?.disposition.status,
        ).toBe("input_fenced_and_provider_disposed");
        expect(
          (await db.query("SELECT state FROM dance_moderated_reviews_v1 WHERE review_id=$1", [id]))
            .rows[0]?.state,
        ).toEqual(cancelled);
      },
      undefined,
      false,
      7,
    ));
  test("account LOGIN reads its link without raw private tables, media drain or trigger authority", async () =>
    withFixture(
      async (f, db, r) => {
        await stored(db, r);
        await protocol(db, r.capture.reviewId).adopt();
        const role = `dance_post_view_${crypto.randomUUID().replaceAll("-", "")}`,
          password = crypto.randomUUID();
        const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
        await db.query(
          `CREATE ROLE ${quote(role)} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`,
        );
        let account: Client | undefined;
        try {
          const schema = (await db.query("SELECT current_schema() schema")).rows[0]?.schema;
          await db.query(`GRANT USAGE ON SCHEMA ${quote(schema)} TO ${quote(role)}`);
          await db.query("SELECT grant_moderated_dance_runtime_v1($1,'account')", [role]);
          const url = new URL(f.connection);
          url.username = role;
          url.password = password;
          account = new Client({ connectionString: url.toString() });
          await account.connect();
          expect(
            await read(account, f.facts.accountId, f.facts.communityId, r.capture.reviewId),
          ).toMatchObject({ status: "transferred" });
          for (const sql of [
            "SELECT * FROM dance_moderated_publication_inputs_v1",
            "SELECT drain_moderated_dance_publication_intents_v1()",
            "SELECT bind_moderated_dance_post_credit_v1()",
          ])
            await expect(account.query(sql)).rejects.toMatchObject({ code: "42501" });
          expect(
            (
              await db.query(
                "SELECT bool_and(NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')) denied FROM pg_proc p WHERE pronamespace=current_schema()::regnamespace AND proname IN('read_owned_moderated_dance_publication_v1','drain_moderated_dance_publication_intents_v1','bind_moderated_dance_post_credit_v1')",
              )
            ).rows[0]?.denied,
          ).toBe(true);
        } finally {
          await account?.end();
          await db.query(`DROP OWNED BY ${quote(role)}`);
          await db.query(`DROP ROLE ${quote(role)}`);
        }
      },
      undefined,
      true,
    ));
});
