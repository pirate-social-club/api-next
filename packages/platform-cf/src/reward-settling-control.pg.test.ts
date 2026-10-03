import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeRewardOperationsRunningReader } from "./reward-operations-control.ts";
import {
  insertAdmissionEffect,
  insertAdmissionNonce,
  withSettlingAdmissionFixture,
} from "./reward-settling-control.pg-fixture.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw Error("CONTROL_PLANE_POSTGRES_TEST_URL required");
const suite = url ? describe : describe.skip;
const address = (byte: string) => `0x${byte.repeat(40)}`;

suite("settling admission migration", () => {
  test("derives state from historic running and paused evidence without changing its revisions", async () => {
    if (!url) throw Error("test URL required");
    await withSettlingAdmissionFixture(
      url,
      async ({ writer }) => {
        expect(
          (
            await writer.query(
              "SELECT revision::text,state,paused,reason FROM reward_operations_control_events ORDER BY revision",
            )
          ).rows,
        ).toEqual([
          { revision: "0", state: "paused", paused: true, reason: "environment_initially_paused" },
          { revision: "1", state: "running", paused: false, reason: "historic_running" },
          { revision: "2", state: "paused", paused: true, reason: "historic_pause" },
        ]);
      },
      { seedHistory: true },
    );
  });

  test("keeps default pause, revision/audit guards and restricted operator authority", async () => {
    if (!url) throw Error("test URL required");
    await withSettlingAdmissionFixture(
      url,
      async ({ admin, writer, operator, runtimeRole, schema }) => {
        expect(
          (await writer.query("SELECT state,paused,revision::text FROM reward_operations_control"))
            .rows,
        ).toEqual([{ state: "paused", paused: true, revision: "0" }]);
        for (const sql of [
          "SELECT set_reward_operations_state_v2(0,'settling','tamper')",
          "SELECT set_reward_operations_paused_v1(0,FALSE,'tamper')",
          "UPDATE reward_operations_control SET state='running',paused=FALSE",
          "DELETE FROM reward_operations_control",
          "TRUNCATE reward_operations_control_events",
          "SELECT reward_effect_is_settlement_v2('fake')",
          "SELECT guard_reward_replacement_preparation_v2()",
        ])
          await expect(writer.query(sql)).rejects.toMatchObject({ code: "42501" });
        for (const sql of [
          "SELECT set_reward_operations_state_v2(0,'unknown','incident')",
          "SELECT set_reward_operations_state_v2(NULL,'settling','incident')",
          "SELECT set_reward_operations_state_v2(1,'settling','stale')",
          "SELECT set_reward_operations_state_v2(0,'settling',' ')",
        ])
          await expect(operator.query(sql)).rejects.toMatchObject({ code: "PR002" });
        await operator.query("SELECT set_reward_operations_state_v2(0,'settling','incident')");
        await operator.query("SELECT set_reward_operations_state_v2(1,'settling','idempotent')");
        expect(
          (
            await writer.query(
              "SELECT state,paused,revision::text,reason FROM reward_operations_control",
            )
          ).rows,
        ).toEqual([{ state: "settling", paused: true, revision: "1", reason: "incident" }]);
        await operator.query("SELECT set_reward_operations_paused_v1(1,TRUE,'stop_settlement')");
        expect(
          (
            await writer.query(
              "SELECT revision::text,state,paused FROM reward_operations_control_events ORDER BY revision",
            )
          ).rows,
        ).toEqual([
          { revision: "0", state: "paused", paused: true },
          { revision: "1", state: "settling", paused: true },
          { revision: "2", state: "paused", paused: true },
        ]);
        await expect(
          admin.query("UPDATE reward_operations_control_events SET reason='tamper'"),
        ).rejects.toThrow("append-only");
        expect(
          (
            await admin.query(
              "SELECT has_function_privilege($1,'reward_operations_running_v2()','EXECUTE') AS allowed",
              [runtimeRole],
            )
          ).rows,
        ).toEqual([{ allowed: true }]);
        for (const signature of [
          "set_reward_operations_state_v2(bigint,text,text)",
          "set_reward_operations_paused_v1(bigint,boolean,text)",
          "reward_operations_running_v2()",
          "guard_reward_http_admission()",
          "guard_reward_signer_nonce()",
          "validate_reward_settling_nonce_v2()",
          "guard_reward_replacement_preparation_v2()",
        ])
          expect(
            (
              await admin.query(
                "SELECT prosecdef,proconfig FROM pg_proc WHERE oid=to_regprocedure($1)",
                [signature],
              )
            ).rows,
          ).toEqual([{ prosecdef: true, proconfig: [`search_path=${schema}, pg_temp`] }]);
      },
    );
  });

  test("serializes the transition with admitted work and refuses queued new business", async () => {
    if (!url) throw Error("test URL required");
    await withSettlingAdmissionFixture(url, async ({ admin, writer, operator, later }) => {
      await operator.query("SELECT set_reward_operations_paused_v1(0,FALSE,'start')");
      const pid = (await operator.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      await writer.query("BEGIN");
      await insertAdmissionNonce(writer, address("1"));
      const transition = operator.query(
        "SELECT set_reward_operations_state_v2(1,'settling','incident')",
      );
      let waiting = false;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        waiting =
          (
            await admin.query(
              "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",
              [pid],
            )
          ).rows[0]?.waiting === true;
        if (waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      const queued = insertAdmissionEffect(
        later,
        "queued-purchase",
        "ticket_purchase",
        address("2"),
      ).then(
        () => null,
        (error) => error,
      );
      await writer.query("COMMIT");
      await transition;
      expect(await queued).toMatchObject({ code: "PR001" });
      expect(
        (await admin.query("SELECT state,revision::text FROM reward_operations_control")).rows,
      ).toEqual([{ state: "settling", revision: "2" }]);
      expect(
        (await admin.query("SELECT count(*)::int AS effects FROM reward_chain_effects")).rows,
      ).toEqual([{ effects: 0 }]);
    });
  });

  test("requires an exact obligation detail at commit and rejects generic nonce or new-business bypass", async () => {
    if (!url) throw Error("test URL required");
    await withSettlingAdmissionFixture(url, async ({ admin, writer, operator }) => {
      await operator.query("SELECT set_reward_operations_paused_v1(0,FALSE,'seed')");
      await writer.query(
        "INSERT INTO song_reward_leg_funding_effects VALUES('old-funding','old-leg','confirmed')",
      );
      await insertAdmissionEffect(writer, "old-unallocated", "reward_payout", address("8"));
      await insertAdmissionEffect(writer, "old-purchase-planned", "ticket_purchase", address("9"));
      await operator.query("SELECT set_reward_operations_state_v2(1,'settling','incident')");
      await expect(
        writer.query(
          "UPDATE reward_chain_effects SET nonce=8,state='nonce_reserved' WHERE effect_id='old-unallocated'",
        ),
      ).rejects.toMatchObject({ code: "PR001" });
      await expect(
        writer.query(
          "UPDATE reward_chain_effects SET nonce=9,state='nonce_reserved' WHERE effect_id='old-purchase-planned'",
        ),
      ).rejects.toMatchObject({ code: "PR001" });
      await expect(insertAdmissionNonce(writer, address("3"))).rejects.toMatchObject({
        code: "PR001",
      });
      for (const kind of [
        "ticket_purchase",
        "usdc_approval",
        "gas_topup",
        "sponsor_withdrawal",
        "unknown",
      ])
        await expect(
          insertAdmissionEffect(writer, `blocked-${kind}`, kind, address("3")),
        ).rejects.toMatchObject({ code: "PR001" });
      await expect(
        insertAdmissionEffect(writer, "fake-refund", "reward_refund", address("3")),
      ).rejects.toMatchObject({ code: "PR001" });
      await writer.query("BEGIN");
      await insertAdmissionNonce(writer, address("3"));
      await insertAdmissionEffect(writer, "old-refund", "reward_refund", address("3"));
      await writer.query(
        "UPDATE reward_chain_effects SET nonce=0,state='nonce_reserved' WHERE effect_id='old-refund'",
      );
      await writer.query(
        "INSERT INTO reward_refund_effects VALUES('old-refund','old-funding','old-leg')",
      );
      await writer.query("COMMIT");
      expect(
        (
          await admin.query(
            "SELECT effect_id,nonce::text FROM reward_chain_effects WHERE nonce IS NOT NULL",
          )
        ).rows,
      ).toEqual([{ effect_id: "old-refund", nonce: "0" }]);
      await writer.query("BEGIN");
      await insertAdmissionNonce(writer, address("4"));
      await insertAdmissionEffect(writer, "missing-detail", "reward_payout", address("4"));
      await writer.query(
        "UPDATE reward_chain_effects SET nonce=0,state='nonce_reserved' WHERE effect_id='missing-detail'",
      );
      await expect(writer.query("COMMIT")).rejects.toMatchObject({ code: "PR001" });
      await writer.query("ROLLBACK");
      expect(
        (await admin.query("SELECT count(*)::int AS effects FROM reward_chain_effects")).rows,
      ).toEqual([{ effects: 3 }]);
      await operator.query("SELECT set_reward_operations_paused_v1(2,TRUE,'stop')");
      // Existing admitted effect updates and nonce bookkeeping still proceed.
      await writer.query(
        "UPDATE reward_chain_effects SET state='reconciliation_required' WHERE effect_id='old-refund'",
      );
      await writer.query(
        "UPDATE reward_signer_nonces SET observed_pending_nonce=1,observed_block_number=2,fence_version=fence_version+1,observed_at=clock_timestamp(),updated_at=clock_timestamp()",
      );
      await expect(insertAdmissionNonce(writer, address("5"))).rejects.toMatchObject({
        code: "PR001",
      });
    });
  });

  test("permits nonce catch-up for an existing guarded obligation without admitting new business", async () => {
    if (!url) throw Error("test URL required");
    await withSettlingAdmissionFixture(url, async ({ writer, operator }) => {
      await operator.query("SELECT set_reward_operations_paused_v1(0,FALSE,'seed_catchup')");
      await insertAdmissionNonce(writer, address("d"));
      await writer.query(
        "INSERT INTO song_reward_leg_funding_effects VALUES('known-funding','known-leg','confirmed')",
      );
      await insertAdmissionEffect(writer, "known-refund", "reward_refund", address("d"));
      await writer.query(
        "UPDATE reward_chain_effects SET nonce=1,state='nonce_reserved' WHERE effect_id='known-refund'",
      );
      await writer.query(
        "INSERT INTO reward_refund_effects VALUES('known-refund','known-funding','known-leg')",
      );
      await operator.query("SELECT set_reward_operations_state_v2(1,'settling','catchup')");
      await writer.query(
        "UPDATE reward_signer_nonces SET next_nonce=2,observed_pending_nonce=2,fence_version=fence_version+1,updated_at=clock_timestamp()",
      );
      expect(
        (await writer.query("SELECT next_nonce::text FROM reward_signer_nonces")).rows,
      ).toEqual([{ next_nonce: "2" }]);
      await expect(
        insertAdmissionEffect(writer, "new-purchase", "ticket_purchase", address("d")),
      ).rejects.toMatchObject({ code: "PR001" });
      expect(
        (await writer.query("SELECT count(*)::int AS effects FROM reward_chain_effects")).rows,
      ).toEqual([{ effects: 1 }]);
    });
  });

  test("retains qualifications while refusing financial entries; unknown and missing controls fail closed", async () => {
    if (!url) throw Error("test URL required");
    await withSettlingAdmissionFixture(url, async ({ admin, writer, operator, schema }) => {
      await operator.query("SELECT set_reward_operations_state_v2(0,'settling','incident')");
      await writer.query("INSERT INTO activity_qualifications VALUES('safe-qualification')");
      expect(
        (await writer.query("SELECT count(*)::int AS count FROM activity_qualifications")).rows,
      ).toEqual([{ count: 1 }]);
      for (const table of [
        "megapot_pool_shares",
        "song_reward_bundle_claims",
        "song_reward_bundle_claim_legs",
        "song_reward_offers",
        "song_reward_offer_legs",
      ])
        await expect(
          writer.query(`INSERT INTO ${table} VALUES('new-business')`),
        ).rejects.toMatchObject({ code: "PR001" });
      await expect(
        writer.query(
          "INSERT INTO song_reward_leg_funding_effects VALUES('new-funding','leg','queued')",
        ),
      ).rejects.toMatchObject({ code: "PR001" });
      await expect(
        writer.query("INSERT INTO reward_ledger_credits VALUES('new-credit','asset_bonus')"),
      ).rejects.toMatchObject({ code: "PR001" });
      expect(
        (await writer.query("SELECT count(*)::int AS count FROM megapot_pool_shares")).rows,
      ).toEqual([{ count: 0 }]);
      const scoped = new URL(url);
      scoped.searchParams.set("options", `-c search_path=${schema}`);
      const readRunning = makeRewardOperationsRunningReader(
        makeDirectPostgresControlPlaneLayer(scoped.toString()),
      );
      expect(await Effect.runPromise(readRunning())).toBe(false);
      await admin.query(
        "ALTER TABLE reward_operations_control DROP CONSTRAINT reward_operations_control_state_shape",
      );
      await admin.query(
        "SET session_replication_role=replica; UPDATE reward_operations_control SET state='unknown'; SET session_replication_role=origin",
      );
      expect(await Effect.runPromise(readRunning())).toBe(false);
      await expect(insertAdmissionNonce(writer, address("6"))).rejects.toMatchObject({
        code: "PR001",
      });
      await expect(
        insertAdmissionEffect(writer, "unknown-refund", "reward_refund", address("6")),
      ).rejects.toMatchObject({ code: "PR001" });
      await admin.query("TRUNCATE reward_operations_control");
      expect(await Effect.runPromise(readRunning())).toBe(false);
      await expect(insertAdmissionNonce(writer, address("7"))).rejects.toMatchObject({
        code: "PR001",
      });
      await expect(
        writer.query("INSERT INTO song_reward_offers VALUES('no-control')"),
      ).rejects.toMatchObject({ code: "PR001" });
    });
  });

  test("only an exact paired replacement can retain its existing nonce under an unavailable control", async () => {
    if (!url) throw Error("test URL required");
    for (const unavailable of ["unknown", "missing"])
      await withSettlingAdmissionFixture(url, async ({ admin, writer, operator }) => {
        await operator.query("SELECT set_reward_operations_paused_v1(0,FALSE,'seed_tail')");
        await insertAdmissionEffect(writer, "old-tail", "ticket_purchase", address("a"));
        await writer.query(
          "UPDATE reward_chain_effects SET nonce=7,state='replaced',replaced_by_effect_id='exact-tail' WHERE effect_id='old-tail'",
        );
        if (unavailable === "missing") await admin.query("TRUNCATE reward_operations_control");
        else {
          await admin.query(
            "ALTER TABLE reward_operations_control DROP CONSTRAINT reward_operations_control_state_shape",
          );
          await admin.query(
            "SET session_replication_role=replica; UPDATE reward_operations_control SET state='unknown'; SET session_replication_role=origin",
          );
        }
        await expect(
          writer.query(
            "INSERT INTO reward_chain_effects(effect_id,effect_kind,state,chain_id,signer_address,replacement_of_effect_id) VALUES('fake-tail','ticket_purchase','planned',84532,$1,'old-tail')",
            [address("a")],
          ),
        ).rejects.toMatchObject({ code: "PR001" });
        await writer.query("BEGIN");
        await writer.query(
          "INSERT INTO reward_chain_effects(effect_id,effect_kind,state,chain_id,signer_address,replacement_of_effect_id) VALUES('exact-tail','ticket_purchase','planned',84532,$1,'old-tail')",
          [address("a")],
        );
        await expect(
          writer.query(
            "UPDATE reward_chain_effects SET nonce=8,state='nonce_reserved' WHERE effect_id='exact-tail'",
          ),
        ).rejects.toMatchObject({ code: "PR001" });
        await writer.query("ROLLBACK");
        await writer.query("BEGIN");
        await writer.query(
          "INSERT INTO reward_chain_effects(effect_id,effect_kind,state,chain_id,signer_address,replacement_of_effect_id) VALUES('exact-tail','ticket_purchase','planned',84532,$1,'old-tail')",
          [address("a")],
        );
        await writer.query(
          "UPDATE reward_chain_effects SET nonce=7,state='nonce_reserved' WHERE effect_id='exact-tail'",
        );
        await writer.query("COMMIT");
        expect(
          (
            await writer.query(
              "SELECT nonce::text FROM reward_chain_effects WHERE effect_id='exact-tail'",
            )
          ).rows,
        ).toEqual([{ nonce: "7" }]);
        const preparation =
          "UPDATE reward_chain_effects SET calldata='0xaabb',calldata_hash='known-hash',signed_transaction='0x0202',signed_transaction_hash='new-signature',state='prepared' WHERE effect_id='exact-tail'";
        // Missing predecessor bytes never authorize synthesis of a new intent.
        await expect(writer.query(preparation)).rejects.toMatchObject({ code: "PR001" });
        await admin.query(
          "UPDATE reward_chain_effects SET calldata='0xaabb',calldata_hash='known-hash',signed_transaction='0x0101',signed_transaction_hash='original-signature' WHERE effect_id='old-tail'",
        );
        await expect(
          writer.query(
            "UPDATE reward_chain_effects SET calldata='0xccdd',calldata_hash='known-hash' WHERE effect_id='exact-tail'",
          ),
        ).rejects.toMatchObject({ code: "PR001" });
        await writer.query(preparation);
        await expect(insertAdmissionNonce(writer, address("b"))).rejects.toMatchObject({
          code: "PR001",
        });
      });
  });
});
