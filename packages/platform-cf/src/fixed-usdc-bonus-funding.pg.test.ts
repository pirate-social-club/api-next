import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Effect, Layer } from "effect";
import { Client } from "pg";
import { createReusablePostgresTestSchemaOwner } from "../../../scripts/postgres-test-baseline.ts";
import {
  ControlPlaneDb,
  ControlPlaneTransactionOutcomeUnknown,
} from "../../application/src/ports.ts";
import {
  prepareFixedUsdcBonusBudget,
  prepareFixedUsdcBonusCustody,
  prepareFixedUsdcBonusObservation,
} from "../../application/src/rewards/fixed-usdc-bonus-funding.ts";
import {
  type FixedUsdcBonusFundingFixture,
  waitForFixedUsdcBonusBlock as waitForBlock,
  withFixedUsdcBonusActualUpgrade as withActualUpgrade,
  withFixedUsdcBonusFixture,
} from "./fixed-usdc-bonus-funding.pg-fixture.ts";
import { makeFixedUsdcBonusFundingStore } from "./fixed-usdc-bonus-funding-repository.ts";
import { crossDeadline, runBlockedQuery } from "./moderated-dance-authority.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && url === undefined)
  throw new Error("Isolated native Postgres target required");
const suite = url === undefined ? describe.skip : describe;
setDefaultTimeout(30000);
const reusableSchema = createReusablePostgresTestSchemaOwner();
afterAll(async () => {
  await reusableSchema.dispose();
});
const withFixture = (
  use: (f: FixedUsdcBonusFundingFixture) => Promise<void>,
  maximumAgeMs?: number,
) => withFixedUsdcBonusFixture(reusableSchema, use, maximumAgeMs);
const quote = (v: string) => `"${v.replaceAll('"', '""')}"`;
const allocate = async (f: FixedUsdcBonusFundingFixture, command = f.command) =>
  Effect.runPromise(
    f.store.allocateBudget(await Effect.runPromise(prepareFixedUsdcBonusBudget(command))),
  );
const observe = async (f: FixedUsdcBonusFundingFixture, overrides: Partial<typeof f.observation>) =>
  Effect.runPromise(
    f.store.observe(
      await Effect.runPromise(prepareFixedUsdcBonusObservation({ ...f.observation, ...overrides })),
    ),
  );

suite("independent fixed native-USDC Safe funding", () => {
  test("canonical application/SQL hashes and durable exact receipts agree without lottery admission", async () =>
    withFixture(async (f) => {
      const admitted = await f.ready();
      const policy = await Effect.runPromise(prepareFixedUsdcBonusCustody(f.policy));
      expect(await Effect.runPromise(f.store.admitCustody(policy))).toEqual(admitted);
      const receipt = await allocate(f, { ...f.command, starts_at_ms: Date.now() - 10000 });
      expect(receipt.total_atomic).toBe("4000000");
      expect(receipt.maximum_accounts).toBe(2);
      expect(receipt.participation_starts_at_ms).toBeGreaterThanOrEqual(receipt.funded_at_ms);
      expect(
        (await f.db.query("SELECT count(*)::int n FROM fixed_usdc_bonus_budgets_v1")).rows[0]?.n,
      ).toBe(1);
      const foreignTables = (
        await f.db.query(
          "SELECT confrelid::regclass::text AS target FROM pg_constraint WHERE conrelid='fixed_usdc_bonus_budgets_v1'::regclass AND contype='f'",
        )
      ).rows.map((r) => r.target);
      expect(foreignTables).toEqual(
        expect.arrayContaining(["fixed_usdc_bonus_custodies_v1", "posts"]),
      );
      expect(foreignTables.some((v) => /megapot|attestation/u.test(v))).toBe(false);
    }));
  test("concurrent song budgets cannot reserve the same funded capacity twice", async () =>
    withFixture(async (f) => {
      await f.ready();
      const commands = ["first", "second"].map((id) => ({
        ...f.command,
        idempotency_key: id,
        budget_id: id,
        amount_per_account_atomic: "3000000",
      }));
      const results = await Promise.allSettled(commands.map((c) => allocate(f, c)));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.find((r) => r.status === "rejected")).toMatchObject({
        reason: { reason: "capacity" },
      });
      expect(
        (
          await f.db.query(
            "SELECT count(*)::int n,sum(total_atomic)::text total FROM fixed_usdc_bonus_budgets_v1",
          )
        ).rows,
      ).toEqual([{ n: 1, total: "6000000" }]);
    }));
  test("a committed command with an injected lost acknowledgement recovers only its original budget", async () =>
    withFixture(async (f) => {
      await f.ready();
      const lossy = Layer.effect(
        ControlPlaneDb,
        Effect.gen(function* () {
          const real = yield* ControlPlaneDb;
          return ControlPlaneDb.of({
            ...real,
            withTransaction: (use) => {
              const committed = real.withTransaction(use);
              return committed.pipe(
                Effect.flatMap(() =>
                  Effect.fail(
                    new ControlPlaneTransactionOutcomeUnknown({
                      phase: "commit",
                      label: "test-lost-ack",
                      limitMs: 1,
                      elapsedMs: 1,
                    }),
                  ),
                ),
              );
            },
          });
        }),
      ).pipe(Layer.provide(f.layer));
      const packet = await Effect.runPromise(prepareFixedUsdcBonusBudget(f.command));
      await expect(
        Effect.runPromise(makeFixedUsdcBonusFundingStore(lossy).allocateBudget(packet)),
      ).rejects.toMatchObject({ reason: "outcome-unknown" });
      const committed = (await f.db.query("SELECT receipt FROM fixed_usdc_bonus_budgets_v1"))
        .rows[0]?.receipt;
      expect(await Effect.runPromise(f.store.allocateBudget(packet))).toEqual(committed);
      expect(
        (await f.db.query("SELECT count(*)::int n FROM fixed_usdc_bonus_budgets_v1")).rows[0]?.n,
      ).toBe(1);
      await expect(allocate(f, { ...f.command, maximum_accounts: 3 })).rejects.toMatchObject({
        reason: "idempotency-conflict",
      });
    }));
  test("a Safe cannot be admitted under another custody ID to multiply its opening cap", async () =>
    withFixture(async (f) => {
      await f.ready();
      await expect(
        Effect.runPromise(
          f.store.admitCustody(
            await Effect.runPromise(
              prepareFixedUsdcBonusCustody({ ...f.policy, custody_id: "another-custody" }),
            ),
          ),
        ),
      ).rejects.toMatchObject({ reason: "idempotency-conflict" });
      await expect(
        Effect.runPromise(
          f.store.admitCustody(
            await Effect.runPromise(
              prepareFixedUsdcBonusCustody({ ...f.policy, funded_cap_atomic: "20000000" }),
            ),
          ),
        ),
      ).rejects.toMatchObject({ reason: "idempotency-conflict" });
      expect(
        (await f.db.query("SELECT count(*)::int n FROM fixed_usdc_bonus_custodies_v1")).rows[0]?.n,
      ).toBe(1);
    }));
  test("competing Safe bindings for one custody ID produce one exact winner and one conflict", async () =>
    withFixture(async (f) => {
      const policies = [f.policy, { ...f.policy, safe_address: `0x${"2".repeat(40)}` }];
      const results = await Promise.allSettled(
        policies.map(async (p) => {
          const packet = await Effect.runPromise(prepareFixedUsdcBonusCustody(p));
          return Effect.runPromise(f.store.admitCustody(packet));
        }),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.find((r) => r.status === "rejected")).toMatchObject({
        reason: { reason: "idempotency-conflict" },
      });
      expect(
        (await f.db.query("SELECT count(*)::int n FROM fixed_usdc_bonus_custodies_v1")).rows[0]?.n,
      ).toBe(1);
    }));
  test("new balance observations do not create new funding; a deficit closes fresh allocations while original receipts survive", async () =>
    withFixture(async (f) => {
      await f.ready();
      const first = await allocate(f);
      const deficit = await observe(f, {
        observation_id: "deficit",
        block_number: "102",
        head_block_number: "103",
        observed_at_ms: Date.now(),
        balance_atomic: "0",
      });
      expect(deficit.solvent).toBe(false);
      expect(await allocate(f)).toEqual(first);
      // A positive historical receipt is not current readiness.
      expect((await observe(f, {})).solvent).toBe(true);
      await expect(
        allocate(f, { ...f.command, idempotency_key: "blocked", budget_id: "blocked" }),
      ).rejects.toMatchObject({ reason: "custody-unavailable" });
      await observe(f, {
        observation_id: "restored",
        block_number: "104",
        head_block_number: "105",
        observed_at_ms: Date.now(),
        balance_atomic: "100000000",
      });
      await allocate(f, {
        ...f.command,
        idempotency_key: "remaining",
        budget_id: "remaining",
        amount_per_account_atomic: "3000000",
      });
      await expect(
        allocate(f, {
          ...f.command,
          idempotency_key: "extra",
          budget_id: "extra",
          amount_per_account_atomic: "1",
        }),
      ).rejects.toMatchObject({ reason: "capacity" });
    }));
  test("a conflicting block hash durably latches a hold instead of leaving positive readiness behind", async () =>
    withFixture(async (f) => {
      await f.ready();
      expect(
        (
          await observe(f, {
            observation_id: "changed-block",
            block_hash: `0x${"d".repeat(64)}`,
            observed_at_ms: Date.now(),
          })
        ).solvent,
      ).toBe(false);
      expect(
        (await f.db.query("SELECT held FROM fixed_usdc_bonus_custodies_v1")).rows[0]?.held,
      ).toBe(true);
      expect(
        (
          await observe(f, {
            observation_id: "later",
            block_number: "102",
            head_block_number: "103",
            observed_at_ms: Date.now(),
          })
        ).solvent,
      ).toBe(false);
      await expect(allocate(f)).rejects.toMatchObject({ reason: "custody-unavailable" });
      await expect(
        f.db.query("UPDATE fixed_usdc_bonus_custodies_v1 SET held=FALSE"),
      ).rejects.toMatchObject({ code: "FUB01" });
    }));
  test("allocation checks observation expiry after a real custody-row lock wait", async () =>
    withFixture(async (f) => {
      await f.ready();
      const packet = await Effect.runPromise(prepareFixedUsdcBonusBudget(f.command));
      const result = await runBlockedQuery(
        f.connection,
        f.db,
        {
          text: "SELECT custody_id FROM fixed_usdc_bonus_custodies_v1 WHERE custody_id=$1 FOR UPDATE",
          values: [f.policy.custody_id],
        },
        {
          text: "SELECT allocate_fixed_usdc_bonus_budget_v1($1::jsonb,$2)",
          values: [JSON.stringify(packet.command), packet.requestHash],
        },
        () =>
          crossDeadline(
            f.db,
            new Date(f.observation.observed_at_ms + f.policy.maximum_observation_age_ms + 1),
          ),
      );
      expect(result).toMatchObject({ error: { code: "FUB03" } });
      expect(
        (await f.db.query("SELECT count(*)::int n FROM fixed_usdc_bonus_budgets_v1")).rows[0]?.n,
      ).toBe(0);
    }, 500));
  test("a wait on the actual song row cannot bypass the solvency deadline", async () =>
    withFixture(async (f) => {
      await f.ready();
      const packet = await Effect.runPromise(prepareFixedUsdcBonusBudget(f.command));
      const result = await runBlockedQuery(
        f.connection,
        f.db,
        {
          text: "SELECT post_id FROM posts WHERE community_id=$1 AND post_id=$2 FOR UPDATE",
          values: [f.command.community_id, f.command.song_post_id],
        },
        {
          text: "SELECT allocate_fixed_usdc_bonus_budget_v1($1::jsonb,$2)",
          values: [JSON.stringify(packet.command), packet.requestHash],
        },
        () =>
          crossDeadline(
            f.db,
            new Date(f.observation.observed_at_ms + f.policy.maximum_observation_age_ms + 1),
          ),
      );
      expect(result).toMatchObject({ error: { code: "FUB03" } });
      expect(
        (await f.db.query("SELECT count(*)::int n FROM fixed_usdc_bonus_budgets_v1")).rows[0]?.n,
      ).toBe(0);
    }, 500));
  test("a song hidden while allocation waits cannot gain a new budget", async () =>
    withFixture(async (f) => {
      await f.ready();
      const packet = await Effect.runPromise(prepareFixedUsdcBonusBudget(f.command)),
        second = new Client({ connectionString: f.connection });
      await second.connect();
      let pending: Promise<{ result: unknown } | { error: unknown }> | undefined,
        open = false;
      try {
        const pid = (await second.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
        await f.db.query("BEGIN");
        open = true;
        await f.db.query("UPDATE posts SET status='hidden' WHERE community_id=$1 AND post_id=$2", [
          f.command.community_id,
          f.command.song_post_id,
        ]);
        pending = second
          .query("SELECT allocate_fixed_usdc_bonus_budget_v1($1::jsonb,$2)", [
            JSON.stringify(packet.command),
            packet.requestHash,
          ])
          .then(
            (result) => ({ result }),
            (error) => ({ error }),
          );
        await waitForBlock(f.db, pid);
        await f.db.query("COMMIT");
        open = false;
        expect(await pending).toMatchObject({ error: { code: "FUB04" } });
      } finally {
        if (open) await f.db.query("ROLLBACK");
        await pending;
        await second.end();
      }
      expect(
        (await f.db.query("SELECT count(*)::int n FROM fixed_usdc_bonus_budgets_v1")).rows[0]?.n,
      ).toBe(0);
    }));
  test("big atomic budgets stay exact in PostgreSQL and the finite budget count also binds", async () =>
    withFixture(async (f) => {
      const maximum = ((1n << 256n) - 1n).toString();
      await Effect.runPromise(
        f.store.admitCustody(
          await Effect.runPromise(
            prepareFixedUsdcBonusCustody({
              ...f.policy,
              funded_cap_atomic: maximum,
              maximum_budget_count: 1,
            }),
          ),
        ),
      );
      await observe(f, { balance_atomic: maximum });
      const receipt = await allocate(f, {
        ...f.command,
        amount_per_account_atomic: "9007199254740993",
        maximum_accounts: 3,
      });
      expect(receipt.total_atomic).toBe("27021597764222979");
      await expect(
        allocate(f, {
          ...f.command,
          idempotency_key: "second",
          budget_id: "second",
          amount_per_account_atomic: "1",
          maximum_accounts: 1,
        }),
      ).rejects.toMatchObject({ reason: "capacity" });
    }));
  test("expiry stops new allocations without destroying original command recovery", async () =>
    withFixture(async (f) => {
      const until = Date.now() + 2000,
        policy = { ...f.policy, valid_until_ms: until };
      const admitted = await Effect.runPromise(
        f.store.admitCustody(await Effect.runPromise(prepareFixedUsdcBonusCustody(policy))),
      );
      await observe(f, {});
      const command = { ...f.command, starts_at_ms: Date.now(), ends_at_ms: until };
      const receipt = await allocate(f, command);
      await crossDeadline(f.db, new Date(until));
      expect(await allocate(f, command)).toEqual(receipt);
      expect(
        await Effect.runPromise(
          f.store.admitCustody(await Effect.runPromise(prepareFixedUsdcBonusCustody(policy))),
        ),
      ).toEqual(admitted);
      await expect(
        allocate(f, { ...command, idempotency_key: "expired", budget_id: "expired" }),
      ).rejects.toMatchObject({ reason: "custody-unavailable" });
    }));
  test("new observations reject wrong binding, missing confirmations, regression and future clocks", async () =>
    withFixture(async (f) => {
      await f.ready();
      for (const change of [
        { safe_binding_hash: "f".repeat(64) },
        { head_block_number: "100" },
        { block_number: "99" },
        { observed_at_ms: Date.now() + 60000 },
      ]) {
        await expect(observe(f, { observation_id: "refused", ...change })).rejects.toMatchObject({
          reason: "custody-unavailable",
        });
      }
      expect(
        (await f.db.query("SELECT count(*)::int n FROM fixed_usdc_bonus_observations_v1")).rows[0]
          ?.n,
      ).toBe(1);
    }));
  test("exact public song/audio identity and immutable history remain required", async () =>
    withFixture(async (f) => {
      await f.ready();
      for (const change of [{ community_id: "wrong-community" }, { audio_revision: 2 }])
        await expect(allocate(f, { ...f.command, ...change })).rejects.toMatchObject({
          reason: "song-unavailable",
        });
      const first = await allocate(f);
      await f.db.query("UPDATE posts SET status='hidden' WHERE post_id=$1", [
        f.command.song_post_id,
      ]);
      expect(await allocate(f)).toEqual(first);
      await expect(
        allocate(f, { ...f.command, idempotency_key: "hidden", budget_id: "hidden" }),
      ).rejects.toMatchObject({ reason: "song-unavailable" });
      for (const table of ["fixed_usdc_bonus_budgets_v1", "fixed_usdc_bonus_observations_v1"])
        await expect(f.db.query(`DELETE FROM ${table}`)).rejects.toMatchObject({ code: "FUB01" });
    }));
  test("hash/shape checks apply inside the database and do not trust a typed caller", async () =>
    withFixture(async (f) => {
      const packet = await Effect.runPromise(prepareFixedUsdcBonusCustody(f.policy));
      for (const [document, digest] of [
        [packet.policy, "0".repeat(64)],
        [{ ...packet.policy, extra: true }, packet.policyHash],
        [{ ...packet.policy, chain_id: 84532 }, packet.policyHash],
      ]) {
        await expect(
          f.db.query("SELECT admit_fixed_usdc_bonus_custody_v1($1::jsonb,$2)", [
            JSON.stringify(document),
            digest,
          ]),
        ).rejects.toMatchObject({ code: "FUB00" });
      }
      expect(
        (await f.db.query("SELECT count(*)::int n FROM fixed_usdc_bonus_custodies_v1")).rows[0]?.n,
      ).toBe(0);
    }));
  test("confined SCRAM LOGIN needs exact function grants and cannot inspect or mutate the ledger tables", async () =>
    withActualUpgrade(async (f) => {
      const role = `fixed_bonus_operator_${crypto.randomUUID().replaceAll("-", "")}`,
        password = crypto.randomUUID().replaceAll("-", "");
      const connection = new URL(f.connection);
      connection.username = role;
      connection.password = password;
      const operator = new Client({ connectionString: connection.toString() });
      await f.db.query(`CREATE ROLE ${quote(role)} LOGIN PASSWORD '${password}'`);
      await f.db.query(`GRANT USAGE ON SCHEMA ${quote(f.schema)} TO ${quote(role)}`);
      try {
        await operator.connect();
        const packet = await Effect.runPromise(prepareFixedUsdcBonusCustody(f.policy));
        await expect(
          operator.query("SELECT admit_fixed_usdc_bonus_custody_v1($1::jsonb,$2)", [
            JSON.stringify(packet.policy),
            packet.policyHash,
          ]),
        ).rejects.toMatchObject({ code: "42501" });
        await f.db.query(
          `GRANT EXECUTE ON FUNCTION ${quote(f.schema)}.admit_fixed_usdc_bonus_custody_v1(jsonb,text),${quote(f.schema)}.observe_fixed_usdc_bonus_solvency_v1(jsonb,text),${quote(f.schema)}.allocate_fixed_usdc_bonus_budget_v1(jsonb,text) TO ${quote(role)}`,
        );
        const store = makeFixedUsdcBonusFundingStore(
          makeDirectPostgresControlPlaneLayer(connection.toString()),
        );
        await Effect.runPromise(store.admitCustody(packet));
        await Effect.runPromise(
          store.observe(await Effect.runPromise(prepareFixedUsdcBonusObservation(f.observation))),
        );
        expect(
          (
            await Effect.runPromise(
              store.allocateBudget(await Effect.runPromise(prepareFixedUsdcBonusBudget(f.command))),
            )
          ).total_atomic,
        ).toBe("4000000");
        for (const table of [
          "fixed_usdc_bonus_custodies_v1",
          "fixed_usdc_bonus_observations_v1",
          "fixed_usdc_bonus_budgets_v1",
        ]) {
          await expect(operator.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({
            code: "42501",
          });
          await expect(operator.query(`DELETE FROM ${table}`)).rejects.toMatchObject({
            code: "42501",
          });
        }
      } finally {
        await operator.end();
        await f.db.query(`DROP OWNED BY ${quote(role)}`);
        await f.db.query(`DROP ROLE ${quote(role)}`);
      }
    }));
});
