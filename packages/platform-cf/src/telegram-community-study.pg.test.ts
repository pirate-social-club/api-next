import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  applyPostgresTestBaselineConnection,
  createReusablePostgresTestSchemaOwner,
} from "../../../scripts/postgres-test-baseline.ts";
import { withDanceServingPermissionFixture } from "./dance-serving-permissions.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import {
  insertStudySongFixture,
  insertTelegramPracticeReadinessFixture,
} from "./study-v2-ready-song.pg-fixture.ts";
import { makeControlPlaneStudyV2Repository } from "./study-v2-repository.ts";
import { insertTelegramCatalogueFirstPage } from "./telegram-community-study.pg-fixture.ts";
import { makeTelegramCommunityStudyCatalogue } from "./telegram-community-study-catalogue.ts";
import { makeTelegramDatabase } from "./telegram-database.ts";
import { emptyTelegramIntegration, makeTelegramSettingsStore } from "./telegram-settings-store.ts";
import { telegramStudyAdmission } from "./telegram-study-admission.ts";
import { makeTelegramStudyLearnerStore } from "./telegram-study-learner-store.ts";
import { makeTelegramStudyStore } from "./telegram-study-store.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString)
  throw Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = connectionString ? describe : describe.skip;
const schemaOwner = createReusablePostgresTestSchemaOwner();

suite("community Telegram Study eligibility and owner persistence", () => {
  test("native catalogue installation strips ambient table and function grants", async () => {
    if (!connectionString) throw Error("Postgres test URL missing");
    await withDanceServingPermissionFixture(
      connectionString,
      async (f) => {
        const runtime = await f.makeRole();
        await f.owner.query(
          `ALTER DEFAULT PRIVILEGES IN SCHEMA ${f.quote(f.schema)} GRANT ALL ON TABLES TO ${f.quote(runtime.role)}`,
        );
        await f.owner.query(
          `ALTER DEFAULT PRIVILEGES IN SCHEMA ${f.quote(f.schema)} GRANT EXECUTE ON FUNCTIONS TO ${f.quote(runtime.role)}`,
        );
        try {
          await f.upgrade();
          const table = `${f.quote(f.schema)}.study_learner_catalogue_decisions`;
          const fn = `${f.quote(f.schema)}.guard_study_learner_catalogue_decision()`;
          const privileges = async () =>
            (
              await f.owner.query(
                `SELECT
          has_table_privilege($1,$2,'SELECT') can_select,
          has_table_privilege($1,$2,'INSERT') can_insert,
          has_table_privilege($1,$2,'UPDATE') can_update,
          has_table_privilege($1,$2,'DELETE') can_delete,
          has_table_privilege($1,$2,'TRUNCATE') can_truncate,
          has_function_privilege($1,$3,'EXECUTE') can_execute,
          EXISTS(SELECT 1 FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$3::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') public_execute`,
                [runtime.role, table, fn],
              )
            ).rows;
          const denied = {
            can_select: false,
            can_insert: false,
            can_update: false,
            can_delete: false,
            can_truncate: false,
            can_execute: false,
            public_execute: false,
          };
          expect(await privileges()).toEqual([denied]);
          await f.owner.query(`GRANT SELECT ON ${table} TO ${f.quote(runtime.role)}`);
          expect(await privileges()).toEqual([{ ...denied, can_select: true }]);
        } finally {
          await f.owner.query(
            `ALTER DEFAULT PRIVILEGES IN SCHEMA ${f.quote(f.schema)} REVOKE ALL ON TABLES FROM ${f.quote(runtime.role)}`,
          );
          await f.owner.query(
            `ALTER DEFAULT PRIVILEGES IN SCHEMA ${f.quote(f.schema)} REVOKE EXECUTE ON FUNCTIONS FROM ${f.quote(runtime.role)}`,
          );
        }
      },
      333,
    );
  }, 120000);
  test("the serving role reads only current explicit learner decisions and cannot create approvals", async () => {
    if (!connectionString) throw Error("Postgres test URL missing");
    await schemaOwner.run({
      baseConnectionString: connectionString,
      schemaName: "telegram_community_study_test",
      use: async ({ admin, schema }) => {
        const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const role = `telegram_catalogue_${suffix}`;
        const connection = `${connectionString}${connectionString.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
        await admin.query(`SET search_path TO "${schema}"`);
        await applyPostgresTestBaselineConnection({ connectionString: connection });
        await insertStudySongFixture(admin);
        await insertTelegramPracticeReadinessFixture(admin);
        await admin.query(
          "INSERT INTO community_role_assignments(role_assignment_id,community_id,account_id,role,status) VALUES('telegram-study-owner','study-community','study-account','owner','active')",
        );
        await admin.query(`CREATE ROLE ${role} NOLOGIN`);
        try {
          await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${role}`);
          await admin.query(
            `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${role}`,
          );
          await admin.query(
            `REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON study_learner_catalogue_decisions FROM ${role}`,
          );
          const serving = `${connectionString}${connectionString.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema} -c role=${role}`)}`;
          const db = makeTelegramDatabase(makeDirectPostgresControlPlaneLayer(serving));
          const catalogue = makeTelegramCommunityStudyCatalogue(db, "fixture-policy");
          const settings = makeTelegramSettingsStore(db);
          await settings.owner("study-community", "study-account");
          await expect(settings.owner("study-community", "other-account")).rejects.toMatchObject({
            reason: "unauthorized",
          });
          const record = {
            ...emptyTelegramIntegration("study-community"),
            botId: "123",
            botUsername: "fixture_bot",
            botEpoch: "epoch",
            status: "ready" as const,
            study: { enabled: true, botId: "123" },
          };
          const saved = await settings.saveIntegration(
            record,
            0,
            "enable",
            "enable-hash",
            "study-account",
          );
          expect(saved.revision).toBe(1);
          expect((await settings.integration("study-community")).study).toEqual({
            enabled: true,
            botId: "123",
          });
          expect(
            (await settings.saveIntegration(record, 0, "enable", "enable-hash", "study-account"))
              .revision,
          ).toBe(1);
          await expect(
            settings.saveIntegration(record, 0, "stale", "stale-hash", "study-account"),
          ).rejects.toMatchObject({ reason: "conflict" });
          await expect(
            settings.saveIntegration(record, 1, "denied", "denied-hash", "other-account"),
          ).rejects.toMatchObject({ reason: "unauthorized" });
          expect(await catalogue.page("study-community")).toEqual({ items: [], nextCursor: null });
          let revision = 0;
          const approve = async (
            disposition = "eligible",
            audioRevision = 1,
            policy = "fixture-policy",
          ) => {
            await admin.query(
              `INSERT INTO study_learner_catalogue_decisions(community_id,post_id,decision_revision,policy_revision,disposition,audio_revision,lyrics_revision,language_profile_revision,content_rating,learner_band,learning_language,exercise_type,reviewer_role,review_evidence_sha256,effective_at)
            VALUES('study-community','study-post',$1,$2,$3,$4,1,1,'general',NULL,'en','say_it_back','test_reviewer',$5,clock_timestamp())`,
              [++revision, policy, disposition, audioRevision, "a".repeat(64)],
            );
          };
          await approve("fixture_only");
          expect(await catalogue.ready("study-community", "study-post")).toBe(false);
          await approve();
          expect(await catalogue.page("study-community")).toEqual({
            items: [{ postId: "study-post", title: "Study song" }],
            nextCursor: null,
          });
          expect(await catalogue.ready("other-community", "study-post")).toBe(false);
          expect(await catalogue.ready("study-community", "other-post")).toBe(false);
          expect((await catalogue.page("study-community", "study-post")).items).toEqual([]);
          await approve("ineligible");
          expect(await catalogue.ready("study-community", "study-post")).toBe(false);
          await approve("eligible", 2);
          expect(await catalogue.ready("study-community", "study-post")).toBe(false);
          await approve("eligible", 1, "other-policy");
          expect(await catalogue.ready("study-community", "study-post")).toBe(false);
          await approve();
          expect(await catalogue.ready("study-community", "study-post")).toBe(true);
          await expect(
            admin.query(`INSERT INTO study_learner_catalogue_decisions
            SELECT (jsonb_populate_record(NULL::study_learner_catalogue_decisions,to_jsonb(source)||jsonb_build_object(
              'decision_revision',decision_revision+1,'effective_at',clock_timestamp()+interval '1 day'))).*
            FROM study_learner_catalogue_decisions source WHERE post_id='study-post' ORDER BY decision_revision DESC LIMIT 1`),
          ).rejects.toThrow("scheduling_unsupported");
          await admin.query(
            "UPDATE posts SET visibility='members_only' WHERE post_id='study-post'",
          );
          expect(await catalogue.ready("study-community", "study-post")).toBe(false);
          await admin.query("UPDATE posts SET visibility='public' WHERE post_id='study-post'");
          await expect(
            db.query("UPDATE study_learner_catalogue_decisions SET disposition='eligible'"),
          ).rejects.toThrow();
          await expect(
            db.query(
              "INSERT INTO study_learner_catalogue_decisions SELECT * FROM study_learner_catalogue_decisions",
            ),
          ).rejects.toThrow();
          await expect(
            admin.query("UPDATE study_learner_catalogue_decisions SET disposition='ineligible'"),
          ).rejects.toThrow("immutable");
          await expect(
            admin.query("DELETE FROM study_learner_catalogue_decisions"),
          ).rejects.toThrow("immutable");
          await expect(admin.query("TRUNCATE study_learner_catalogue_decisions")).rejects.toThrow(
            "immutable",
          );
          expect(await catalogue.ready("study-community", "study-post")).toBe(true);
          await insertTelegramCatalogueFirstPage(admin);
          const firstPage = await catalogue.page("study-community");
          expect(firstPage.items).toHaveLength(8);
          expect(firstPage.items.some((song) => song.postId === "study-post")).toBe(false);
          expect(
            (await catalogue.page("study-community", firstPage.nextCursor ?? undefined)).items.map(
              (song) => song.postId,
            ),
          ).toEqual(["study-post"]);
          await admin.query(
            `REVOKE UPDATE,DELETE,TRUNCATE ON telegram_restricted_learners,telegram_restricted_study_personas FROM ${role}`,
          );
          const sender = {
            communityId: "study-community",
            botId: "123",
            epoch: "epoch",
            telegramUserId: "555",
          };
          await db.query(
            "INSERT INTO community_telegram_private_chats(community_id,bot_epoch,telegram_user_id) VALUES('study-community','epoch','555')",
          );
          const chat = makeTelegramStudyStore(db, "study-community", []);
          const lease = await chat.claim(sender, "community-lease");
          if (!lease) throw Error("Missing lease");
          const grant = await makeTelegramStudyLearnerStore(db, "study-community").enroll(lease);
          if (grant === "unavailable") throw Error("Missing restricted grant");
          const admission = telegramStudyAdmission(lease, grant, [], "fixture-policy");
          expect(admission.practiceOnly).toBe(true);
          const runtime = makeDirectPostgresControlPlaneLayer(serving);
          const repository = makeControlPlaneStudyV2Repository(admission);
          const start = (id: string) =>
            Effect.runPromise(
              Effect.scoped(
                repository
                  .startSession({
                    accountId: grant.accountId,
                    communityId: "study-community",
                    personaId: grant.personaId,
                    postId: "study-post",
                    sessionId: id,
                    idempotencyKey: id,
                    requestHash: "b".repeat(64),
                    createdAt: new Date().toISOString(),
                    learnerBand: null,
                    targetLanguage: null,
                    timezone: "UTC",
                  })
                  .pipe(Effect.provide(runtime)),
              ),
            );
          const previousIntent = await settings.integration("study-community");
          const absentIntent = { ...previousIntent };
          delete absentIntent.study;
          await settings.saveIntegration(
            absentIntent,
            previousIntent.revision,
            "absent-intent",
            "absent-hash",
            "study-account",
          );
          await expect(start("refused-absent-intent")).rejects.toMatchObject({
            reason: "not-found",
          });
          await settings.saveIntegration(
            { ...absentIntent, study: { enabled: true, botId: "123" } },
            previousIntent.revision + 1,
            "initial-intent",
            "initial-hash",
            "study-account",
          );
          const session = await start("community-session");
          expect(session.items).toHaveLength(4);
          expect(
            (
              await admin.query(
                "SELECT telegram_practice_only FROM study_sessions_v2 WHERE session_id=$1",
                [session.session_id],
              )
            ).rows,
          ).toEqual([{ telegram_practice_only: true }]);
          let current = await settings.integration("study-community");
          for (const study of [
            { enabled: false, botId: "123" },
            { enabled: true, botId: "wrong-bot" },
          ]) {
            current = await settings.saveIntegration(
              { ...current, study },
              current.revision,
              `change-${current.revision}`,
              `hash-${current.revision}`,
              "study-account",
            );
            await expect(start(`refused-${current.revision}`)).rejects.toMatchObject({
              reason: "not-found",
            });
          }
          current = await settings.saveIntegration(
            { ...current, study: { enabled: true, botId: "123" } },
            current.revision,
            "restore",
            "restore-hash",
            "study-account",
          );
          await approve("ineligible");
          await expect(start("refused-denial")).rejects.toMatchObject({ reason: "not-found" });
          await approve();
          expect((await start("restored-community-session")).items).toHaveLength(4);
          // A source producer may hold the post lock without updating the post itself.
          // The readiness snapshot must follow that commit, rather than see its predecessor.
          await admin.query("BEGIN");
          try {
            await admin.query(
              "SELECT post_id FROM posts WHERE community_id='study-community' AND post_id='study-post' FOR UPDATE",
            );
            const racing = start("refused-new-profile").then(
              (value) => ({ kind: "accepted" as const, value }),
              (error) => ({ kind: "rejected" as const, error }),
            );
            let waiting = false;
            for (let attempt = 0; attempt < 100; attempt++) {
              await admin.query("SELECT pg_stat_clear_snapshot()");
              waiting =
                (
                  await admin.query(
                    "SELECT EXISTS(SELECT 1 FROM pg_stat_activity activity JOIN pg_locks locks ON locks.pid=activity.pid WHERE activity.pid<>pg_backend_pid() AND locks.relation='posts'::regclass AND activity.wait_event_type='Lock' AND activity.state='active') AS waiting",
                  )
                ).rows[0].waiting === true;
              if (waiting) break;
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            expect(waiting).toBe(true);
            await admin.query(
              `INSERT INTO study_language_profiles
              SELECT (jsonb_populate_record(NULL::study_language_profiles,to_jsonb(source)||jsonb_build_object(
                'language_profile_revision',2,'prompt_revision','fixture-next','request_hash',$1::text))).*
              FROM study_language_profiles source WHERE post_id='study-post' AND language_profile_revision=1`,
              ["b".repeat(64)],
            );
            await admin.query(`INSERT INTO study_language_profile_units
              SELECT (jsonb_populate_record(NULL::study_language_profile_units,to_jsonb(source)||jsonb_build_object('language_profile_revision',2))).*
              FROM study_language_profile_units source WHERE post_id='study-post' AND language_profile_revision=1`);
            await admin.query("COMMIT");
            const outcome = await racing;
            expect(outcome.kind).toBe("rejected");
            if (outcome.kind === "rejected")
              expect(outcome.error).toMatchObject({ reason: "not-found" });
          } catch (error) {
            await admin.query("ROLLBACK");
            throw error;
          }
          await settings.saveIntegration(
            { ...current, botEpoch: "reconnected" },
            current.revision,
            "reconnect",
            "reconnect-hash",
            "study-account",
          );
          await expect(start("refused-reconnect")).rejects.toMatchObject({ reason: "not-found" });
        } finally {
          await admin.query(`DROP OWNED BY ${role}`);
          await admin.query(`DROP ROLE ${role}`);
        }
      },
    });
  }, 60000);
});
