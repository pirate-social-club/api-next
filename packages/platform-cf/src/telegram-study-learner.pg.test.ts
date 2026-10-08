import { describe, expect, test } from "bun:test";
import {
  type TelegramStudyGrant,
  TelegramStudyLeaseExpired,
  type TelegramStudySender,
} from "@pirate/application/telegram-study";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { type ControlPlaneDb, makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import {
  insertStudySongFixture,
  insertTelegramPracticeReadinessFixture,
} from "./study-v2-ready-song.pg-fixture.ts";
import { makeControlPlaneStudyV2Repository } from "./study-v2-repository.ts";
import { makeTelegramDatabase } from "./telegram-database.ts";
import { makeTelegramLanguageStore } from "./telegram-language-store.ts";
import { emptyTelegramIntegration } from "./telegram-settings-store.ts";
import { telegramStudyAdmission } from "./telegram-study-admission.ts";
import { makeTelegramStudyLearnerStore } from "./telegram-study-learner-store.ts";
import { makeTelegramStudyStore } from "./telegram-study-store.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
const suite = connectionString === undefined ? describe.skip : describe;
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

suite("restricted Telegram practice identity", () => {
  test("one affirmed learner account per Telegram user, one neutral persona per community, practice only", async () => {
    if (connectionString === undefined) throw new Error("test URL was not configured");
    const schema = `api_next_telegram_learner_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const scoped = `${connectionString}${connectionString.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    try {
      await applyPostgresTestBaselineConnection({ connectionString: scoped });
      await insertStudySongFixture(admin);
      await insertTelegramPracticeReadinessFixture(admin);
      const runtime = makeDirectPostgresControlPlaneLayer(scoped);
      const database = makeTelegramDatabase(runtime);
      const count = async (sql: string, values: readonly unknown[] = []) =>
        Number(
          (await admin.query(`SELECT count(*)::integer AS n FROM ${sql}`, [...values])).rows[0].n,
        );
      const connectBot = async (communityId: string, botId: string) => {
        if (communityId !== "study-community")
          await admin.query(
            `INSERT INTO communities(community_id,display_name,status,created_by_user_id,created_at,updated_at)
             VALUES($1,$1,'active','study-account',clock_timestamp(),clock_timestamp())`,
            [communityId],
          );
        await admin.query(
          `INSERT INTO community_telegram_integrations(community_id,record,revision,bot_epoch,webhook_id,bot_id)
           VALUES($1,$2::jsonb,1,'epoch',$3,$4)`,
          [
            communityId,
            JSON.stringify({
              ...emptyTelegramIntegration(communityId),
              botEpoch: "epoch",
              botId,
              botUsername: `fixture_${botId}_bot`,
              status: "ready",
            }),
            `hook-${botId}`,
            botId,
          ],
        );
      };
      const startChat = (communityId: string, telegramUserId: string) =>
        admin.query(
          "INSERT INTO community_telegram_private_chats(community_id,bot_epoch,telegram_user_id) VALUES($1,'epoch',$2)",
          [communityId, telegramUserId],
        );
      const open = async (communityId: string, botId: string, telegramUserId: string) => {
        const sender: TelegramStudySender = { communityId, botId, epoch: "epoch", telegramUserId };
        const chat = makeTelegramStudyStore(database, communityId, ["study-post"]);
        const learners = makeTelegramStudyLearnerStore(database, communityId);
        const lease = await chat.claim(sender, `lease-${communityId}-${telegramUserId}`);
        if (lease === null) throw new Error("fixture conversation is busy");
        return { sender, lease, learners };
      };
      const restrictedGrant = (value: unknown): TelegramStudyGrant => {
        if (typeof value !== "object" || value === null) throw new Error(`not issued: ${value}`);
        return value as TelegramStudyGrant;
      };
      await connectBot("study-community", "123");

      // Nothing is issued before /start, without the conversation lease, or without the answer.
      const first = await open("study-community", "123", "555");
      expect(await first.learners.enroll(first.lease, true)).toBe("unavailable");
      await startChat("study-community", "555");
      expect(await first.learners.enroll({ ...first.lease, token: "another" }, true)).toBe(
        "unavailable",
      );
      expect(await first.learners.enroll(first.lease, false)).toBe("age_required");
      expect(await first.learners.resolve(first.sender)).toBeNull();
      expect(await count("users")).toBe(1);
      expect(await count("telegram_restricted_learners")).toBe(0);
      expect(await count("account_minimum_age_attestations")).toBe(0);

      const grant = restrictedGrant(await first.learners.enroll(first.lease, true));
      expect(grant).toMatchObject({ revision: 0, restricted: true });
      expect(grant.accountId).toMatch(/^usr_[0-9a-f]{32}$/u);
      expect(grant.accountId).not.toContain("555");
      expect(
        (
          await admin.query(
            `SELECT u.status,u.account,a.version,a.minimum_age,a.affirmed,l.evidence,
               l.affirmed_community_id,l.affirmed_bot_id,l.affirmed_bot_epoch
             FROM users u JOIN account_minimum_age_attestations a ON a.account_id=u.user_id
             JOIN telegram_restricted_learners l ON l.account_id=u.user_id WHERE u.user_id=$1`,
            [grant.accountId],
          )
        ).rows,
      ).toEqual([
        {
          status: "active",
          account: {},
          version: "minimum-age-attestation-v1",
          minimum_age: 16,
          affirmed: true,
          evidence: "ingress_observed",
          affirmed_community_id: "study-community",
          affirmed_bot_id: "123",
          affirmed_bot_epoch: "epoch",
        },
      ]);
      const persona = (
        await admin.query(
          `SELECT p.status,p.is_first_persona,profile.display_name,b.binding_source,b.community_id,
             w.status AS wallet_status,w.address,w.privy_wallet_id
           FROM personas p JOIN persona_profiles profile USING(persona_id)
           JOIN persona_community_bindings b USING(persona_id)
           JOIN persona_wallet_assignments w USING(persona_id) WHERE p.persona_id=$1`,
          [grant.personaId],
        )
      ).rows;
      expect(persona).toEqual([
        {
          status: "active",
          is_first_persona: false,
          display_name: expect.stringMatching(/^Learner [1-9][0-9]{5}$/u),
          binding_source: "activity_participation",
          community_id: "study-community",
          wallet_status: "pending",
          address: null,
          privy_wallet_id: null,
        },
      ]);
      // No login, link, membership, handle or provisioned wallet exists for the learner.
      for (const [table, column] of [
        ["identity_credentials", "canonical_user_id"],
        ["telegram_account_associations", "account_id"],
        ["telegram_bot_grants", "account_id"],
        ["community_memberships", "user_id"],
        ["platform_pirate_handles", "actor_account_id"],
      ] as const)
        expect(await count(`${table} WHERE ${column}=$1`, [grant.accountId])).toBe(0);
      expect(
        await count(
          "persona_wallet_assignments WHERE account_id=$1 AND (address IS NOT NULL OR privy_wallet_id IS NOT NULL)",
          [grant.accountId],
        ),
      ).toBe(0);

      // Retries, later lessons and a reconnected ingress reuse the same identity.
      expect(await first.learners.enroll(first.lease, false)).toEqual(grant);
      expect(await first.learners.resolve(first.sender)).toEqual(grant);
      expect(await first.learners.resolve({ ...first.sender, epoch: "older" })).toBeNull();
      expect(await count("telegram_restricted_study_personas")).toBe(1);

      // Concurrent first use by another sender converges on one account and persona.
      await startChat("study-community", "777");
      const racing = await open("study-community", "123", "777");
      const raced = await Promise.all(
        Array.from({ length: 4 }, () => racing.learners.enroll(racing.lease, true)),
      );
      expect(new Set(raced.map((value) => JSON.stringify(value))).size).toBe(1);
      expect(await count("telegram_restricted_learners WHERE telegram_user_id='777'")).toBe(1);
      expect(
        await count("telegram_restricted_study_personas WHERE account_id=$1", [
          restrictedGrant(raced[0]).accountId,
        ]),
      ).toBe(1);

      // A linked account without this bot's grant is never read, written or revealed.
      await admin.query(
        "INSERT INTO telegram_account_associations(telegram_user_id,account_id) VALUES('321','study-account')",
      );
      await startChat("study-community", "321");
      const known = await open("study-community", "123", "321");
      expect(await known.learners.enroll(known.lease, false)).toBe("age_required");
      const isolated = restrictedGrant(await known.learners.enroll(known.lease, true));
      expect(isolated.accountId).not.toBe("study-account");
      expect(await count("personas WHERE account_id='study-account'")).toBe(1);
      expect(await count("telegram_bot_grants")).toBe(0);

      // Other bots reuse the account with a new persona, up to the ordinary daily limit.
      const personas = new Set([grant.personaId]);
      for (const [communityId, botId] of [
        ["second-community", "456"],
        ["third-community", "789"],
      ] as const) {
        await connectBot(communityId, botId);
        await startChat(communityId, "555");
        const elsewhere = await open(communityId, botId, "555");
        const issued = restrictedGrant(await elsewhere.learners.enroll(elsewhere.lease, false));
        expect(issued.accountId).toBe(grant.accountId);
        personas.add(issued.personaId);
      }
      expect(personas.size).toBe(3);
      await connectBot("fourth-community", "1011");
      await startChat("fourth-community", "555");
      const exhausted = await open("fourth-community", "1011", "555");
      expect(await exhausted.learners.enroll(exhausted.lease, true)).toBe("unavailable");
      expect(await count("telegram_restricted_learners WHERE telegram_user_id='555'")).toBe(1);
      expect(await count("personas WHERE account_id=$1", [grant.accountId])).toBe(4);
      expect(
        await count("telegram_restricted_study_personas WHERE account_id=$1", [grant.accountId]),
      ).toBe(3);
      await expect(
        admin.query("UPDATE telegram_restricted_learners SET account_id='study-account'"),
      ).rejects.toMatchObject({ code: "23514" });

      // The shared Study path admits the learner as practice only and nothing else.
      const run = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
        Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(runtime))));
      const start = (
        study: ReturnType<typeof makeControlPlaneStudyV2Repository>,
        sessionId: string,
      ) =>
        run(
          study.startSession({
            accountId: grant.accountId,
            communityId: "study-community",
            createdAt: new Date().toISOString(),
            targetLanguage: null,
            idempotencyKey: `telegram:${sessionId}:start`,
            learnerBand: null,
            personaId: grant.personaId,
            postId: "study-post",
            requestHash: "5".repeat(64),
            sessionId,
            timezone: "UTC",
          }),
        );
      // Even a path without the Telegram admission cannot open a rewardable session.
      await expect(
        start(makeControlPlaneStudyV2Repository(), "ordinary-session"),
      ).rejects.toMatchObject({ _tag: "StudyV2StoreFailed", reason: "constraint" });
      expect(await count("study_sessions_v2")).toBe(0);
      const study = makeControlPlaneStudyV2Repository(
        telegramStudyAdmission(first.lease, grant, ["study-post"]),
      );
      const session = await start(study, "restricted-session");
      expect(session.items).toHaveLength(4);
      expect(
        (
          await admin.query(
            "SELECT account_id,persona_id,telegram_practice_only FROM study_sessions_v2",
          )
        ).rows,
      ).toEqual([
        {
          account_id: grant.accountId,
          persona_id: grant.personaId,
          telegram_practice_only: true,
        },
      ]);
      const read = (
        admission: ReturnType<typeof telegramStudyAdmission>,
        accountId = grant.accountId,
      ) =>
        run(
          makeControlPlaneStudyV2Repository(admission).getSession({
            accountId,
            communityId: "study-community",
            sessionId: session.session_id,
          }),
        );
      expect((await read(telegramStudyAdmission(first.lease, grant, ["study-post"])))?.status).toBe(
        "active",
      );
      // The menu offers Resume to the learner alone, with no linked-account grant.
      const languages = makeTelegramLanguageStore(database);
      expect((await languages.learnerLanguageContext(first.sender)).resumeAvailable).toBe(false);
      await makeTelegramStudyStore(database, "study-community", ["study-post"]).save(first.lease, {
        ...first.lease.state,
        sessionId: session.session_id,
        grantRevision: 0,
      });
      expect((await languages.learnerLanguageContext(first.sender)).resumeAvailable).toBe(true);
      expect((await languages.learnerLanguageContext(racing.sender)).resumeAvailable).toBe(false);
      // Another sender's lease, another learner's identity and a stale ingress are refused.
      await expect(
        read(telegramStudyAdmission(racing.lease, grant, ["study-post"])),
      ).rejects.toMatchObject({ reason: "not-found" });
      await expect(
        read(telegramStudyAdmission(first.lease, isolated, ["study-post"]), isolated.accountId),
      ).rejects.toMatchObject({ reason: "not-found" });
      await admin.query(
        "UPDATE telegram_study_conversations SET lease_until=clock_timestamp()-interval '1 second' WHERE telegram_user_id='555' AND community_id='study-community'",
      );
      await expect(
        read(telegramStudyAdmission(first.lease, grant, ["study-post"])),
      ).rejects.toBeInstanceOf(TelegramStudyLeaseExpired);
      await admin.query(
        "UPDATE telegram_study_conversations SET lease_until=clock_timestamp()+interval '120 seconds' WHERE telegram_user_id='555' AND community_id='study-community'",
      );
      await admin.query(
        `UPDATE community_telegram_integrations SET record=jsonb_set(record,'{botEpoch}','"rotated"'),bot_epoch='rotated'
         WHERE community_id='study-community'`,
      );
      await expect(
        read(telegramStudyAdmission(first.lease, grant, ["study-post"])),
      ).rejects.toMatchObject({ reason: "not-found" });
      expect(await count("activity_qualifications")).toBe(0);
    } finally {
      await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
      await admin.end();
    }
  }, 120_000);
});
