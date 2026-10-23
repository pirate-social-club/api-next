import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../../scripts/postgres-migrations.ts";
import {
  applyPostgresTestBaselineConnection,
  createReusablePostgresTestSchemaOwner,
} from "../../../scripts/postgres-test-baseline.ts";
import { prepareModeratedDancePolicyPublication } from "../../application/src/use-cases/dance/moderated-policy.ts";
import {
  DanceReviewServiceFailure,
  executeDanceReviewCommand,
} from "../../application/src/use-cases/dance/moderator-review-services.ts";
import { decodeModeratedDanceCaptureContext } from "./dance-moderated-context.ts";
import { makeControlPlaneModeratedDanceIntakeStore } from "./dance-moderated-intake-repository.ts";
import { makeControlPlaneModeratorReviewStore } from "./dance-moderator-review-repository.ts";
import {
  crossDeadline,
  historicalReview,
  runBlockedQuery,
} from "./moderated-dance-authority.pg-fixture.ts";
import {
  injectContextLineageFault,
  seedCapturedSharedDanceObjective,
} from "./moderated-dance-context-lineage.pg-fixture.ts";
import { seedModeratedDanceIntake } from "./moderated-dance-intake.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && url === undefined)
  throw new Error("Isolated native Postgres URL required");
const suite = url === undefined ? describe.skip : describe;
const reusableSchema = createReusablePostgresTestSchemaOwner();
setDefaultTimeout(30_000);
afterAll(async () => {
  await reusableSchema.dispose();
});
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;

async function withFixture(
  use: (f: Awaited<ReturnType<typeof seedModeratedDanceIntake>>, admin: Client) => Promise<void>,
) {
  if (url === undefined) throw new Error("Isolated target required");
  return reusableSchema.run({
    baseConnectionString: url,
    schemaName: "moderated_dance_context_pg_v1",
    use: async ({ admin, schema }) => {
      const scoped = new URL(url);
      scoped.searchParams.set("options", `-c search_path=${schema}`);
      await applyPostgresTestBaselineConnection({ connectionString: scoped.toString() });
      await admin.query(`SET search_path TO ${quote(schema)}`);
      await use(await seedModeratedDanceIntake(admin, scoped.toString()), admin);
    },
  });
}

async function withFreshFixture(
  use: (f: Awaited<ReturnType<typeof seedModeratedDanceIntake>>, admin: Client) => Promise<void>,
) {
  if (url === undefined) throw new Error("Isolated target required");
  const admin = new Client({ connectionString: url });
  const schema = `dance_context_acl_${process.pid}_${Date.now()}`;
  const scoped = new URL(url);
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA ${quote(schema)}; SET search_path TO ${quote(schema)}`);
    await runPostgresMigrations({
      connectionString: scoped.toString(),
      migrations: await loadPostgresMigrations(),
      expectedLedger: [],
    });
    await use(await seedModeratedDanceIntake(admin, scoped.toString()), admin);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
    await admin.end();
  }
}

suite("moderated Dance frozen context with real PostgreSQL authority", () => {
  test("retained funded objective resolves exactly; later funding cannot upgrade practice; corrupted lineage fails closed", async () =>
    withFixture(async (f, admin) => {
      await f.ready();
      const practice = await Effect.runPromise(f.store.command(f.create));
      const frozen = await seedCapturedSharedDanceObjective(f, admin);
      const read = () =>
        Effect.runPromise(
          f.store.captureContext(f.facts.communityId, frozen.terms.capture.sessionId),
        );
      const wire = await read();
      expect(wire.reward_mode).toBe("reward_eligible");
      expect(wire.rewards_enabled).toBe(false);
      expect(wire.objectives).toHaveLength(1);
      expect(wire.objectives[0]?.binding.objective_id).toBe(frozen.resolved.binding.objective_id);
      expect(wire.objectives[0]?.chain_id).toBe(84532);
      const old = await Effect.runPromise(
        f.store.captureContext(f.facts.communityId, practice.session.session_id),
      );
      expect(old.reward_mode).toBe("practice");
      expect(old.objectives).toEqual([]);
      const cases = [
        {
          change:
            "UPDATE song_reward_offer_legs SET token_address='0xffffffffffffffffffffffffffffffffffffffff' WHERE leg_id='test-leg'",
          values: [],
          restore: "UPDATE song_reward_offer_legs SET token_address=$1 WHERE leg_id='test-leg'",
          original: [frozen.resolved.token_address],
        },
        {
          change:
            "UPDATE song_reward_offer_legs SET shared_song_terms_v2=jsonb_set(shared_song_terms_v2,'{qualification_bindings,2,binding_id}','\"foreign-binding\"') WHERE leg_id='test-leg'",
          values: [],
          restore:
            "UPDATE song_reward_offer_legs SET shared_song_terms_v2=$1::jsonb WHERE leg_id='test-leg'",
          original: [JSON.stringify(frozen.resolved.terms)],
        },
        {
          change:
            "UPDATE qualification_policy_versions SET policy_document=jsonb_set(policy_document,'{producer_id}','\"foreign-producer\"') WHERE qualification_policy_version_id=$1",
          values: [frozen.resolved.binding.qualification_policy_id],
          restore:
            "UPDATE qualification_policy_versions SET policy_document=$1::jsonb WHERE qualification_policy_version_id=$2",
          original: [
            JSON.stringify(frozen.resolved.qualification_document),
            frozen.resolved.binding.qualification_policy_id,
          ],
        },
        {
          change:
            "UPDATE dance_moderated_policy_disclosures_v1 SET disclosure=jsonb_set(disclosure,'{owner_rubric_text}','\"foreign-rubric\"') WHERE policy_id=$1",
          values: [frozen.policy.policy_id],
          restore:
            "UPDATE dance_moderated_policy_disclosures_v1 SET disclosure=$1::jsonb WHERE policy_id=$2",
          original: [JSON.stringify(frozen.policy.disclosure), frozen.policy.policy_id],
        },
      ];
      for (const fault of cases) {
        await injectContextLineageFault(admin, fault.change, fault.values);
        await expect(read()).rejects.toMatchObject({ reason: "unavailable" });
        await injectContextLineageFault(admin, fault.restore, fault.original);
        expect((await read()).session.terms_hash).toBe(frozen.terms.terms_hash);
      }
    }));
  test("practice context retains original consent/rubric after a current policy rotation and charges captured read limits", async () =>
    withFixture(async (f, admin) => {
      await f.ready();
      const { session } = await Effect.runPromise(f.store.command(f.create));
      const original = await Effect.runPromise(
        f.store.captureContext(f.facts.communityId, session.session_id),
      );
      expect(original.reward_mode).toBe("practice");
      expect(original.rewards_enabled).toBe(false);
      expect(original.objectives).toEqual([]);
      expect(original.disclosure).toEqual(f.publication.disclosure);
      const rotated = await Effect.runPromise(
        prepareModeratedDancePolicyPublication({
          ...f.publication,
          policy_id: "rotated-context-policy",
          profile: {
            ...f.publication.profile,
            maximumReadsPerWindow: f.facts.profile.maximumReadsPerWindow + 5,
          },
          policy: { ...f.publication.policy, rubricVersion: "rotated-rubric" },
          disclosure: {
            ...f.publication.disclosure,
            consent_text: "Rotated current consent",
            owner_rubric_text: "Rotated current rubric",
          },
        }),
      );
      await admin.query("SELECT publish_moderated_dance_policy_v1($1::jsonb)", [
        JSON.stringify(rotated),
      ]);
      expect(
        await Effect.runPromise(f.store.captureContext(f.facts.communityId, session.session_id)),
      ).toEqual(original);
      const readCount = (
        await admin.query("SELECT sum(reads)::INTEGER n FROM dance_moderated_intake_usage_v1")
      ).rows[0]?.n;
      expect(readCount).toBe(2);
      let accepted = 0,
        limited = false;
      // This real-clock case can cross one window boundary. A reset is valid;
      // every bucket must still enforce the ORIGINAL captured limit, including
      // after the current policy increases it. No provider/runtime gate is waived.
      for (let n = 0; n < 2 * f.facts.profile.maximumReadsPerWindow; n++) {
        try {
          await Effect.runPromise(f.store.captureContext(f.facts.communityId, session.session_id));
          accepted++;
        } catch (error) {
          expect(error).toMatchObject({ reason: "unavailable" });
          limited = true;
          break;
        }
      }
      expect(limited).toBe(true);
      const buckets = (
        await admin.query(
          "SELECT reads::INTEGER n FROM dance_moderated_intake_usage_v1 WHERE account_id=$1 ORDER BY window_start_ms",
          [f.facts.accountId],
        )
      ).rows.map((row) => Number(row.n));
      expect(buckets.every((n) => n <= f.facts.profile.maximumReadsPerWindow)).toBe(true);
      expect(buckets).toContain(f.facts.profile.maximumReadsPerWindow);
      expect(buckets.reduce((sum, n) => sum + n, 0)).toBe(2 + accepted);
    }));

  test("final snapshot denies persona revocation committed while the captured usage row is locked", async () =>
    withFixture(async (f, admin) => {
      await f.ready();
      const { session } = await Effect.runPromise(f.store.command(f.create));
      await Effect.runPromise(f.store.captureContext(f.facts.communityId, session.session_id));
      const third = new Client({ connectionString: f.connection });
      await third.connect();
      try {
        const response = await runBlockedQuery(
          f.connection,
          admin,
          {
            text: "SELECT 1 FROM dance_moderated_intake_usage_v1 WHERE account_id=$1 FOR UPDATE",
            values: [f.facts.accountId],
          },
          {
            text: "SELECT read_owned_moderated_dance_capture_context_v1($1,$2,$3)",
            values: [f.facts.accountId, f.facts.communityId, session.session_id],
          },
          async () => {
            await third.query("BEGIN");
            try {
              // Fictional wallet tombstone completes the pre-existing persona
              // invariant; no provider provisioning or chain effect occurs.
              await third.query("SET CONSTRAINTS ALL DEFERRED");
              await third.query(
                "INSERT INTO persona_wallet_assignments(assignment_id,persona_id,account_id,chain_account_kind,hd_wallet_index,status,reservation_idempotency_key,tombstoned_at) VALUES('context-retired-wallet',$1,$2,'evm',0,'tombstoned','context-retirement',clock_timestamp())",
                [f.facts.personaId, f.facts.accountId],
              );
              await third.query(
                "UPDATE personas SET status='retired',retired_at=clock_timestamp() WHERE persona_id=$1",
                [f.facts.personaId],
              );
              await third.query("COMMIT");
            } catch (error) {
              await third.query("ROLLBACK");
              throw error;
            }
          },
        );
        expect(response).toMatchObject({ error: { code: "DRV02" } });
      } finally {
        await third.end();
      }
    }));

  test("owner receives captured revision/rubric only, and revocation after a usage wait denies the read", async () =>
    withFixture(async (f, admin) => {
      const review = await historicalReview(f, admin, Date.now() + 60_000);
      const store = makeControlPlaneModeratedDanceIntakeStore(f.runtime, "private-test-owner", {
        signer: null,
      });
      const wire = await Effect.runPromise(
        store.ownerRubric(f.facts.communityId, review.capture.reviewId),
      );
      expect(wire.review_revision).toBe(review.revision);
      expect(wire.rubric_text).toBe(f.publication.disclosure.owner_rubric_text);
      expect(Object.keys(wire)).not.toContain("objectives");
      expect(Object.keys(wire)).not.toContain("persona_id");
      await expect(
        Effect.runPromise(f.store.ownerRubric(f.facts.communityId, review.capture.reviewId)),
      ).rejects.toMatchObject({ reason: "not_found" });
      const third = new Client({ connectionString: f.connection });
      await third.connect();
      try {
        const response = await runBlockedQuery(
          f.connection,
          admin,
          {
            text: "SELECT 1 FROM dance_moderated_intake_usage_v1 WHERE account_id='private-test-owner' FOR UPDATE",
            values: [],
          },
          {
            text: "SELECT read_moderated_dance_owner_rubric_v1($1,$2,$3)",
            values: ["private-test-owner", f.facts.communityId, review.capture.reviewId],
          },
          async () => {
            await third.query(
              "UPDATE users SET status='deleted' WHERE user_id='private-test-owner'",
            );
          },
        );
        expect(response).toMatchObject({ error: { code: "DRV02" } });
      } finally {
        await third.end();
      }
    }));

  test("current owner still cannot read after the actual review deadline", async () =>
    withFixture(async (f, admin) => {
      const review = await historicalReview(f, admin, Date.now() - 1000);
      const store = makeControlPlaneModeratedDanceIntakeStore(f.runtime, "private-test-owner", {
        signer: null,
      });
      await expect(
        Effect.runPromise(store.ownerRubric(f.facts.communityId, review.capture.reviewId)),
      ).rejects.toMatchObject({ reason: "not_found" });
    }));

  test("dancer erasure committed during a usage wait denies the final capture reply", async () =>
    withFixture(async (f, admin) => {
      await f.ready();
      const { session } = await Effect.runPromise(f.store.command(f.create));
      await Effect.runPromise(f.store.captureContext(f.facts.communityId, session.session_id));
      const third = new Client({ connectionString: f.connection });
      await third.connect();
      try {
        const response = await runBlockedQuery(
          f.connection,
          admin,
          {
            text: "SELECT 1 FROM dance_moderated_intake_usage_v1 WHERE account_id=$1 FOR UPDATE",
            values: [f.facts.accountId],
          },
          {
            text: "SELECT read_owned_moderated_dance_capture_context_v1($1,$2,$3)",
            values: [f.facts.accountId, f.facts.communityId, session.session_id],
          },
          async () => {
            await third.query("SELECT begin_moderated_dance_account_erasure_v1($1)", [
              f.facts.accountId,
            ]);
          },
        );
        expect(response).toMatchObject({ error: { code: "DRV02" } });
      } finally {
        await third.end();
      }
    }));

  test("wall-clock expiry during a usage wait refuses even when no row changed", async () =>
    withFixture(async (f, admin) => {
      const deadline = Date.now() + 2000;
      const review = await historicalReview(f, admin, deadline);
      const store = makeControlPlaneModeratedDanceIntakeStore(f.runtime, "private-test-owner", {
        signer: null,
      });
      await Effect.runPromise(store.ownerRubric(f.facts.communityId, review.capture.reviewId));
      const response = await runBlockedQuery(
        f.connection,
        admin,
        {
          text: "SELECT 1 FROM dance_moderated_intake_usage_v1 WHERE account_id='private-test-owner' FOR UPDATE",
          values: [],
        },
        {
          text: "SELECT read_moderated_dance_owner_rubric_v1($1,$2,$3)",
          values: ["private-test-owner", f.facts.communityId, review.capture.reviewId],
        },
        async () => {
          await crossDeadline(admin, new Date(deadline));
        },
      );
      expect(response).toMatchObject({ error: { code: "DRV02" } });
    }));

  test("a real review withdrawal committed during a usage wait denies the owner reply", async () =>
    withFixture(async (f, admin) => {
      const review = await historicalReview(f, admin, Date.now() + 60000);
      const ownerStore = makeControlPlaneModeratedDanceIntakeStore(
        f.runtime,
        "private-test-owner",
        { signer: null },
      );
      await Effect.runPromise(ownerStore.ownerRubric(f.facts.communityId, review.capture.reviewId));
      const dancer = makeControlPlaneModeratorReviewStore(f.runtime, {
        account: () => Effect.succeed({ kind: "account", accountId: f.facts.accountId }),
        worker: () => Effect.fail(new DanceReviewServiceFailure({ reason: "unauthorized" })),
      });
      const response = await runBlockedQuery(
        f.connection,
        admin,
        {
          text: "SELECT 1 FROM dance_moderated_intake_usage_v1 WHERE account_id='private-test-owner' FOR UPDATE",
          values: [],
        },
        {
          text: "SELECT read_moderated_dance_owner_rubric_v1($1,$2,$3)",
          values: ["private-test-owner", f.facts.communityId, review.capture.reviewId],
        },
        async () => {
          const receipt = await Effect.runPromise(
            executeDanceReviewCommand(
              {
                version: "dance-review-withdraw-v1",
                operation: "withdraw",
                idempotency_key: "context-withdraw",
                community_id: f.facts.communityId,
                review_id: review.capture.reviewId,
                expected_review_revision: review.revision,
              },
              dancer,
            ),
          );
          expect(receipt.result.state).toBe("withdrawn");
        },
      );
      expect(response).toMatchObject({ error: { code: "DRV02" } });
    }));

  test("erasure and foreign account/community/session do not expose capture context", async () =>
    withFixture(async (f, admin) => {
      await f.ready();
      const { session } = await Effect.runPromise(f.store.command(f.create));
      for (const args of [
        ["private-test-owner", f.facts.communityId, session.session_id],
        [f.facts.accountId, "foreign-community", session.session_id],
        [f.facts.accountId, f.facts.communityId, "foreign-session"],
      ])
        await expect(
          admin.query("SELECT read_owned_moderated_dance_capture_context_v1($1,$2,$3)", args),
        ).rejects.toMatchObject({ code: "DRV02" });
      await admin.query("SELECT begin_moderated_dance_account_erasure_v1($1)", [f.facts.accountId]);
      await expect(
        Effect.runPromise(f.store.captureContext(f.facts.communityId, session.session_id)),
      ).rejects.toMatchObject({ reason: "not_found" });
    }));

  test("execute-only synthetic account role can read after explicit binding, without private table or projector access", async () =>
    withFreshFixture(async (f, admin) => {
      await f.ready();
      const { session } = await Effect.runPromise(f.store.command(f.create));
      const role = `dance_context_reader_${process.pid}_${Date.now()}`;
      const password = Array.from(crypto.getRandomValues(new Uint8Array(32)), (v) =>
        v.toString(16).padStart(2, "0"),
      ).join("");
      await admin.query(`CREATE ROLE ${quote(role)} LOGIN PASSWORD '${password}'`);
      const conn = new URL(f.connection);
      conn.username = role;
      conn.password = password;
      const restricted = new Client({ connectionString: conn.toString() });
      try {
        const functions = (
          await admin.query(
            "SELECT proname,provolatile,prosecdef,proconfig,has_function_privilege($1,p.oid,'EXECUTE') allowed FROM pg_proc p WHERE p.pronamespace=current_schema()::regnamespace AND p.proname=ANY($2::TEXT[]) ORDER BY proname",
            [
              role,
              [
                "project_owned_moderated_dance_capture_context_v1",
                "project_moderated_dance_owner_rubric_v1",
                "read_owned_moderated_dance_capture_context_v1",
                "read_moderated_dance_owner_rubric_v1",
              ],
            ],
          )
        ).rows;
        expect(functions).toHaveLength(4);
        const schema = (await admin.query("SELECT current_schema() name")).rows[0]?.name;
        for (const fn of functions) {
          expect(fn.prosecdef).toBe(true);
          expect(fn.allowed).toBe(false);
          expect(fn.provolatile).toBe(fn.proname.startsWith("project_") ? "s" : "v");
          expect(fn.proconfig).toContain(`search_path=${schema}, pg_catalog, pg_temp`);
        }
        await admin.query(
          `GRANT USAGE ON SCHEMA ${quote((await admin.query("SELECT current_schema() name")).rows[0]?.name)} TO ${quote(role)}`,
        );
        await restricted.connect();
        await expect(
          restricted.query("SELECT read_owned_moderated_dance_capture_context_v1($1,$2,$3)", [
            f.facts.accountId,
            f.facts.communityId,
            session.session_id,
          ]),
        ).rejects.toMatchObject({ code: "42501" });
        await admin.query("SELECT grant_moderated_dance_runtime_v1($1,'account')", [role]);
        await admin.query(
          `GRANT EXECUTE ON FUNCTION read_owned_moderated_dance_capture_context_v1(TEXT,TEXT,TEXT),read_moderated_dance_owner_rubric_v1(TEXT,TEXT,TEXT) TO ${quote(role)}`,
        );
        const store = makeControlPlaneModeratedDanceIntakeStore(
          makeDirectPostgresControlPlaneLayer(conn.toString()),
          f.facts.accountId,
          { signer: null },
        );
        expect(
          (await Effect.runPromise(store.captureContext(f.facts.communityId, session.session_id)))
            .reward_mode,
        ).toBe("practice");
        await expect(
          restricted.query("SELECT terms FROM dance_moderated_sessions_v1"),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          restricted.query("SELECT project_owned_moderated_dance_capture_context_v1($1,$2,$3)", [
            f.facts.accountId,
            f.facts.communityId,
            session.session_id,
          ]),
        ).rejects.toMatchObject({ code: "42501" });
        const packet = (
          await admin.query(
            "SELECT read_owned_moderated_dance_capture_context_v1($1,$2,$3) packet",
            [f.facts.accountId, f.facts.communityId, session.session_id],
          )
        ).rows[0]?.packet;
        expect(
          (
            await Effect.runPromise(
              decodeModeratedDanceCaptureContext(
                packet,
                {
                  accountId: f.facts.accountId,
                  communityId: f.facts.communityId,
                  sessionId: session.session_id,
                },
                false,
              ),
            )
          ).session.session_id,
        ).toBe(session.session_id);
      } finally {
        await restricted.end();
        await admin.query(`DROP OWNED BY ${quote(role)}`);
        await admin.query(`DROP ROLE ${quote(role)}`);
      }
    }));
});
