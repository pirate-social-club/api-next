import { afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import {
  applyPostgresTestBaselineConnection,
  createReusablePostgresTestSchemaOwner,
} from "../../../scripts/postgres-test-baseline.ts";
import { seedVeryRewardEvidence } from "./activity-participation-composed-identity.pg-fixture.ts";
import { createActivePersonaFixture } from "./persona-wallet.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { WalletSendVerificationRequired } from "./wallet-send-palm.ts";
import {
  issueWalletSendVerificationIntent,
  makeControlPlaneWalletSendIntentResolver,
} from "./wallet-send-verification-intent.ts";
import { makeControlPlaneSponsoredSendStore } from "./wallet-sponsored-send-repository.ts";
import { makeWalletSponsoredSendService } from "./wallet-sponsored-send-service.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw Error("Test URL required");
const suite = url ? describe : describe.skip;
const reusable = createReusablePostgresTestSchemaOwner();
const address = (byte: string) => `0x${byte.repeat(20)}`;
const hash = (byte: string) => `0x${byte.repeat(32)}`;
const limits = {
  perAccountUtcDay: 20,
  perWalletUtcDay: 20,
  platformUtcDay: 100,
  gasBudgetPerSendWei: 1n,
  accountDailyGasBudgetWei: 20n,
  walletDailyGasBudgetWei: 20n,
  platformDailyGasBudgetWei: 100n,
};

suite("Postgres Send Palm boundary", () => {
  afterAll(() => reusable.dispose());

  async function fixture(
    use: (context: {
      admin: Client;
      connectionString: string;
      layer: ReturnType<typeof makeDirectPostgresControlPlaneLayer>;
      store: ReturnType<typeof makeControlPlaneSponsoredSendStore>;
      request: (accountId: string) => {
        accountId: string;
        personaId: string;
        chainId: 84532;
        tokenAddress: string;
        recipientAddress: string;
        amountAtomic: bigint;
        idempotencyKey: string;
        providerIdempotencyKey: string;
        sendId: string;
        referenceId: string;
      };
    }) => Promise<void>,
  ) {
    if (!url) throw Error("Test URL required");
    await reusable.run({
      baseConnectionString: url,
      schemaName: "wallet_send_palm",
      use: async ({ admin, connectionString }) => {
        await applyPostgresTestBaselineConnection({ connectionString });
        const accounts = [
          "actor",
          "missing",
          "expired",
          "revoked",
          "recovered",
          "holder",
          "ambiguous",
        ];
        for (const account of accounts) {
          await admin.query("INSERT INTO users(user_id) VALUES ($1)", [account]);
          await createActivePersonaFixture(admin, {
            accountId: account,
            personaId: `persona-${account}`,
          });
        }
        const layer = makeDirectPostgresControlPlaneLayer(connectionString);
        const store = makeControlPlaneSponsoredSendStore(layer, limits);
        let id = 0;
        const request = (accountId: string) => ({
          accountId,
          personaId: `persona-${accountId}`,
          chainId: 84532 as const,
          tokenAddress: address("0a"),
          recipientAddress: address("d1"),
          amountAtomic: 1n,
          idempotencyKey: `send-key-${++id}`,
          providerIdempotencyKey: `provider_idempotency_${id}`,
          sendId: `send-${id}`,
          referenceId: `wallet_reference_${id}`,
        });
        await use({ admin, connectionString, layer, store, request });
      },
    });
  }

  test("absent, expired, revoked, recovered and ambiguous evidence cannot reserve a send", async () => {
    await fixture(async ({ admin, store, request }) => {
      await seedVeryRewardEvidence(admin, "expired", "expired", "2".repeat(64), "expired");
      await seedVeryRewardEvidence(admin, "revoked", "revoked", "3".repeat(64));
      await admin.query(`INSERT INTO assertion_revalidation_events
        (assertion_revalidation_event_id,assertion_id,user_id,evidence_receipt_id,outcome,observed_at)
        VALUES ('revoked-event','composed-assertion-person-revoked','revoked','composed-receipt-revoked','revoked',clock_timestamp())`);
      await seedVeryRewardEvidence(admin, "recovered", "original", "4".repeat(64));
      await seedVeryRewardEvidence(admin, "holder", "recovery", "9".repeat(64), "current", {
        subject: "original",
        previous: "original",
        epoch: 2,
      });
      await seedVeryRewardEvidence(admin, "ambiguous", "ambiguous-a", "5".repeat(64));
      await seedVeryRewardEvidence(admin, "ambiguous", "ambiguous-b", "6".repeat(64));
      for (const account of ["missing", "expired", "revoked", "recovered", "ambiguous"]) {
        expect(await Effect.runPromise(store.hasCurrentPalm({ accountId: account }))).toBe(false);
        expect(
          await Effect.runPromise(Effect.flip(store.reserve(request(account)))),
        ).toBeInstanceOf(WalletSendVerificationRequired);
      }
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM wallet_sponsored_sends")).rows,
      ).toEqual([{ count: 0 }]);
      await seedVeryRewardEvidence(admin, "actor", "actor", "7".repeat(64));
      const owned = request("actor");
      expect((await Effect.runPromise(store.reserve(owned))).sendId).toBe(owned.sendId);
      expect(
        await Effect.runPromise(
          Effect.flip(store.reserve({ ...request("holder"), personaId: "persona-actor" })),
        ),
      ).toMatchObject({ reason: "not-found" });
    });
  }, 120_000);

  test("a revocation committing during admission wins before any reservation is written", async () => {
    await fixture(async ({ admin, connectionString, store, request }) => {
      await seedVeryRewardEvidence(admin, "actor", "concurrent", "a".repeat(64));
      const contender = new Client({ connectionString });
      await contender.connect();
      let pending: Promise<{ value?: unknown; error?: unknown }> | undefined;
      try {
        await contender.query("BEGIN");
        const pid = (await contender.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]?.pid;
        await contender.query(`INSERT INTO assertion_revalidation_events
          (assertion_revalidation_event_id,assertion_id,user_id,evidence_receipt_id,outcome,observed_at)
          VALUES ('concurrent-revoked','composed-assertion-person-concurrent','actor','composed-receipt-concurrent','revoked',clock_timestamp())`);
        pending = Effect.runPromise(store.reserve(request("actor"))).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        let blocked = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const locks = await admin.query(
            "SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))",
            [pid],
          );
          if (locks.rows.length > 0) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        await contender.query("COMMIT");
        expect((await pending).error).toBeInstanceOf(WalletSendVerificationRequired);
        expect(
          (await admin.query("SELECT count(*)::int AS count FROM wallet_sponsored_sends")).rows,
        ).toEqual([{ count: 0 }]);
      } finally {
        await contender.query("ROLLBACK");
        await contender.end();
        await pending;
      }
    });
  }, 120_000);

  test("revocation withholds signing and submission, while same-key replay and uncertain recovery remain available", async () => {
    await fixture(async ({ admin, store, request }) => {
      await seedVeryRewardEvidence(admin, "actor", "pending", "7".repeat(64));
      const original = request("actor");
      await Effect.runPromise(store.reserve(original));
      await seedVeryRewardEvidence(admin, "holder", "unknown", "8".repeat(64));
      const pending = request("holder");
      const pendingRecord = await Effect.runPromise(store.reserve(pending));
      await Effect.runPromise(
        store.markSubmitting({ accountId: "holder", sendId: pending.sendId }),
      );
      await Effect.runPromise(store.markHeld({ accountId: "holder", sendId: pending.sendId }));
      let balanceReads = 0;
      let submissions = 0;
      let observations = 0;
      const service = makeWalletSponsoredSendService({
        store,
        appId: "test-app",
        appSecret: "test-secret",
        eligibleAsset: { chainId: 84532, tokenAddress: address("0a") },
        ids: () => "unused",
        requiredConfirmations: 1,
        chain: {
          readTokenBalance: async () => {
            balanceReads++;
            return 10n;
          },
          readReceipt: async () => ({
            canonical: true,
            status: "success",
            transactionHash: hash("11"),
            blockNumber: 1n,
            blockHash: hash("22"),
            transfers: [
              {
                tokenAddress: address("0a"),
                from: pendingRecord.senderAddress,
                to: address("d1"),
                amountAtomic: 1n,
              },
            ],
          }),
          readFinalizedHead: async () => 2n,
          readHead: async () => 2n,
        },
        submit: async () => {
          submissions++;
          throw Error("must not submit");
        },
        findByReference: async () => {
          observations++;
          return {
            id: "provider-observed",
            transactionHash: hash("11"),
            status: "confirmed",
            walletId: pendingRecord.walletId,
            referenceId: pending.referenceId,
            caip2: "eip155:84532",
          };
        },
      });
      expect(
        (await service.get({ accountId: "actor", sendId: original.sendId })).authorization,
      ).not.toBeNull();
      await admin.query(`INSERT INTO assertion_revalidation_events
        (assertion_revalidation_event_id,assertion_id,user_id,evidence_receipt_id,outcome,observed_at)
        VALUES ('pending-revoked','composed-assertion-person-pending','actor','composed-receipt-pending','revoked',clock_timestamp())`);
      expect((await Effect.runPromise(store.reserve(original))).sendId).toBe(original.sendId);
      expect(await service.get({ accountId: "actor", sendId: original.sendId })).toMatchObject({
        authorization: null,
        verificationRequired: true,
        record: { status: "reserved" },
      });
      await expect(
        service.submit({ accountId: "actor", sendId: original.sendId, signature: "YWJj" }),
      ).rejects.toThrow("Palm verification required");
      expect(
        await Effect.runPromise(
          Effect.flip(store.markSubmitting({ accountId: "actor", sendId: original.sendId })),
        ),
      ).toBeInstanceOf(WalletSendVerificationRequired);
      expect(balanceReads).toBe(0);
      expect(submissions).toBe(0);
      // An already committed unknown effect is recovered without fresh proof or resubmission.
      await admin.query(`INSERT INTO assertion_revalidation_events
        (assertion_revalidation_event_id,assertion_id,user_id,evidence_receipt_id,outcome,observed_at)
        VALUES ('unknown-revoked','composed-assertion-person-unknown','holder','composed-receipt-unknown','revoked',clock_timestamp())`);
      expect(await service.get({ accountId: "holder", sendId: pending.sendId })).toMatchObject({
        authorization: null,
        verificationRequired: false,
        record: { status: "confirmed" },
      });
      expect(observations).toBe(1);
      expect(submissions).toBe(0);
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM wallet_sponsored_sends")).rows,
      ).toEqual([{ count: 2 }]);
    });
  }, 120_000);

  test("verification intents bind the signed-in account and intended persona, reusing the same palm plan", async () => {
    await fixture(async ({ admin, layer }) => {
      const issue = (account: string, persona: string) =>
        Effect.runPromise(
          issueWalletSendVerificationIntent(account, persona).pipe(Effect.provide(layer)),
        );
      const first = await issue("actor", "persona-actor");
      expect(await issue("actor", "persona-actor")).toBe(first);
      await expect(issue("holder", "persona-actor")).rejects.toThrow();
      const resolver = makeControlPlaneWalletSendIntentResolver(layer, "test");
      const resolve = (actor: string, intent = first, provider = "very.web") =>
        Effect.runPromise(
          resolver.resolve({ actor_id: actor, intent_id: intent, provider_id: provider }),
        );
      expect(await resolve("actor")).toMatchObject({
        method: "palm_web",
        subject_binding_intent: "establish",
        requested_claim_ids: ["credential.subject_unique", "human.personhood"],
      });
      expect(await resolve("holder")).toBeNull();
      expect(await resolve("actor", first, "self.pass")).toBeNull();
      await admin.query(
        "UPDATE action_intents SET expires_at=clock_timestamp()-interval '1 second' WHERE action_intent_id=$1",
        [first],
      );
      expect(await resolve("actor")).toBeNull();
      expect(await issue("actor", "persona-actor")).not.toBe(first);
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM wallet_sponsored_sends")).rows,
      ).toEqual([{ count: 0 }]);
    });
  }, 120_000);

  test("a restricted runtime locks evidence through the narrow routine without assertion UPDATE", async () => {
    await fixture(async ({ admin, connectionString, request }) => {
      await seedVeryRewardEvidence(admin, "actor", "restricted", "b".repeat(64));
      // The schema-only baseline deliberately omits ACLs. Execute the actual
      // forward migration here to test its privilege boundary, not a fixture grant.
      const migration = (await loadPostgresMigrations()).find(
        (value) => value.version === "0276_wallet_send_palm_assertion_lock.sql",
      );
      if (migration === undefined) throw Error("Send Palm lock migration missing");
      await admin.query("DROP FUNCTION lock_wallet_send_palm_assertions_v1(text,text)");
      await admin.query(migration.sql);
      const role = `send_runtime_${crypto.randomUUID().replaceAll("-", "")}`;
      const schema: string = (await admin.query("SELECT current_schema() AS name")).rows[0].name;
      const routine = `${schema}.lock_wallet_send_palm_assertions_v1(text,text)`;
      await admin.query(
        `CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
      );
      let runtime: Client | undefined;
      try {
        await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
        await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
        await admin.query(`GRANT UPDATE(subject_key_id) ON subject_keys TO "${role}"`);
        await admin.query(
          `GRANT UPDATE(binding_event_id) ON active_subject_key_bindings TO "${role}"`,
        );
        await admin.query(`GRANT INSERT, UPDATE ON wallet_sponsored_sends TO "${role}"`);
        expect(
          (
            await admin.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [
              role,
              routine,
            ])
          ).rows[0].allowed,
        ).toBe(false);
        const scoped = new URL(connectionString);
        scoped.searchParams.set(
          "options",
          `${scoped.searchParams.get("options") ?? ""} -c role=${role}`,
        );
        runtime = new Client({ connectionString: scoped.toString() });
        await runtime.connect();
        expect((await runtime.query("SELECT current_user AS name")).rows[0].name).toBe(role);
        const store = makeControlPlaneSponsoredSendStore(
          makeDirectPostgresControlPlaneLayer(scoped.toString()),
          limits,
        );
        const original = request("actor");
        expect(await Effect.runPromise(Effect.flip(store.reserve(original)))).toMatchObject({
          _tag: "ControlPlaneStatementFailed",
        });
        expect(
          (await admin.query("SELECT count(*)::int AS count FROM wallet_sponsored_sends")).rows,
        ).toEqual([{ count: 0 }]);
        await admin.query(
          `GRANT EXECUTE ON FUNCTION lock_wallet_send_palm_assertions_v1(text,text) TO "${role}"`,
        );
        expect((await Effect.runPromise(store.reserve(original))).sendId).toBe(original.sendId);
        await Effect.runPromise(
          store.markSubmitting({ accountId: "actor", sendId: original.sendId }),
        );
        expect(
          (await Effect.runPromise(store.get({ accountId: "actor", sendId: original.sendId })))
            ?.status,
        ).toBe("submitting");
        expect(
          (
            await admin.query(
              "SELECT has_any_column_privilege($1,'assertions','UPDATE') AS allowed",
              [role],
            )
          ).rows[0].allowed,
        ).toBe(false);
        await expect(
          runtime.query("SELECT assertion_id FROM assertions FOR UPDATE"),
        ).rejects.toMatchObject({ code: "42501" });
        expect(
          (
            await admin.query("SELECT has_function_privilege('public',$1,'EXECUTE') AS allowed", [
              routine,
            ])
          ).rows[0].allowed,
        ).toBe(false);
        const definition = (
          await admin.query("SELECT prosecdef,proconfig FROM pg_proc WHERE oid=$1::regprocedure", [
            routine,
          ])
        ).rows[0];
        expect(definition.prosecdef).toBe(true);
        expect(definition.proconfig).toEqual([`search_path=${schema}, pg_temp`]);
      } finally {
        await runtime?.end();
        await admin.query(`DROP OWNED BY "${role}"`);
        await admin.query(`DROP ROLE "${role}"`);
      }
    });
  }, 120_000);
});
