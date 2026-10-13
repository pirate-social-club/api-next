/** Three genuine owned creator cases. No positive Guest money/session rows,
 * live RPC/provider/storage, injected native readiness or widened app budgets. */
import { expect, mock, test } from "bun:test";
import { AddMegapotPoolLeg } from "@pirate/contracts";
import { type Effect, Schema } from "effect";
import { makeHttpWorkerTestBindings } from "../../../apps/http-worker/src/composition.test-fixtures.ts";
import { bounded } from "./account-study-producer.pg-fixture.ts";
import { encodeMegapotJackpotTicketNft, encodeMegapotJackpotUsdc } from "./megapot-v2.ts";
import { makeOwnedOrdinaryAccountBirthFixture } from "./ordinary-study-account-birth.pg-fixture.ts";
import {
  actor,
  address,
  bytecode,
  creatorFixture,
  endpoint,
  observed,
  peer,
  prepareCreatorSource,
  waitForRoleLock,
  withClock,
} from "./owner-megapot-creator.pg-fixture.ts";
import { pgUrl } from "./owner-study-starter.pg-fixture.ts";
import { makeSessionCrypto } from "./session-crypto.ts";
import { makeControlPlaneSongOwnerPolicyStore } from "./song-owner-video-policy-repository.ts";
import {
  insertStudySongFixture,
  insertTelegramPracticeReadinessFixture,
} from "./study-v2-ready-song.pg-fixture.ts";

// Same maintained Node platform stand-in. No DB/authority/handler/grading mocks.
mock.module("cloudflare:workers", () => ({
  DurableObject: class DurableObject {},
}));
const { createProductionHttpWorker } = await import("../../../apps/http-worker/src/composition.ts");
const pgTest = pgUrl ? test : test.skip;
const decode = <S extends Schema.ConstraintDecoder<unknown>>(s: S, v: unknown): S["Type"] =>
  Schema.decodeUnknownSync(s, { onExcessProperty: "error" })(v);
async function actorFacts(f: Parameters<Parameters<typeof creatorFixture>[0]>[0], offer: string) {
  return (
    await f.admin.query(
      `SELECT count(*)::integer AS legs,
 (SELECT count(*)::integer FROM song_reward_offer_actions WHERE offer_id=$1 AND endpoint_template=$2) AS actions
 FROM song_reward_offer_legs WHERE offer_id=$1`,
      [offer, endpoint],
    )
  ).rows;
}

pgTest(
  "restricted123 NEWv3 and genuine default HTTP absent financial flags retain v2",
  async () => {
    await creatorFixture(async (f) => {
      expect(f.schema).toBe("api_next");
      const prepared = await prepareCreatorSource(f, "native-and-default");
      const made = await withClock(prepared.service.addMegapotPoolLeg(prepared.legInput));
      expect(made.replayed).toBe(false);
      const original = (
        await f.admin.query(
          "SELECT beneficiary_version,owner_policy_revision::text,owner_policy_hash FROM song_reward_offer_legs WHERE leg_id=$1",
          [made.leg.legId],
        )
      ).rows;
      expect(original).toMatchObject([{ beneficiary_version: 3, owner_policy_revision: "1" }]);
      // A genuine second prepared SONG and offer preserve0053's one-open-leg
      // per offer/source constraint without closing the original v3 leg.
      const additionalSourceTag = "creator-default";
      await insertStudySongFixture(f.admin, {
        accountAlreadyBorn: true,
        initializeOwnerPolicy: true,
        additionalSourceTag,
      });
      await insertTelegramPracticeReadinessFixture(f.admin, { additionalSourceTag });
      const defaultOffer = await withClock(
        prepared.service.openOffer({
          accountId: actor,
          personaId: prepared.personaId,
          communityId: "study-community",
          postId: `${additionalSourceTag}-post`,
          idempotencyKey: "creator-default-offer",
          startsAt: new Date(Date.now() - 1000).toISOString(),
          endsAt: new Date(Date.now() + 3600000).toISOString(),
        }),
      );
      expect(defaultOffer.offer.offerId).not.toBe(prepared.offerId);
      const base = await makeHttpWorkerTestBindings(f.ordinaryUrl);
      const bindings = { ...base, MEGAPOT_REWARDS_ENABLED: "true" };
      // No Guest financial/learning flags: actual default factory must use v2 even
      // with the actual compiled financial source installed (the flag stays absent).
      const originalFetch = globalThis.fetch;
      let calls = 0;
      const Rpc = Schema.Struct({
        jsonrpc: Schema.Literal("2.0"),
        id: Schema.String,
        method: Schema.String,
        params: Schema.Array(Schema.Unknown),
      });
      const synthetic: typeof globalThis.fetch = Object.assign(
        async (...args: Parameters<typeof globalThis.fetch>): Promise<Response> => {
          const [input, init] = args;
          const url = input instanceof Request ? input.url : String(input);
          if (url !== new URL(decode(Schema.String, bindings.MEGAPOT_V2_RPC_URL)).toString())
            throw new Error("Unexpected owned external request");
          const request = decode(Rpc, JSON.parse(decode(Schema.String, init?.body)));
          calls++;
          let result: string;
          if (request.method === "eth_chainId") result = "0x14a34";
          else if (request.method === "eth_getCode") {
            const target = decode(Schema.String, request.params[0]);
            if (target === address("2")) result = bytecode.jackpot;
            else if (target === address("3")) result = bytecode.ticket;
            else if (target === address("1")) result = bytecode.usdc;
            else throw new Error("Foreign owned code request");
          } else if (request.method === "eth_call") {
            const call = decode(
              Schema.Struct({ to: Schema.String, data: Schema.String }),
              request.params[0],
            );
            if (call.to !== address("2")) throw new Error("Foreign owned contract request");
            if (call.data === encodeMegapotJackpotTicketNft())
              result = `0x${address("3").slice(2).padStart(64, "0")}`;
            else if (call.data === encodeMegapotJackpotUsdc())
              result = `0x${address("1").slice(2).padStart(64, "0")}`;
            else throw new Error("Unexpected owned attestation selector");
          } else throw new Error("Unexpected owned RPC method");
          return Response.json({ jsonrpc: "2.0", id: request.id, result });
        },
        originalFetch,
      );
      let failed = false,
        primary: unknown;
      const cleanup: unknown[] = [];
      let requestSettlement:
        | Promise<{ ok: true; value: Response } | { ok: false; error: unknown }>
        | undefined;
      try {
        globalThis.fetch = synthetic;
        const worker = await createProductionHttpWorker(bindings);
        const {
          PIRATE_APP_JWT_PRIVATE_KEY: privateKeyPem,
          PIRATE_APP_JWT_PUBLIC_KEY: publicKeyPem,
          PIRATE_APP_JWT_ISSUER: issuer,
          PIRATE_APP_JWT_AUDIENCE: audience,
          PIRATE_APP_JWT_SCOPE: scope,
        } = bindings;
        if (
          privateKeyPem === undefined ||
          publicKeyPem === undefined ||
          issuer === undefined ||
          audience === undefined ||
          scope === undefined
        )
          throw new Error("Actual owned session keys required");
        const crypto = await makeSessionCrypto({
          privateKeyPem,
          publicKeyPem,
          issuer,
          audience,
          defaultScope: scope,
          defaultTtlSeconds: 300,
        });
        const token = await crypto.sign({ sub: actor, scope });
        const request = Promise.resolve(
          worker.fetch(
            new Request(
              `https://worker.test/reward-offers/${encodeURIComponent(defaultOffer.offer.offerId)}/megapot-pool-legs`,
              {
                method: "POST",
                headers: {
                  cookie: `__Host-pirate_session=${token}; __Host-pirate_csrf=owned-creator-csrf`,
                  origin: "https://solid.test",
                  "x-csrf-token": "owned-creator-csrf",
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  persona_id: prepared.personaId,
                  idempotency_key: "default-v2-leg",
                  funding_amount_atomic: "100000",
                  max_ticket_price_atomic: "10000",
                  entry_cutoff_seconds: 300,
                  eligible_activities: ["study"],
                  expected_qualification_policy_versions: {
                    study: "study_session_first_pass_v2@1",
                  },
                  min_score_bps: 7000,
                  empty_pool_policy: "no_purchase",
                  fallback_payout_persona_id: null,
                  fallback_disclosure_acknowledged: false,
                }),
              },
            ),
          ),
        );
        requestSettlement = observed(request);
        const response = await bounded(request, "actual default creator request", 8000);
        expect(response.status).toBe(201);
        const result = decode(AddMegapotPoolLeg.response, await response.json());
        expect(result.replayed).toBe(false);
        const row = (
          await f.admin.query(
            "SELECT beneficiary_version FROM song_reward_offer_legs WHERE leg_id=$1",
            [result.leg.leg_id],
          )
        ).rows;
        expect(row).toEqual([{ beneficiary_version: 2 }]);
        expect(
          (
            await f.admin.query(
              "SELECT beneficiary_version,owner_policy_revision::text,owner_policy_hash FROM song_reward_offer_legs WHERE leg_id=$1",
              [made.leg.legId],
            )
          ).rows,
        ).toEqual(original);
        expect(calls).toBe(6);
        expect(f.providerCalls()).toBe(0);
        expect(f.putCalls()).toBe(0);
      } catch (error) {
        failed = true;
        primary = error;
      } finally {
        if (requestSettlement !== undefined)
          try {
            await bounded(requestSettlement, "actual default request unconditional drain", 10000);
          } catch (error) {
            cleanup.push(error);
          }
        try {
          globalThis.fetch = originalFetch;
        } catch (error) {
          cleanup.push(error);
        }
      }
      if (failed || cleanup.length)
        throw new AggregateError(
          [...(failed ? [primary] : []), ...cleanup],
          "Default creator request or external-boundary restoration failed",
        );
    }, true);
  },
  60000,
);

pgTest(
  "alias/deactivation committed during original topology wait refuses NEW before any leg/action",
  async () => {
    for (const transition of ["alias", "deactivation"] as const) {
      await creatorFixture(async (f) => {
        const prepared = await prepareCreatorSource(f, `fresh-${transition}`);
        if (transition === "alias")
          await makeOwnedOrdinaryAccountBirthFixture(f.adminRuntime)("creator-canonical-target");
        const mutation = await peer(f);
        let active = false;
        let operation:
          | Promise<
              | {
                  ok: true;
                  value: Effect.Success<ReturnType<typeof prepared.service.addMegapotPoolLeg>>;
                }
              | { ok: false; error: unknown }
            >
          | undefined;
        let failed = false,
          primary: unknown;
        const cleanup: unknown[] = [];
        try {
          await mutation.query("BEGIN");
          active = true;
          // Existing EXCLUSIVE identity/topology namespace, not a custom test lock.
          await mutation.query("SELECT pg_advisory_xact_lock(83000003,1)");
          const before = await actorFacts(f, prepared.offerId);
          const running = observed(
            withClock(prepared.service.addMegapotPoolLeg(prepared.legInput)),
          );
          operation = running;
          await waitForRoleLock(f, f.ordinaryRole);
          // Owned lifecycle fault, not a fabricated positive financial/source row.
          if (transition === "alias")
            await mutation.query(
              "INSERT INTO account_aliases(source_user_id,canonical_user_id,kind,status) VALUES($1,$2,'alias','active')",
              [actor, "creator-canonical-target"],
            );
          else await mutation.query("UPDATE users SET status='deleted' WHERE user_id=$1", [actor]);
          await mutation.query("COMMIT");
          active = false;
          const outcome = await bounded(running, "original actor waiter settlement", 5000);
          expect(outcome.ok).toBe(false);
          if (outcome.ok) throw new Error("Stale actor NEW creator unexpectedly succeeded");
          expect(outcome.error).toMatchObject({
            _tag: "SongRewardOfferRejected",
            reason: "not-found",
          });
          expect(await actorFacts(f, prepared.offerId)).toEqual(before);
          expect(f.providerCalls()).toBe(0);
          expect(f.putCalls()).toBe(0);
        } catch (error) {
          failed = true;
          primary = error;
        } finally {
          if (active)
            try {
              await mutation.query("ROLLBACK");
            } catch (error) {
              cleanup.push(error);
            }
          if (operation !== undefined)
            try {
              await bounded(operation, "original waiter unconditional drain", 5000);
            } catch (error) {
              cleanup.push(error);
            }
          try {
            await bounded(mutation.end(), "owned actor peer close", 2000);
          } catch (error) {
            cleanup.push(error);
          }
        }
        if (failed || cleanup.length)
          throw new AggregateError(
            [...(failed ? [primary] : []), ...cleanup],
            "Actor wait case failed or owned drain incomplete",
          );
      });
    }
  },
  60000,
);

pgTest(
  "same original key retains leg/action/policy after append and offer closure; NEW still refuses",
  async () => {
    await creatorFixture(async (f) => {
      const prepared = await prepareCreatorSource(f, "original-policy");
      const made = await withClock(prepared.service.addMegapotPoolLeg(prepared.legInput));
      expect(made.replayed).toBe(false);
      const before = (
        await f.admin.query(
          "SELECT to_jsonb(leg) AS leg,to_jsonb(action) AS action FROM song_reward_offer_legs leg JOIN song_reward_offer_actions action ON action.leg_id=leg.leg_id WHERE leg.leg_id=$1 AND action.endpoint_template=$2",
          [made.leg.legId, endpoint],
        )
      ).rows;
      const changed = await withClock(
        makeControlPlaneSongOwnerPolicyStore(f.ordinaryRuntime).update({
          accountId: actor,
          communityId: "study-community",
          postId: "study-post",
          update: {
            persona_id: prepared.personaId,
            expected_policy_revision: 1,
            third_party_reward_legs: "owner_only",
            pool_leg: "declined",
            derivative_video: "blocked",
          },
        }),
      );
      expect(changed.policy_revision).toBe(2);
      // This is an owned actual lifecycle/status transition. It writes no new leg,
      // action, drawing, salt, qualification, share, allocation, credit or funding fact.
      await f.admin.query(
        "UPDATE song_reward_offers SET status='ended',updated_at=clock_timestamp() WHERE offer_id=$1",
        [prepared.offerId],
      );
      const replay = await withClock(prepared.service.addMegapotPoolLeg(prepared.legInput));
      expect(replay.replayed).toBe(true);
      expect(replay.leg).toEqual(made.leg);
      expect(
        (
          await f.admin.query(
            "SELECT to_jsonb(leg) AS leg,to_jsonb(action) AS action FROM song_reward_offer_legs leg JOIN song_reward_offer_actions action ON action.leg_id=leg.leg_id WHERE leg.leg_id=$1 AND action.endpoint_template=$2",
            [made.leg.legId, endpoint],
          )
        ).rows,
      ).toEqual(before);
      await expect(
        withClock(
          prepared.service.addMegapotPoolLeg({
            ...prepared.legInput,
            idempotencyKey: "foreign-new-after-close",
          }),
        ),
      ).rejects.toMatchObject({
        _tag: "SongRewardOfferRejected",
        reason: "not-found",
      });
      await expect(
        withClock(
          prepared.service.addMegapotPoolLeg({
            ...prepared.legInput,
            minScoreBps: 7001,
          }),
        ),
      ).rejects.toMatchObject({
        _tag: "SongRewardOfferRejected",
        reason: "idempotency-conflict",
      });
      expect(f.providerCalls()).toBe(0);
      expect(f.putCalls()).toBe(0);
    });
  },
  60000,
);
