import { afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import { makeRewardOperationsGuard } from "../../../apps/http-worker/src/reward-operations-guard.ts";
import {
  applyPostgresTestBaselineConnection,
  createReusablePostgresTestSchemaOwner,
} from "../../../scripts/postgres-test-baseline.ts";
import { makeDiagnosticPostgresControlPlaneLayer as makeDirectPostgresControlPlaneLayer } from "./postgres-failure-diagnostics.pg-fixture.ts";
import { makeControlPlaneRewardFundingStore } from "./reward-funding-repository.ts";
import { bytes32, hash, seedMegapotAuthority } from "./rewards-composed-pool.pg-fixture.ts";
import { seedActivePoolLeg, seedSong } from "./rewards-song-offers.pg-fixture.ts";
import { makeControlPlaneSongRewardOfferStore } from "./song-reward-offer-repository.ts";

const reusableSchema = createReusablePostgresTestSchemaOwner();

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw Error("Test URL required");
const suite = url ? describe : describe.skip;
const scoped = (schema: string) => {
  if (!url) throw Error("Test URL required");
  const u = new URL(url);
  u.searchParams.set("options", `-c search_path=${schema}`);
  return u.toString();
};
const pause = (client: Client, paused: boolean) =>
  client.query(
    "SELECT set_reward_operations_paused_v1(revision,$1,'http_admission_test') FROM reward_operations_control WHERE singleton",
    [paused],
  );

suite("HTTP database reward admission", () => {
  test("stale running reads cannot create liabilities; previously issued funding still settles", async () => {
    if (!url) throw Error("Test URL required");
    await reusableSchema.run({
      baseConnectionString: url,
      schemaName: "reward_http_admission",
      use: async ({ admin, schema }) => {
        await admin.query(`SET search_path TO "${schema}"`);
        await applyPostgresTestBaselineConnection({
          connectionString: scoped(schema),
          rewardsRunning: true,
        });
        const identity = await seedSong(admin, "http-admission", `0x${"d".repeat(40)}`);
        await seedMegapotAuthority(admin);
        const { legId } = await seedActivePoolLeg(admin, identity, {
          fallback: false,
          suffix: "http-admission",
        });
        const layer = makeDirectPostgresControlPlaneLayer(scoped(schema));
        const funding = makeControlPlaneRewardFundingStore(layer);
        const intent = await Effect.runPromise(
          funding.plan({
            fundingEffectId: "issued-before-pause",
            legId,
            funderAccountId: identity.accountId,
            senderAddress: `0x${"d".repeat(40)}`,
            expectedAmountAtomic: 500n,
            requiredConfirmations: 3,
          }),
        );
        await pause(admin, true);
        // This deliberately models a Hyperdrive reader that never learns about pause.
        const staleGuard = makeRewardOperationsGuard({ readRunning: async () => true });
        await staleGuard();
        const open = {
          actionId: "paused-open-action",
          offerId: "paused-new-offer",
          accountId: identity.accountId,
          personaId: identity.personaId,
          communityId: identity.communityId,
          postId: identity.postId,
          idempotencyKey: "paused-open",
          requestHash: hash("5"),
          termsHash: hash("6"),
          rewardPolicy: {
            version: "scarce_reward_v1",
            community_id: identity.communityId,
            offer_id: "paused-new-offer",
            requirements: ["human.personhood", "credential.subject_unique"],
            uniqueness: { kind: "single_authority", authority_id: "paused-new-offer" },
            legal_eligibility: {
              age: null,
              geography: null,
              disclosure: null,
              environment: "test_staging_empty_v1",
            },
          },
          rewardPolicyHash: hash("a"),
          startsAt: new Date().toISOString(),
          endsAt: new Date(Date.now() + 3600000).toISOString(),
          createdAt: new Date().toISOString(),
        } as const;
        await expect(
          Effect.runPromise(
            Effect.flip(makeControlPlaneSongRewardOfferStore(layer).openOffer(open)),
          ),
        ).resolves.toMatchObject({ _tag: "RewardOperationsPaused", reason: "paused" });
        await expect(
          Effect.runPromise(
            Effect.flip(
              funding.plan({
                fundingEffectId: "paused-new-intent",
                legId,
                funderAccountId: identity.accountId,
                senderAddress: intent.senderAddress,
                expectedAmountAtomic: 500n,
                requiredConfirmations: 3,
              }),
            ),
          ),
        ).resolves.toMatchObject({ _tag: "RewardOperationsPaused", reason: "paused" });
        expect(
          (
            await admin.query(
              "SELECT count(*)::int AS count FROM song_reward_offers WHERE offer_id='paused-new-offer'",
            )
          ).rows,
        ).toEqual([{ count: 0 }]);
        expect(
          (
            await admin.query(
              "SELECT count(*)::int AS count FROM song_reward_offer_actions WHERE action_id='paused-open-action'",
            )
          ).rows,
        ).toEqual([{ count: 0 }]);
        expect(
          (
            await admin.query(
              "SELECT count(*)::int AS count FROM policy_versions WHERE policy->>'offer_id'='paused-new-offer'",
            )
          ).rows,
        ).toEqual([{ count: 0 }]);
        expect(
          (
            await admin.query(
              "SELECT count(*)::int AS count FROM song_reward_leg_funding_effects WHERE funding_effect_id='paused-new-intent'",
            )
          ).rows,
        ).toEqual([{ count: 0 }]);
        // Replays return a previously admitted intent, not a new row or instructions.
        await expect(
          Effect.runPromise(
            funding.plan({
              fundingEffectId: intent.fundingEffectId,
              legId,
              funderAccountId: identity.accountId,
              senderAddress: intent.senderAddress,
              expectedAmountAtomic: 500n,
              requiredConfirmations: 3,
            }),
          ),
        ).resolves.toMatchObject({ fundingEffectId: intent.fundingEffectId });
        const runtime = `reward_http_${process.pid}_${Date.now()}`;
        const writer = new Client({ connectionString: scoped(schema) });
        await writer.connect();
        try {
          await admin.query(
            `CREATE ROLE "${runtime}"; GRANT USAGE ON SCHEMA "${schema}" TO "${runtime}"; GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO "${runtime}"; GRANT UPDATE ON activity_registry TO "${runtime}"; GRANT INSERT,UPDATE ON song_reward_offers,song_reward_offer_legs,song_reward_leg_funding_effects TO "${runtime}"`,
          );
          await writer.query(`SET ROLE "${runtime}"`);
          for (const table of [
            "song_reward_offers",
            "song_reward_offer_legs",
            "song_reward_leg_funding_effects",
          ]) {
            // All column values come from a real valid row; BEFORE admission wins over replay uniqueness.
            await expect(
              writer.query(`INSERT INTO ${table} SELECT * FROM ${table} LIMIT 1`),
            ).rejects.toMatchObject({ code: "PR001" });
          }
          expect(
            (
              await admin.query(
                "SELECT prosecdef,proconfig FROM pg_proc WHERE oid='guard_reward_http_admission()'::regprocedure",
              )
            ).rows,
          ).toEqual([{ prosecdef: true, proconfig: [`search_path=${schema}, pg_temp`] }]);
          // The canonical test baseline intentionally strips ACLs; migration ACLs
          // are asserted below against the actual forward migration.
          const tx = bytes32("3");
          await Effect.runPromise(
            funding.bindTransaction({
              fundingEffectId: intent.fundingEffectId,
              transactionHash: tx,
            }),
          );
          await Effect.runPromise(
            funding.confirm({
              fundingEffectId: intent.fundingEffectId,
              transactionHash: tx,
              transferLogIndex: 9,
              amountAtomic: 500n,
              blockNumber: 130n,
              blockHash: bytes32("4"),
              observationHash: hash("4"),
              confirmedAt: new Date().toISOString(),
            }),
          );
          await expect(
            Effect.runPromise(funding.find(intent.fundingEffectId)),
          ).resolves.toMatchObject({ state: "confirmed", confirmedAmountAtomic: 500n });
          await admin.query("TRUNCATE reward_operations_control");
          await expect(
            writer.query("INSERT INTO song_reward_offers SELECT * FROM song_reward_offers LIMIT 1"),
          ).rejects.toMatchObject({ code: "PR001" });
        } finally {
          await writer.end();
          await admin.query(`DROP OWNED BY "${runtime}"; DROP ROLE "${runtime}"`);
        }
      },
    });
  }, 30000);

  test("pause orders all three creation writers and rolls back partial creation", async () => {
    if (!url) throw Error("Test URL required");
    const schema = `reward_http_order_${process.pid}_${Date.now()}`;
    const admin = new Client({ connectionString: url });
    const creator = new Client({ connectionString: url });
    const pauser = new Client({ connectionString: url });
    const later = new Client({ connectionString: url });
    await Promise.all([admin.connect(), creator.connect(), pauser.connect(), later.connect()]);
    try {
      await admin.query(
        `CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"; CREATE TABLE reward_signer_nonces(chain_id bigint,signer_address text); CREATE FUNCTION guard_reward_signer_nonce() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW;END$$; CREATE TRIGGER reward_signer_nonces_change_guard BEFORE INSERT ON reward_signer_nonces FOR EACH ROW EXECUTE FUNCTION guard_reward_signer_nonce(); CREATE TABLE song_reward_offers(id text PRIMARY KEY); CREATE TABLE song_reward_offer_legs(id text PRIMARY KEY,kind text); CREATE TABLE song_reward_leg_funding_effects(id text PRIMARY KEY,kind text)`,
      );
      await admin.query(
        await Bun.file(
          new URL(
            "../../../db/postgres/migrations/0230_reward_operations_control.sql",
            import.meta.url,
          ),
        ).text(),
      );
      await admin.query(
        await Bun.file(
          new URL(
            "../../../db/postgres/migrations/0231_reward_http_admission.sql",
            import.meta.url,
          ),
        ).text(),
      );
      const runtime = `reward_http_acl_${process.pid}_${Date.now()}`;
      try {
        await admin.query(
          `CREATE ROLE "${runtime}"; GRANT USAGE ON SCHEMA "${schema}" TO "${runtime}"`,
        );
        expect(
          (
            await admin.query(
              "SELECT has_function_privilege($1,'guard_reward_http_admission()','EXECUTE') AS allowed",
              [runtime],
            )
          ).rows,
        ).toEqual([{ allowed: false }]);
        await creator.query(`SET search_path TO "${schema}"; SET ROLE "${runtime}"`);
        await expect(creator.query("SELECT guard_reward_http_admission()")).rejects.toMatchObject({
          code: "42501",
        });
      } finally {
        await creator.query("RESET ROLE");
        await admin.query(`DROP OWNED BY "${runtime}"; DROP ROLE "${runtime}"`);
      }
      for (const c of [creator, pauser, later])
        await c.query(`SET search_path TO "${schema}"; SET statement_timeout=5000`);
      await expect(
        creator.query("INSERT INTO song_reward_offers VALUES('initial')"),
      ).rejects.toMatchObject({ code: "PR001" });
      await pause(admin, false);
      await creator.query("BEGIN");
      await creator.query("INSERT INTO song_reward_offers VALUES('admitted')");
      await creator.query(
        "INSERT INTO song_reward_offer_legs VALUES('admitted-leg','megapot_pool')",
      );
      const creatorPid = (await creator.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const pauserPid = (await pauser.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const laterPid = (await later.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const trace: string[] = [];
      const blockedBy = async (pid: number, blocker: number) => {
        const deadline = Date.now() + 2_000;
        let evidence:
          | {
              pid: number;
              wait_event_type: string | null;
              wait_event: string | null;
              blockers: number[];
              backend_xid: string | null;
            }
          | undefined;
        while (Date.now() < deadline) {
          evidence = (
            await admin.query(
              "SELECT pid,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers,backend_xid::text FROM pg_stat_activity WHERE pid=$1",
              [pid],
            )
          ).rows[0];
          // The lock manager and activity wait fields are sampled separately.
          // Wait for both asserted facts instead of stopping in that brief gap.
          if (evidence?.blockers.includes(blocker) && evidence.wait_event_type === "Lock") break;
          await Bun.sleep(10);
        }
        console.info("reward pause blocker", { evidence, trace: [...trace] });
        expect(evidence?.blockers).toContain(blocker);
        expect(evidence?.wait_event_type).toBe("Lock");
      };
      await pauser.query("BEGIN");
      let pauseSettled = false;
      trace.push("pause statement sent");
      const pauseStatement = pauser
        .query("SELECT set_reward_operations_paused_v1(1,TRUE,'http_admission_test')")
        .then(
          () => {
            pauseSettled = true;
            trace.push("pause statement completed; transaction open");
            return null;
          },
          (error: unknown) => {
            pauseSettled = true;
            trace.push("pause statement failed");
            return error;
          },
        );
      await blockedBy(pauserPid, creatorPid);
      expect(pauseSettled).toBe(false);
      expect(
        (await admin.query("SELECT paused,revision::text FROM reward_operations_control")).rows,
      ).toEqual([{ paused: false, revision: "1" }]);
      await creator.query("COMMIT");
      trace.push("creator commit acknowledged");
      expect(await pauseStatement).toBeNull();
      expect(
        (await pauser.query("SELECT paused,revision::text FROM reward_operations_control")).rows,
      ).toEqual([{ paused: true, revision: "2" }]);
      expect(
        (await admin.query("SELECT paused,revision::text FROM reward_operations_control")).rows,
      ).toEqual([{ paused: false, revision: "1" }]);
      let laterSettled = false;
      trace.push("later reservation sent");
      const queuedReservation = later
        .query("INSERT INTO song_reward_leg_funding_effects VALUES('later','megapot_pool')")
        .then(
          () => {
            laterSettled = true;
            trace.push("later reservation completed");
            return null;
          },
          (error) => {
            laterSettled = true;
            trace.push("later reservation refused");
            return error;
          },
        );
      await blockedBy(laterPid, pauserPid);
      expect(laterSettled).toBe(false);
      trace.push("pause commit sent");
      await pauser.query("COMMIT");
      trace.push("pause commit acknowledged");
      expect(await queuedReservation).toMatchObject({ code: "PR001" });
      console.info("reward pause completion", { trace });
      expect(
        (await admin.query("SELECT paused,revision::text FROM reward_operations_control")).rows,
      ).toEqual([{ paused: true, revision: "2" }]);
      expect((await admin.query("SELECT id FROM song_reward_offers ORDER BY id")).rows).toEqual([
        { id: "admitted" },
      ]);
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM song_reward_leg_funding_effects"))
          .rows,
      ).toEqual([{ count: 0 }]);
      await expect(
        creator.query("INSERT INTO song_reward_offers VALUES('postcommit')"),
      ).rejects.toMatchObject({ code: "PR001" });
      for (const kind of ["megapot_pool", "asset_bonus"]) {
        await expect(
          creator.query("INSERT INTO song_reward_offer_legs VALUES($1,$2)", [kind, kind]),
        ).rejects.toMatchObject({ code: "PR001" });
        await expect(
          creator.query("INSERT INTO song_reward_leg_funding_effects VALUES($1,$2)", [kind, kind]),
        ).rejects.toMatchObject({ code: "PR001" });
      }
      await pause(admin, false);
      await creator.query("BEGIN");
      await creator.query("INSERT INTO song_reward_offers VALUES('rolled-back')");
      await creator.query(
        "INSERT INTO song_reward_offer_legs VALUES('rolled-back-leg','asset_bonus')",
      );
      await creator.query("ROLLBACK");
      expect((await admin.query("SELECT id FROM song_reward_offers ORDER BY id")).rows).toEqual([
        { id: "admitted" },
      ]);
      expect((await admin.query("SELECT id FROM song_reward_offer_legs ORDER BY id")).rows).toEqual(
        [{ id: "admitted-leg" }],
      );
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM song_reward_leg_funding_effects"))
          .rows,
      ).toEqual([{ count: 0 }]);
    } finally {
      await creator.query("ROLLBACK").catch(() => {});
      await pauser.query("ROLLBACK").catch(() => {});
      await Promise.all([creator.end(), pauser.end(), later.end()]);
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  }, 15000);
});

afterAll(async () => {
  await reusableSchema.dispose();
});
