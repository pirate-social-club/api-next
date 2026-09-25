/**
 * Spec 015 §5.2a: a reward winner without Very evidence starts the claim
 * ceremony from an account-scoped reward_claim intent. The resolver must
 * return exactly the join palm plan, including its purpose, so one palm keeps
 * one Very subject across joins and claims.
 */
import { describe, expect, test } from "bun:test";
import { CURATED_HUMAN_MEMBERSHIP_POLICY, VERY_WEB_PROVIDER_ID } from "@pirate/domain";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeControlPlaneCommunityJoinIntentResolver } from "./community-join-intent-resolver.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import {
  issueRewardClaimVerificationIntent,
  makeControlPlaneRewardClaimIntentResolver,
} from "./reward-claim-verification-intent.ts";
import { makeOrderedVerificationIntentResolver } from "./verification-intent-resolver.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString ? describe : describe.skip;

suite("Postgres 17 reward-claim Very intent", () => {
  test("issues, reuses and resolves only the account's intent to the join palm plan", async () => {
    if (!connectionString) throw new Error("test URL was not configured");
    const schema = `reward_claim_intent_${Date.now()}`;
    const scoped = `${connectionString}${connectionString.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    try {
      await applyPostgresTestBaselineConnection({ connectionString: scoped });
      await admin.query("INSERT INTO users (user_id) VALUES ('winner'), ('other')");
      const layer = makeDirectPostgresControlPlaneLayer(scoped);
      const issue = (account: string) =>
        Effect.runPromise(Effect.provide(issueRewardClaimVerificationIntent(account), layer));
      const first = await issue("winner");
      expect(first.startsWith("reward-claim_")).toBe(true);
      expect(await issue("winner")).toBe(first);
      expect(
        (
          await admin.query(
            `SELECT user_id, community_id, action_kind, action_scope, status
               FROM action_intents WHERE action_intent_id=$1`,
            [first],
          )
        ).rows,
      ).toEqual([
        {
          user_id: "winner",
          community_id: null,
          action_kind: "reward_claim",
          action_scope: "winner",
          status: "open",
        },
      ]);

      const rewardResolver = makeControlPlaneRewardClaimIntentResolver(layer, "test");
      const chain = makeOrderedVerificationIntentResolver([
        makeControlPlaneCommunityJoinIntentResolver(layer, "test"),
        rewardResolver,
      ]);
      const resolve = (actor: string, intent: string, provider: string = VERY_WEB_PROVIDER_ID) =>
        Effect.runPromise(
          chain.resolve({ actor_id: actor, intent_id: intent, provider_id: provider }),
        );
      expect(await resolve("winner", first)).toMatchObject({
        method: "palm_web",
        requested_claim_ids: ["credential.subject_unique", "human.personhood"],
        subject_binding_intent: "establish",
        environment: "test",
        verification_purpose: {
          intent: "community_join",
          policy_id: CURATED_HUMAN_MEMBERSHIP_POLICY.policy_version_id,
        },
      });
      expect(await resolve("other", first)).toBeNull();
      expect(await resolve("winner", first, "self.pass")).toBeNull();
      expect(await resolve("winner", "reward-claim_unknown")).toBeNull();

      // An expired intent no longer resolves, and the next request issues a
      // fresh one rather than reusing it.
      await admin.query(
        "UPDATE action_intents SET expires_at=clock_timestamp() - interval '1 minute' WHERE action_intent_id=$1",
        [first],
      );
      expect(await resolve("winner", first)).toBeNull();
      const second = await issue("winner");
      expect(second).not.toBe(first);
      expect(await resolve("winner", second)).not.toBeNull();
      expect(await issue("other")).not.toBe(second);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  }, 60000);
});
