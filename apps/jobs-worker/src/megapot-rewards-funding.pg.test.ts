import { expect, test } from "bun:test";
import { makeControlPlaneMegapotWorkStore } from "@pirate/platform-cf/megapot-work-repository";
import { makeDirectPostgresControlPlaneLayer } from "@pirate/platform-cf/postgres";
import { Effect } from "effect";
import { withReusablePostgresTestSchema } from "../../../scripts/postgres-test-baseline.ts";
import { type MegapotRewardsRuntime, runMegapotRewardsCycle } from "./megapot-rewards-cycle.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw new Error("Postgres required");
const pgTest = url ? test : test.skip;

const idle = () => Effect.succeed({ kind: "complete" });
const hashOf = (index: number) => `0x${index.toString(16).padStart(2, "0").repeat(32)}`;
const idOf = (index: number) => `funding-fair-${index.toString().padStart(2, "0")}`;

// The real selector and the real cycle together: what matters is which transfers
// are actually observed when the time budget ends every batch after two of them.
for (const total of [10, 11, 20])
  pgTest(
    `every one of ${total} unresolved transfers is observed in turn under the time budget`,
    async () => {
      if (!url) throw new Error("Postgres required");
      await withReusablePostgresTestSchema({
        baseConnectionString: url,
        schemaName: "megapot_rewards_funding_fairness",
        use: async ({ admin, connectionString }) => {
          // Only the funding rows matter here, so their parents are not seeded.
          await admin.query("SET session_replication_role = replica");
          try {
            await admin.query("DELETE FROM song_reward_leg_funding_effects");
            for (let index = 1; index <= total; index++) {
              await admin.query(
                `INSERT INTO song_reward_leg_funding_effects (
                   funding_effect_id, leg_id, funder_account_id, chain_id, token_address,
                   sender_address, recipient_address, expected_amount_atomic,
                   required_confirmations, state, transaction_hash, created_at, updated_at
                 ) VALUES ($1,'leg-fair','account-fair',84532,$2,$3,$4,500,3,'confirming',$5,
                   clock_timestamp()-make_interval(mins => $6::int),
                   clock_timestamp()-make_interval(mins => $6::int))`,
                [
                  idOf(index),
                  `0x${"1".repeat(40)}`,
                  `0x${"b".repeat(40)}`,
                  `0x${"4".repeat(40)}`,
                  hashOf(index),
                  200 - index,
                ],
              );
            }
          } finally {
            await admin.query("SET session_replication_role = origin");
          }
          const ages = async () =>
            (
              await admin.query(
                "SELECT funding_effect_id, updated_at::text FROM song_reward_leg_funding_effects ORDER BY 1",
              )
            ).rows;
          const before = await ages();
          const store = makeControlPlaneMegapotWorkStore(
            makeDirectPostgresControlPlaneLayer(connectionString),
          );
          let clock = 0;
          const observed: string[][] = [];
          const runtime: MegapotRewardsRuntime = {
            reconcile: idle,
            // Each observation spends six seconds and resolves nothing.
            reconcileFunding: (fundingEffectId) =>
              Effect.sync(() => {
                observed.at(-1)?.push(fundingEffectId);
                clock += 6_000;
                return { kind: "confirming" };
              }),
            observeDrawing: () => Effect.succeed(false),
            observeSolvency: idle,
            freezeDue: () => Effect.succeed([]),
            publishCommitment: idle,
            approve: idle,
            closeUnavailablePurchase: idle,
            purchase: idle,
            sweep: idle,
            claim: idle,
            allocate: idle,
            closeExpiredOffers: () => Effect.succeed([]),
            refund: idle,
            payout: idle,
          };
          const firstMinute = 29_000_000;
          for (let cycle = 0; cycle < 2 * total; cycle++) {
            clock = (firstMinute + cycle) * 60_000;
            observed.push([]);
            const summary = await Effect.runPromise(
              runMegapotRewardsCycle({
                work: {
                  loadChainEffects: () => Effect.succeed([]),
                  loadDrawings: () => Effect.succeed([]),
                  loadRefunds: () => Effect.succeed([]),
                  loadCredits: () => Effect.succeed([]),
                  loadAgedPending: () => Effect.succeed([]),
                  loadPendingFunding: store.loadPendingFunding,
                },
                runtime,
                now: () => clock,
              }),
            );
            expect(summary.failures).toEqual([]);
            // Ten seconds of budget at six seconds each: two observed, the rest deferred.
            expect(summary).toMatchObject({
              fundingObserved: 2,
              fundingDeferred: Math.min(total, 10) - 2,
            });
          }
          const all = Array.from({ length: total }, (_, index) => idOf(index + 1));
          // Any run of `total` consecutive cycles reaches every transfer.
          for (let start = 0; start <= total; start++) {
            const seen = new Set(observed.slice(start, start + total).flat());
            expect([...seen].sort()).toEqual(all);
          }
          // No transfer is observed much more often than another.
          const counts = all.map((id) => observed.flat().filter((seen) => seen === id).length);
          expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
          // Rotation wrote nothing: pending age still measures the wait.
          expect(await ages()).toEqual(before);
        },
      });
    },
    60_000,
  );
