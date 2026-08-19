import { afterAll, describe, expect, test } from "bun:test";
import {
  admitCommunityPurchaseFunding,
  createCommunityPurchaseFundingPlan,
  makeCommunityPurchaseFundingInterpreter,
} from "@pirate/application";
import {
  type CommunityPurchaseFundingEvidence,
  type CommunityPurchaseFundingPlan,
  communityPurchaseAtomicAmount,
} from "@pirate/domain";
import { Effect } from "effect";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations";
import {
  makeControlPlaneCommunityPurchaseFundingAdmissionStore,
  makeControlPlaneCommunityPurchaseFundingAttemptStore,
  makeControlPlaneCommunityPurchaseFundingOperatorStore,
  makeControlPlaneCommunityPurchaseFundingPlanStore,
  makeControlPlaneCommunityPurchaseFundingQueryStore,
  makeControlPlaneCommunityPurchaseFundingStore,
} from "./community-purchase-funding-repository";
import { makeDirectPostgresControlPlaneLayer } from "./postgres";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_COMMUNITY_PURCHASE_FUNDING_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-community-purchase-funding-suite-complete";
const sentinelContents =
  "api-next-control-plane-postgres-community-purchase-funding-suite-complete\n";
let completedTestCount = 0;

const TOKEN = `0x${"11".repeat(20)}` as const;
const BUYER = `0x${"22".repeat(20)}` as const;
const TREASURY = `0x${"33".repeat(20)}` as const;
const TRANSACTION_HASH = `0x${"44".repeat(32)}` as const;
const BLOCK_HASH = `0x${"55".repeat(32)}` as const;
const HEAD_HASH = `0x${"66".repeat(32)}` as const;
const OBSERVATION = `0x${"77".repeat(32)}` as const;
const OBSERVATION_2 = `0x${"88".repeat(32)}` as const;
const OBSERVATION_3 = `0x${"99".repeat(32)}` as const;
const HEAD_HASH_2 = `0x${"aa".repeat(32)}` as const;
const HEAD_HASH_3 = `0x${"bb".repeat(32)}` as const;

function schemaIdentifier(): string {
  return `api_next_money_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function connectionForSchema(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

async function withSchema<A>(use: (connection: string, admin: Client) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  const schema = schemaIdentifier();
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  try {
    const connection = connectionForSchema(connectionString, schema);
    await runPostgresMigrations({ connectionString: connection });
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    await admin.query("INSERT INTO users (user_id) VALUES ('user_1'), ('user_2')");
    await admin.query(`INSERT INTO communities (
      community_id, display_name, created_by_user_id, created_at, updated_at
    ) VALUES ('community_1', 'Community One', 'user_1', clock_timestamp(), clock_timestamp())`);
    return await use(connection, admin);
  } finally {
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

function plan(quoteId = "quote_1", purchaseId = "purchase_1"): CommunityPurchaseFundingPlan {
  return {
    communityId: "community_1",
    quoteId,
    purchaseId,
    policyVersion: 3,
    expected: {
      chainId: 8453,
      tokenContract: TOKEN,
      tokenDecimals: 6,
      sender: BUYER,
      recipient: TREASURY,
      amountAtomic: communityPurchaseAtomicAmount(12_500_000n),
      requiredConfirmations: 3,
    },
    now: 1_000,
  };
}

function evidence(observationId = OBSERVATION): CommunityPurchaseFundingEvidence {
  return {
    receiptStatus: "success",
    chainId: 8453,
    tokenContract: TOKEN,
    sender: BUYER,
    recipient: TREASURY,
    amountAtomic: communityPurchaseAtomicAmount(12_500_000n),
    transactionHash: TRANSACTION_HASH,
    blockNumber: 123,
    blockHash: BLOCK_HASH,
    logIndex: 4,
    observationId,
    observedHeadBlockNumber: 125,
    observedHeadBlockHash: HEAD_HASH,
  };
}

function interpreterFor(connection: string) {
  return makeCommunityPurchaseFundingInterpreter(
    makeControlPlaneCommunityPurchaseFundingStore(makeDirectPostgresControlPlaneLayer(connection)),
  );
}

function admissionFor(connection: string) {
  return makeControlPlaneCommunityPurchaseFundingAdmissionStore(
    makeDirectPostgresControlPlaneLayer(connection),
  );
}

function run<A, E>(effect: Effect.Effect<A, E, never>): Promise<A> {
  return Effect.runPromise(Effect.scoped(effect));
}

function admit(
  connection: string,
  input: Partial<{
    actorId: string;
    authenticatedWalletAddress: string;
    quoteId: string;
    clientNonce: string;
  }> = {},
) {
  return run(
    admitCommunityPurchaseFunding(
      {
        actorId: input.actorId ?? "user_1",
        authenticatedWalletAddress: input.authenticatedWalletAddress ?? BUYER,
        quoteId: input.quoteId ?? "quote_admission",
        clientNonce: input.clientNonce ?? "nonce_admission",
      },
      admissionFor(connection),
    ),
  );
}

async function insertAdmissionPlan(
  admin: Client,
  options: {
    readonly quoteId?: string;
    readonly status?: string;
    readonly expired?: boolean;
    readonly shortLived?: boolean;
  } = {},
) {
  const quoteId = options.quoteId ?? "quote_admission";
  const status = options.status ?? "active";
  const expires = options.expired
    ? "clock_timestamp() - INTERVAL '1 second'"
    : options.shortLived
      ? "clock_timestamp() + INTERVAL '2 seconds'"
      : "clock_timestamp() + INTERVAL '1 hour'";
  await admin.query(
    `
    INSERT INTO community_purchase_funding_plans (
      quote_id, community_id, actor_id, buyer_wallet_address, buyer_chain_id, purchase_id,
      policy_version, chain_id, token_contract, token_decimals, treasury_address,
      amount_atomic, required_confirmations, quoted_at, expires_at, status
    ) VALUES ($1, 'community_1', 'user_1', $2, 8453, $3, 3, 8453, $4, 6, $5,
              12500000, 3, clock_timestamp() - INTERVAL '1 hour', ${expires}, $6)
  `,
    [quoteId, BUYER, `${quoteId}_purchase`, TOKEN, TREASURY, status],
  );
}

async function begin(
  connection: string,
  input: {
    nonce?: string;
    canonicalExtra?: Readonly<Record<string, unknown>>;
    fundingPlan?: CommunityPurchaseFundingPlan;
  } = {},
) {
  const interpreter = interpreterFor(connection);
  const begun = await run(
    interpreter.begin({
      actorId: "user_1",
      clientNonce: input.nonce ?? "nonce_1",
      canonicalRequest: {
        quote_id: (input.fundingPlan ?? plan()).quoteId,
        purchase_id: (input.fundingPlan ?? plan()).purchaseId,
        ...input.canonicalExtra,
      },
      plan: input.fundingPlan ?? plan(),
    }),
  );
  return { interpreter, begun };
}

async function markReconcilable(
  admin: Client,
  operationId: string,
  transactionHash: string,
  observationId: string,
  state: "confirming" | "reconciliation_required" = "confirming",
) {
  await admin.query(
    `UPDATE community_purchase_funding_journal
        SET state = $4, version = 2,
            snapshot = jsonb_set(jsonb_set(snapshot, '{state}', to_jsonb($4::text)), '{version}', '2'),
            funding_receipt_status = 'reverted',
            funding_transaction_hash = $2,
            funding_observation_id = $3,
            updated_at = clock_timestamp()
      WHERE operation_id = $1`,
    [operationId, transactionHash, observationId, state],
  );
}

suite("Postgres 17 community-purchase funding journal", () => {
  test("replays the same request and rejects changed request or economic identity", async () => {
    await withSchema(async (connection) => {
      const first = await begin(connection);
      const same = await begin(connection);
      expect(first.begun.replayed).toBe(false);
      expect(same.begun.replayed).toBe(true);
      await expect(begin(connection, { canonicalExtra: { changed: true } })).rejects.toMatchObject({
        reason: "request-conflict",
      });
      await expect(
        begin(connection, {
          nonce: "nonce_2",
          canonicalExtra: { amount_atomic: "12500001" },
          fundingPlan: {
            ...plan(),
            expected: {
              ...plan().expected,
              amountAtomic: communityPurchaseAtomicAmount(12_500_001n),
            },
          },
        }),
      ).rejects.toMatchObject({ reason: "operation-conflict" });
    });
    completedTestCount += 1;
  });

  test("fences stale lease owners after database-clock expiry", async () => {
    await withSchema(async (connection, admin) => {
      const { interpreter, begun } = await begin(connection);
      const first = await run(
        interpreter.acquireLease({
          operationId: begun.entry.state.operationId,
          ownerId: "worker_1",
          leaseMs: 60_000,
        }),
      );
      await expect(
        run(
          interpreter.acquireLease({
            operationId: begun.entry.state.operationId,
            ownerId: "worker_2",
            leaseMs: 60_000,
          }),
        ),
      ).rejects.toMatchObject({ reason: "lease-busy" });
      await admin.query(
        `UPDATE community_purchase_funding_journal
            SET lease_expires_at = clock_timestamp() - INTERVAL '1 second'
          WHERE operation_id = $1`,
        [begun.entry.state.operationId],
      );
      const second = await run(
        interpreter.acquireLease({
          operationId: begun.entry.state.operationId,
          ownerId: "worker_2",
          leaseMs: 60_000,
        }),
      );
      expect(second.fenceToken).toBe(first.fenceToken + 1);
      await expect(
        run(
          interpreter.transition({
            lease: first,
            source: "request",
            expectedVersion: 1,
            event: {
              type: "funding_evidence_observed",
              expectedVersion: 1,
              at: 1_001,
              evidence: evidence(),
            },
          }),
        ),
      ).rejects.toMatchObject({ reason: "lease-lost" });
    });
    completedTestCount += 1;
  });

  test("atomically appends evidence, confirms a deterministic receipt, and replays lost response", async () => {
    await withSchema(async (connection, admin) => {
      const { interpreter, begun } = await begin(connection);
      const lease = await run(
        interpreter.acquireLease({
          operationId: begun.entry.state.operationId,
          ownerId: "worker_1",
          leaseMs: 60_000,
        }),
      );
      const event = {
        type: "funding_evidence_observed",
        expectedVersion: 1,
        at: 1_001,
        evidence: evidence(),
      } as const;
      const confirmed = await run(
        interpreter.transition({ lease, source: "request", expectedVersion: 1, event }),
      );
      expect(confirmed.entry.status).toBe("confirmed");
      const replay = await run(
        interpreter.transition({ lease, source: "reconciler", expectedVersion: 1, event }),
      );
      expect(replay.replayed).toBe(true);
      const counts = await admin.query(`SELECT
        (SELECT count(*) FROM community_purchase_funding_transitions) AS transitions,
        (SELECT count(*) FROM community_purchase_funding_transaction_claims) AS claims,
        (SELECT count(*) FROM community_purchase_funding_receipts) AS receipts`);
      expect(counts.rows[0]).toMatchObject({ transitions: "1", claims: "1", receipts: "1" });
      const request = await admin.query(
        "SELECT status, result_version, result FROM community_purchase_funding_requests",
      );
      expect(request.rows[0]).toMatchObject({ status: "confirmed", result_version: "2" });
      expect(request.rows[0]?.result).toMatchObject({ status: "confirmed", version: 2 });
      await expect(admin.query("DELETE FROM community_purchase_funding_receipts")).rejects.toThrow(
        "append-only",
      );
    });
    completedTestCount += 1;
  });

  test("persists a fresh confirmed head while retaining one append-only receipt", async () => {
    await withSchema(async (connection, admin) => {
      const { interpreter, begun } = await begin(connection);
      const lease = await run(
        interpreter.acquireLease({
          operationId: begun.entry.state.operationId,
          ownerId: "worker_1",
          leaseMs: 60_000,
        }),
      );
      await run(
        interpreter.transition({
          lease,
          source: "request",
          expectedVersion: 1,
          event: {
            type: "funding_evidence_observed",
            expectedVersion: 1,
            at: 1_001,
            evidence: evidence(),
          },
        }),
      );
      const refreshed = await run(
        interpreter.transition({
          lease,
          source: "reconciler",
          expectedVersion: 2,
          event: {
            type: "funding_evidence_observed",
            expectedVersion: 2,
            at: 1_002,
            evidence: {
              ...evidence(OBSERVATION_2),
              observedHeadBlockNumber: 126,
              observedHeadBlockHash: HEAD_HASH_2,
            },
          },
        }),
      );
      expect(refreshed).toMatchObject({
        replayed: false,
        entry: { status: "confirmed", version: 3 },
      });
      expect(refreshed.entry.state.fundingEvidence?.observationId).toBe(OBSERVATION_2);
      const counts = await admin.query(`SELECT
        (SELECT count(*) FROM community_purchase_funding_transitions) AS transitions,
        (SELECT count(*) FROM community_purchase_funding_receipts) AS receipts`);
      expect(counts.rows[0]).toEqual({ transitions: "2", receipts: "1" });
    });
    completedTestCount += 1;
  });

  test("re-confirms the pinned receipt after a canonical-head reconciliation round-trip", async () => {
    await withSchema(async (connection, admin) => {
      const { interpreter, begun } = await begin(connection);
      const lease = await run(
        interpreter.acquireLease({
          operationId: begun.entry.state.operationId,
          ownerId: "worker_1",
          leaseMs: 60_000,
        }),
      );
      await run(
        interpreter.transition({
          lease,
          source: "request",
          expectedVersion: 1,
          event: {
            type: "funding_evidence_observed",
            expectedVersion: 1,
            at: 1_001,
            evidence: evidence(),
          },
        }),
      );
      const reconciliation = await run(
        interpreter.transition({
          lease,
          source: "reconciler",
          expectedVersion: 2,
          event: {
            type: "funding_evidence_observed",
            expectedVersion: 2,
            at: 1_002,
            evidence: {
              ...evidence(OBSERVATION_2),
              observedHeadBlockHash: HEAD_HASH_2,
            },
          },
        }),
      );
      expect(reconciliation.entry).toMatchObject({
        status: "reconciliation_required",
        version: 3,
      });
      const resolved = await run(
        interpreter.transition({
          lease,
          source: "reconciler",
          expectedVersion: 3,
          event: {
            type: "reconciliation_resolved",
            expectedVersion: 3,
            at: 1_003,
            evidence: {
              ...evidence(OBSERVATION_3),
              observedHeadBlockNumber: 126,
              observedHeadBlockHash: HEAD_HASH_3,
            },
          },
        }),
      );
      expect(resolved.entry).toMatchObject({ status: "confirmed", version: 4 });
      const counts = await admin.query(`SELECT
        (SELECT count(*) FROM community_purchase_funding_transitions) AS transitions,
        (SELECT count(*) FROM community_purchase_funding_receipts) AS receipts`);
      expect(counts.rows[0]).toEqual({ transitions: "3", receipts: "1" });
    });
    completedTestCount += 1;
  });

  test("rolls back confirmation when a pre-existing receipt disagrees with pinned evidence", async () => {
    await withSchema(async (connection, admin) => {
      const { interpreter, begun } = await begin(connection);
      await admin.query(
        `INSERT INTO community_purchase_funding_receipts (
           receipt_id, operation_id, community_id, purchase_id, chain_id,
           token_contract, sender, recipient, amount_atomic,
           transaction_hash, log_index, block_number, block_hash
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          "corrupt-receipt",
          begun.entry.state.operationId,
          "community_1",
          "purchase_1",
          8453,
          TOKEN,
          BUYER,
          TREASURY,
          "12500000",
          TRANSACTION_HASH,
          4,
          123,
          `0x${"cc".repeat(32)}`,
        ],
      );
      const lease = await run(
        interpreter.acquireLease({
          operationId: begun.entry.state.operationId,
          ownerId: "worker_1",
          leaseMs: 60_000,
        }),
      );
      await expect(
        run(
          interpreter.transition({
            lease,
            source: "reconciler",
            expectedVersion: 1,
            event: {
              type: "funding_evidence_observed",
              expectedVersion: 1,
              at: 1_001,
              evidence: evidence(),
            },
          }),
        ),
      ).rejects.toMatchObject({ reason: "constraint" });
      const durable = await admin.query(
        `SELECT state, version,
          (SELECT count(*) FROM community_purchase_funding_transitions) AS transitions,
          (SELECT count(*) FROM community_purchase_funding_transaction_claims) AS claims
         FROM community_purchase_funding_journal
        WHERE operation_id = $1`,
        [begun.entry.state.operationId],
      );
      expect(durable.rows[0]).toEqual({
        state: "planned",
        version: "1",
        transitions: "0",
        claims: "0",
      });
    });
    completedTestCount += 1;
  });

  test("prevents one funding transaction from settling a second operation", async () => {
    await withSchema(async (connection, admin) => {
      const first = await begin(connection);
      const second = await begin(connection, {
        nonce: "nonce_2",
        fundingPlan: plan("quote_2", "purchase_2"),
      });
      const firstLease = await run(
        first.interpreter.acquireLease({
          operationId: first.begun.entry.state.operationId,
          ownerId: "worker_1",
          leaseMs: 60_000,
        }),
      );
      const secondLease = await run(
        second.interpreter.acquireLease({
          operationId: second.begun.entry.state.operationId,
          ownerId: "worker_2",
          leaseMs: 60_000,
        }),
      );
      await run(
        first.interpreter.transition({
          lease: firstLease,
          source: "request",
          expectedVersion: 1,
          event: {
            type: "funding_evidence_observed",
            expectedVersion: 1,
            at: 1_001,
            evidence: evidence(),
          },
        }),
      );
      await expect(
        run(
          second.interpreter.transition({
            lease: secondLease,
            source: "reconciler",
            expectedVersion: 1,
            event: {
              type: "funding_evidence_observed",
              expectedVersion: 1,
              at: 1_001,
              evidence: evidence(`0x${"88".repeat(32)}`),
            },
          }),
        ),
      ).rejects.toMatchObject({ reason: "identity-conflict" });
      const secondRow = await admin.query(
        "SELECT state, version FROM community_purchase_funding_journal WHERE operation_id = $1",
        [second.begun.entry.state.operationId],
      );
      expect(secondRow.rows[0]).toEqual({ state: "planned", version: "1" });
      expect(
        (await admin.query("SELECT count(*) FROM community_purchase_funding_transitions")).rows[0]
          ?.count,
      ).toBe("1");
    });
    completedTestCount += 1;
  });

  test("admits from a locked server plan and replays after plan expiry", async () => {
    await withSchema(async (connection, admin) => {
      await insertAdmissionPlan(admin, { shortLived: true });
      const first = await admit(connection);
      expect(first.replayed).toBe(false);
      await Bun.sleep(2_100);
      const replay = await admit(connection);
      expect(replay.replayed).toBe(true);
      expect(replay.entry.state.operationId).toBe(first.entry.state.operationId);
      await insertAdmissionPlan(admin, { quoteId: "quote_other" });
      await expect(admit(connection, { quoteId: "quote_other" })).rejects.toMatchObject({
        reason: "request-conflict",
      });
      const counts = await admin.query(
        `SELECT
           (SELECT count(*) FROM community_purchase_funding_journal) AS journals,
           (SELECT count(*) FROM community_purchase_funding_requests) AS requests`,
      );
      expect(counts.rows[0]).toEqual({ journals: "1", requests: "1" });
    });
    completedTestCount += 1;
  });

  test("aliases a bound plan for a second nonce and rejects actor or wallet mismatch", async () => {
    await withSchema(async (connection, admin) => {
      await insertAdmissionPlan(admin);
      const [first, alias] = await Promise.all([
        admit(connection),
        admit(connection, { clientNonce: "nonce_admission_2" }),
      ]);
      expect([first.replayed, alias.replayed].sort()).toEqual([false, true]);
      expect(alias.entry.state.operationId).toBe(first.entry.state.operationId);
      await expect(
        admit(connection, { actorId: "user_2", clientNonce: "nonce_actor" }),
      ).rejects.toMatchObject({
        reason: "actor-mismatch",
      });
      await expect(
        admit(connection, {
          authenticatedWalletAddress: `0x${"99".repeat(20)}`,
          clientNonce: "nonce_wallet",
        }),
      ).rejects.toMatchObject({ reason: "wallet-mismatch" });
      const counts = await admin.query(
        `SELECT
           (SELECT count(*) FROM community_purchase_funding_journal) AS journals,
           (SELECT count(*) FROM community_purchase_funding_requests) AS requests`,
      );
      expect(counts.rows[0]).toEqual({ journals: "1", requests: "2" });
    });
    completedTestCount += 1;
  });

  test("rejects an expired first admission without creating a journal", async () => {
    await withSchema(async (connection, admin) => {
      await insertAdmissionPlan(admin, { expired: true });
      await expect(admit(connection)).rejects.toMatchObject({ reason: "plan-expired" });
      const count = await admin.query("SELECT count(*) FROM community_purchase_funding_journal");
      expect(count.rows[0]?.count).toBe("0");
    });
    completedTestCount += 1;
  });

  test("rolls back plan binding and journal creation when request persistence fails", async () => {
    await withSchema(async (connection, admin) => {
      await insertAdmissionPlan(admin);
      await admin.query(`
        CREATE FUNCTION fail_funding_admission_request() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'injected request failure';
        END;
        $$;
        CREATE TRIGGER fail_funding_admission_request
        BEFORE INSERT ON community_purchase_funding_requests
        FOR EACH ROW EXECUTE FUNCTION fail_funding_admission_request();
      `);
      await expect(admit(connection)).rejects.toMatchObject({ reason: "unavailable" });
      const state = await admin.query(
        `SELECT status, operation_id,
                (SELECT count(*) FROM community_purchase_funding_journal) AS journals
           FROM community_purchase_funding_plans
          WHERE quote_id = 'quote_admission'`,
      );
      expect(state.rows[0]).toEqual({ status: "active", operation_id: null, journals: "0" });
    });
    completedTestCount += 1;
  });

  test("selects database-aged dormancy candidates and retains all canonical M3 rows", async () => {
    await withSchema(async (connection, admin) => {
      const { interpreter, begun } = await begin(connection);
      await insertAdmissionPlan(admin, { quoteId: "quote_retained" });
      await admin.query(
        `UPDATE community_purchase_funding_journal
            SET created_at = clock_timestamp() - INTERVAL '31 minutes'
          WHERE operation_id = $1`,
        [begun.entry.state.operationId],
      );
      const query = makeControlPlaneCommunityPurchaseFundingQueryStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const candidates = await run(
        query.listDormancyCandidates({ limit: 10, submissionWindowMs: 30 * 60 * 1_000 }),
      );
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        operationId: begun.entry.state.operationId,
        expectedVersion: 1,
      });
      const candidate = candidates[0];
      if (candidate === undefined) throw new Error("missing dormancy candidate");
      const lease = await run(
        interpreter.acquireLease({
          operationId: candidate.operationId,
          ownerId: "dormancy-worker",
          leaseMs: 60_000,
        }),
      );
      const dormant = await run(
        interpreter.transition({
          lease,
          source: "reconciler",
          expectedVersion: candidate.expectedVersion,
          event: {
            type: "submission_window_elapsed",
            expectedVersion: candidate.expectedVersion,
            at: candidate.databaseNowMs,
          },
        }),
      );
      expect(dormant.entry).toMatchObject({ status: "dormant_unobserved", version: 2 });
      expect(await run(query.listDormancyCandidates({ limit: 10, submissionWindowMs: 1 }))).toEqual(
        [],
      );

      for (const table of [
        "community_purchase_funding_requests",
        "community_purchase_funding_journal",
        "community_purchase_funding_plans",
      ]) {
        await expect(admin.query(`DELETE FROM ${table}`)).rejects.toThrow("append-only");
      }
    });
    completedTestCount += 1;
  });

  test("creates immutable plans from product-derived terms using database quote time", async () => {
    await withSchema(async (connection) => {
      const store = makeControlPlaneCommunityPurchaseFundingPlanStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const draft = {
        quoteId: "quote_product",
        communityId: "community_1",
        actorId: "user_1",
        buyerWalletAddress: BUYER,
        buyerChainId: 8453,
        purchaseId: "purchase_product",
        policyVersion: 3,
        tokenContract: TOKEN,
        tokenDecimals: 6 as const,
        treasuryAddress: TREASURY,
        amountAtomic: communityPurchaseAtomicAmount(12_500_000n),
        requiredConfirmations: 3,
        quoteTtlSeconds: 300,
      };
      const inserted = await run(createCommunityPurchaseFundingPlan(draft, store));
      expect(inserted.kind).toBe("inserted");
      if (inserted.kind !== "inserted") throw new Error("plan was not inserted");
      expect(Date.parse(inserted.plan.expiresAt) - Date.parse(inserted.plan.quotedAt)).toBe(
        300_000,
      );
      const replayed = await run(createCommunityPurchaseFundingPlan(draft, store));
      expect(replayed.kind).toBe("replayed");
      await expect(
        run(
          createCommunityPurchaseFundingPlan(
            { ...draft, amountAtomic: communityPurchaseAtomicAmount(12_500_001n) },
            store,
          ),
        ),
      ).rejects.toMatchObject({ reason: "conflict" });
    });
    completedTestCount += 1;
  });

  test("serializes concurrent attempt claims and fences stale finalizers", async () => {
    await withSchema(async (connection, admin) => {
      const { begun } = await begin(connection, { nonce: "nonce_attempt_claim" });
      const transactionHash = `0x${"ab".repeat(32)}`;
      const observationId = `0x${"cd".repeat(32)}`;
      await admin.query(
        `UPDATE community_purchase_funding_journal
            SET state = 'confirming', version = 2,
                snapshot = jsonb_set(jsonb_set(snapshot, '{state}', '"confirming"'), '{version}', '2'),
                funding_receipt_status = 'reverted',
                funding_transaction_hash = $2,
                funding_observation_id = $3,
                updated_at = clock_timestamp()
          WHERE operation_id = $1`,
        [begun.entry.state.operationId, transactionHash, observationId],
      );
      const attempts = makeControlPlaneCommunityPurchaseFundingAttemptStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const firstGeneration = await run(
        attempts.recordAttemptStart({
          operationId: begun.entry.state.operationId,
          reservationMs: 60_000,
        }),
      );
      expect(firstGeneration.kind).toBe("reserved");
      if (firstGeneration.kind !== "reserved") throw new Error("first claim was unavailable");
      await admin.query(
        `UPDATE community_purchase_funding_reconciliation_attempts
            SET next_attempt_at = clock_timestamp() - INTERVAL '1 second'
          WHERE operation_id = $1`,
        [begun.entry.state.operationId],
      );
      const [claimA, claimB] = await Promise.all([
        run(
          attempts.recordAttemptStart({
            operationId: begun.entry.state.operationId,
            reservationMs: 60_000,
          }),
        ),
        run(
          attempts.recordAttemptStart({
            operationId: begun.entry.state.operationId,
            reservationMs: 60_000,
          }),
        ),
      ]);
      expect([claimA.kind, claimB.kind].sort()).toEqual(["reserved", "unavailable"]);
      const winner = claimA.kind === "reserved" ? claimA : claimB;
      if (winner.kind !== "reserved") throw new Error("concurrent claim winner was unavailable");
      expect(winner.state.generation).toBe(firstGeneration.state.generation + 1);

      const staleSuccess = await run(
        attempts.recordAttemptSuccess({
          operationId: begun.entry.state.operationId,
          generation: firstGeneration.state.generation,
        }),
      );
      expect(staleSuccess).toEqual({ kind: "stale" });
      const staleFailure = await run(
        attempts.recordAttemptFailure({
          operationId: begun.entry.state.operationId,
          generation: firstGeneration.state.generation,
          failureClass: "chain_timeout",
          retryDelayMs: 1_000,
          escalationThreshold: 3,
        }),
      );
      expect(staleFailure).toEqual({ kind: "stale" });
      const row = await admin.query(
        `SELECT generation, consecutive_failures, next_attempt_at
           FROM community_purchase_funding_reconciliation_attempts
          WHERE operation_id = $1`,
        [begun.entry.state.operationId],
      );
      expect(row.rows[0]?.generation).toBe(String(winner.state.generation));
      expect(row.rows[0]?.consecutive_failures).toBe(0);
      expect(row.rows[0]?.next_attempt_at).not.toBeNull();
    });
    completedTestCount += 1;
  });

  test("consumes same-generation success and failure finalizers exactly once", async () => {
    await withSchema(async (connection, admin) => {
      const attempts = makeControlPlaneCommunityPurchaseFundingAttemptStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const successCase = await begin(connection, { nonce: "nonce_duplicate_success" });
      await markReconcilable(
        admin,
        successCase.begun.entry.state.operationId,
        `0x${"ab".repeat(32)}`,
        `0x${"cd".repeat(32)}`,
      );
      const successClaim = await run(
        attempts.recordAttemptStart({
          operationId: successCase.begun.entry.state.operationId,
          reservationMs: 60_000,
        }),
      );
      expect(successClaim.kind).toBe("reserved");
      if (successClaim.kind !== "reserved") throw new Error("success claim unavailable");
      expect(
        await run(
          attempts.recordAttemptSuccess({
            operationId: successCase.begun.entry.state.operationId,
            generation: successClaim.state.generation,
          }),
        ),
      ).toMatchObject({ kind: "finalized" });
      expect(
        await run(
          attempts.recordAttemptSuccess({
            operationId: successCase.begun.entry.state.operationId,
            generation: successClaim.state.generation,
          }),
        ),
      ).toEqual({ kind: "stale" });
      expect(
        await run(
          attempts.recordAttemptFailure({
            operationId: successCase.begun.entry.state.operationId,
            generation: successClaim.state.generation,
            failureClass: "chain_timeout",
            retryDelayMs: 1_000,
            escalationThreshold: 12,
          }),
        ),
      ).toEqual({ kind: "stale" });

      const failureCase = await begin(connection, {
        nonce: "nonce_duplicate_failure",
        fundingPlan: plan("quote_duplicate_failure", "purchase_duplicate_failure"),
      });
      await markReconcilable(
        admin,
        failureCase.begun.entry.state.operationId,
        `0x${"ef".repeat(32)}`,
        `0x${"12".repeat(32)}`,
      );
      const failureClaim = await run(
        attempts.recordAttemptStart({
          operationId: failureCase.begun.entry.state.operationId,
          reservationMs: 60_000,
        }),
      );
      expect(failureClaim.kind).toBe("reserved");
      if (failureClaim.kind !== "reserved") throw new Error("failure claim unavailable");
      expect(
        await run(
          attempts.recordAttemptFailure({
            operationId: failureCase.begun.entry.state.operationId,
            generation: failureClaim.state.generation,
            failureClass: "chain_timeout",
            retryDelayMs: 1_000,
            escalationThreshold: 12,
          }),
        ),
      ).toMatchObject({ kind: "finalized" });
      expect(
        await run(
          attempts.recordAttemptFailure({
            operationId: failureCase.begun.entry.state.operationId,
            generation: failureClaim.state.generation,
            failureClass: "chain_timeout",
            retryDelayMs: 1_000,
            escalationThreshold: 12,
          }),
        ),
      ).toEqual({ kind: "stale" });
      const rows = await admin.query(
        `SELECT finalized_generation, consecutive_failures
           FROM community_purchase_funding_reconciliation_attempts
          WHERE operation_id IN ($1, $2)
          ORDER BY operation_id`,
        [successCase.begun.entry.state.operationId, failureCase.begun.entry.state.operationId],
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows.map((row) => row.finalized_generation)).toEqual(["1", "1"]);
      expect(rows.rows.map((row) => row.consecutive_failures)).toEqual([0, 1]);
    });
    completedTestCount += 1;
  });

  test("serializes concurrent success and failure finalizers for one claim", async () => {
    await withSchema(async (connection, admin) => {
      const { begun } = await begin(connection, { nonce: "nonce_success_failure_race" });
      await markReconcilable(
        admin,
        begun.entry.state.operationId,
        `0x${"34".repeat(32)}`,
        `0x${"56".repeat(32)}`,
      );
      const attempts = makeControlPlaneCommunityPurchaseFundingAttemptStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const claim = await run(
        attempts.recordAttemptStart({
          operationId: begun.entry.state.operationId,
          reservationMs: 60_000,
        }),
      );
      expect(claim.kind).toBe("reserved");
      if (claim.kind !== "reserved") throw new Error("claim unavailable");
      const [success, failure] = await Promise.all([
        run(
          attempts.recordAttemptSuccess({
            operationId: begun.entry.state.operationId,
            generation: claim.state.generation,
          }),
        ),
        run(
          attempts.recordAttemptFailure({
            operationId: begun.entry.state.operationId,
            generation: claim.state.generation,
            failureClass: "chain_timeout",
            retryDelayMs: 1_000,
            escalationThreshold: 12,
          }),
        ),
      ]);
      expect([success.kind, failure.kind].sort()).toEqual(["finalized", "stale"]);
      const row = await admin.query(
        `SELECT generation, finalized_generation, consecutive_failures
           FROM community_purchase_funding_reconciliation_attempts
          WHERE operation_id = $1`,
        [begun.entry.state.operationId],
      );
      expect(row.rows[0]?.generation).toBe("1");
      expect(row.rows[0]?.finalized_generation).toBe("1");
      expect([0, 1]).toContain(Number(row.rows[0]?.consecutive_failures));
    });
    completedTestCount += 1;
  });

  test("escalates exactly at twelve failures and excludes the row from claims", async () => {
    await withSchema(async (connection, admin) => {
      const { begun } = await begin(connection, { nonce: "nonce_escalation_threshold" });
      await markReconcilable(
        admin,
        begun.entry.state.operationId,
        `0x${"78".repeat(32)}`,
        `0x${"9a".repeat(32)}`,
      );
      const attempts = makeControlPlaneCommunityPurchaseFundingAttemptStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      for (let count = 1; count <= 12; count += 1) {
        const claim = await run(
          attempts.recordAttemptStart({
            operationId: begun.entry.state.operationId,
            reservationMs: 60_000,
          }),
        );
        expect(claim.kind).toBe("reserved");
        if (claim.kind !== "reserved") throw new Error(`claim ${count} unavailable`);
        const failure = await run(
          attempts.recordAttemptFailure({
            operationId: begun.entry.state.operationId,
            generation: claim.state.generation,
            failureClass: "chain_timeout",
            retryDelayMs: 1,
            escalationThreshold: 12,
          }),
        );
        expect(failure.kind).toBe("finalized");
        if (failure.kind !== "finalized") throw new Error(`failure ${count} stale`);
        if (count < 12) {
          await admin.query(
            `UPDATE community_purchase_funding_reconciliation_attempts
                SET next_attempt_at = clock_timestamp() - INTERVAL '1 second'
              WHERE operation_id = $1`,
            [begun.entry.state.operationId],
          );
        }
      }
      const query = makeControlPlaneCommunityPurchaseFundingQueryStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      expect(await run(query.listReconcilable({ limit: 10 }))).toEqual([]);
      expect(
        await run(
          attempts.recordAttemptStart({
            operationId: begun.entry.state.operationId,
            reservationMs: 60_000,
          }),
        ),
      ).toEqual({ kind: "unavailable" });
      const row = await admin.query(
        `SELECT generation, finalized_generation, consecutive_failures, escalated_at
           FROM community_purchase_funding_reconciliation_attempts
          WHERE operation_id = $1`,
        [begun.entry.state.operationId],
      );
      expect(row.rows[0]?.generation).toBe("12");
      expect(row.rows[0]?.finalized_generation).toBe("12");
      expect(row.rows[0]?.consecutive_failures).toBe(12);
      expect(row.rows[0]?.escalated_at).not.toBeNull();
    });
    completedTestCount += 1;
  });

  test("success finalization resets failure metadata for a new claim", async () => {
    await withSchema(async (connection, admin) => {
      const { begun } = await begin(connection, { nonce: "nonce_success_reset" });
      await markReconcilable(
        admin,
        begun.entry.state.operationId,
        `0x${"bc".repeat(32)}`,
        `0x${"de".repeat(32)}`,
      );
      const attempts = makeControlPlaneCommunityPurchaseFundingAttemptStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const first = await run(
        attempts.recordAttemptStart({
          operationId: begun.entry.state.operationId,
          reservationMs: 60_000,
        }),
      );
      expect(first.kind).toBe("reserved");
      if (first.kind !== "reserved") throw new Error("first claim unavailable");
      expect(
        await run(
          attempts.recordAttemptFailure({
            operationId: begun.entry.state.operationId,
            generation: first.state.generation,
            failureClass: "chain_timeout",
            retryDelayMs: 1,
            escalationThreshold: 12,
          }),
        ),
      ).toMatchObject({ kind: "finalized" });
      await admin.query(
        `UPDATE community_purchase_funding_reconciliation_attempts
            SET next_attempt_at = clock_timestamp() - INTERVAL '1 second'
          WHERE operation_id = $1`,
        [begun.entry.state.operationId],
      );
      const second = await run(
        attempts.recordAttemptStart({
          operationId: begun.entry.state.operationId,
          reservationMs: 60_000,
        }),
      );
      expect(second.kind).toBe("reserved");
      if (second.kind !== "reserved") throw new Error("second claim unavailable");
      const success = await run(
        attempts.recordAttemptSuccess({
          operationId: begun.entry.state.operationId,
          generation: second.state.generation,
        }),
      );
      expect(success).toMatchObject({ kind: "finalized" });
      const row = await admin.query(
        `SELECT generation, finalized_generation, consecutive_failures, escalated_at,
                last_failure_class, next_attempt_at
           FROM community_purchase_funding_reconciliation_attempts
          WHERE operation_id = $1`,
        [begun.entry.state.operationId],
      );
      expect(row.rows[0]).toMatchObject({
        generation: "2",
        finalized_generation: "2",
        consecutive_failures: 0,
        escalated_at: null,
        last_failure_class: null,
        next_attempt_at: null,
      });
    });
    completedTestCount += 1;
  });

  test("parks hashless entries and excludes them from parked reconciliation claims", async () => {
    await withSchema(async (connection, admin) => {
      const { begun } = await begin(connection, { nonce: "nonce_parked_counts" });
      await markReconcilable(
        admin,
        begun.entry.state.operationId,
        `0x${"ab".repeat(32)}`,
        `0x${"cd".repeat(32)}`,
      );
      await admin.query(
        `UPDATE community_purchase_funding_journal
            SET state = 'reconciliation_required', version = 3,
                snapshot = jsonb_set(
                  jsonb_set(
                    jsonb_set(snapshot, '{state}', '"reconciliation_required"'),
                    '{version}', '3'
                  ),
                  '{failure}', '{"_tag":"ambiguous","mayRebroadcast":false,"mayRetry":false,"disposition":"reconciliation_required"}'
                ),
                failure_tag = 'ambiguous', failure_reason = 'missing-claim',
                funding_transaction_hash = NULL, funding_observation_id = NULL,
                updated_at = clock_timestamp()
          WHERE operation_id = $1`,
        [begun.entry.state.operationId],
      );
      const layer = makeDirectPostgresControlPlaneLayer(connection);
      const query = makeControlPlaneCommunityPurchaseFundingQueryStore(layer);
      const attempts = makeControlPlaneCommunityPurchaseFundingAttemptStore(layer);
      expect(await run(query.parkedCounts?.() ?? Effect.succeed([]))).toEqual([
        { failureTag: "ambiguous", failureReason: "missing-claim", operations: 1 },
      ]);
      expect(
        await run(
          attempts.recordAttemptStart({
            operationId: begun.entry.state.operationId,
            reservationMs: 60_000,
          }),
        ),
      ).toEqual({ kind: "unavailable" });
      const row = await admin.query(
        `SELECT count(*) FROM community_purchase_funding_reconciliation_attempts
          WHERE operation_id = $1`,
        [begun.entry.state.operationId],
      );
      expect(row.rows[0]?.count).toBe("0");
    });
    completedTestCount += 1;
  });

  test("allows later candidates through on the next pass while a poisoned head backs off", async () => {
    await withSchema(async (connection, admin) => {
      const first = await begin(connection, {
        nonce: "nonce_cross_tick_a",
        fundingPlan: plan("quote_cross_tick_a", "purchase_cross_tick_a"),
      });
      const second = await begin(connection, {
        nonce: "nonce_cross_tick_b",
        fundingPlan: plan("quote_cross_tick_b", "purchase_cross_tick_b"),
      });
      await markReconcilable(
        admin,
        first.begun.entry.state.operationId,
        `0x${"f0".repeat(32)}`,
        `0x${"f1".repeat(32)}`,
      );
      await markReconcilable(
        admin,
        second.begun.entry.state.operationId,
        `0x${"f2".repeat(32)}`,
        `0x${"f3".repeat(32)}`,
      );
      await admin.query(
        `UPDATE community_purchase_funding_journal
            SET updated_at = clock_timestamp() - INTERVAL '1 minute'
          WHERE operation_id = $1`,
        [first.begun.entry.state.operationId],
      );
      const layer = makeDirectPostgresControlPlaneLayer(connection);
      const query = makeControlPlaneCommunityPurchaseFundingQueryStore(layer);
      const attempts = makeControlPlaneCommunityPurchaseFundingAttemptStore(layer);
      expect(await run(query.listReconcilable({ limit: 1 }))).toEqual([
        {
          operationId: first.begun.entry.state.operationId,
          transactionHash: `0x${"f0".repeat(32)}`,
        },
      ]);
      const claim = await run(
        attempts.recordAttemptStart({
          operationId: first.begun.entry.state.operationId,
          reservationMs: 60_000,
        }),
      );
      expect(claim.kind).toBe("reserved");
      if (claim.kind !== "reserved") throw new Error("head claim unavailable");
      expect(
        await run(
          attempts.recordAttemptFailure({
            operationId: first.begun.entry.state.operationId,
            generation: claim.state.generation,
            failureClass: "chain_unavailable",
            retryDelayMs: 60 * 60 * 1_000,
            escalationThreshold: 12,
          }),
        ),
      ).toMatchObject({ kind: "finalized" });
      expect(await run(query.listReconcilable({ limit: 1 }))).toEqual([
        {
          operationId: second.begun.entry.state.operationId,
          transactionHash: `0x${"f2".repeat(32)}`,
        },
      ]);
    });
    completedTestCount += 1;
  });

  test("rejects terminal and hashless operations at the claim boundary", async () => {
    await withSchema(async (connection, admin) => {
      const hashless = await begin(connection, { nonce: "nonce_hashless_claim" });
      const terminal = await begin(connection, { nonce: "nonce_terminal_claim" });
      await markReconcilable(
        admin,
        terminal.begun.entry.state.operationId,
        `0x${"f4".repeat(32)}`,
        `0x${"f5".repeat(32)}`,
      );
      await admin.query(
        `UPDATE community_purchase_funding_journal
            SET state = 'confirmed', version = 3,
                snapshot = jsonb_set(jsonb_set(snapshot, '{state}', '"confirmed"'), '{version}', '3'),
                updated_at = clock_timestamp()
          WHERE operation_id = $1`,
        [terminal.begun.entry.state.operationId],
      );
      const attempts = makeControlPlaneCommunityPurchaseFundingAttemptStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      for (const operationId of [
        hashless.begun.entry.state.operationId,
        terminal.begun.entry.state.operationId,
      ]) {
        expect(
          await run(attempts.recordAttemptStart({ operationId, reservationMs: 60_000 })),
        ).toEqual({ kind: "unavailable" });
      }
      const row = await admin.query(
        `SELECT count(*) FROM community_purchase_funding_reconciliation_attempts
          WHERE operation_id IN ($1, $2)`,
        [hashless.begun.entry.state.operationId, terminal.begun.entry.state.operationId],
      );
      expect(row.rows[0]?.count).toBe("0");
    });
    completedTestCount += 1;
  });

  test("operator unpark resets once, records audit, and preserves claim fencing", async () => {
    await withSchema(async (connection, admin) => {
      const { begun } = await begin(connection, { nonce: "nonce_operator_unpark" });
      await markReconcilable(
        admin,
        begun.entry.state.operationId,
        `0x${"f6".repeat(32)}`,
        `0x${"f7".repeat(32)}`,
      );
      await admin.query(
        `INSERT INTO community_purchase_funding_reconciliation_attempts (
             operation_id, generation, finalized_generation, last_attempt_at,
             next_attempt_at, last_failure_class, consecutive_failures, escalated_at
           ) VALUES ($1, 7, 7, clock_timestamp(), clock_timestamp(), 'chain_timeout', 12, clock_timestamp())`,
        [begun.entry.state.operationId],
      );
      const layer = makeDirectPostgresControlPlaneLayer(connection);
      const operator = makeControlPlaneCommunityPurchaseFundingOperatorStore(layer);
      const attempts = makeControlPlaneCommunityPurchaseFundingAttemptStore(layer);
      const [first, second] = await Promise.all([
        run(
          operator.resetEscalatedAttempt({
            operationId: begun.entry.state.operationId,
            actorId: "operator-a",
            reason: "reviewed chain provider recovery",
          }),
        ),
        run(
          operator.resetEscalatedAttempt({
            operationId: begun.entry.state.operationId,
            actorId: "operator-b",
            reason: "concurrent duplicate reset",
          }),
        ),
      ]);
      expect([first.kind, second.kind].sort()).toEqual(["not-escalated", "reset"]);
      const row = await admin.query(
        `SELECT generation, finalized_generation, consecutive_failures,
                escalated_at, last_failure_class, next_attempt_at
           FROM community_purchase_funding_reconciliation_attempts
          WHERE operation_id = $1`,
        [begun.entry.state.operationId],
      );
      expect(row.rows[0]).toMatchObject({
        generation: "7",
        finalized_generation: "7",
        consecutive_failures: 0,
        escalated_at: null,
        last_failure_class: null,
      });
      expect(row.rows[0]?.next_attempt_at).not.toBeNull();
      const audit = await admin.query(
        `SELECT actor_id, action, reason, generation
           FROM community_purchase_funding_reconciliation_operator_actions
          WHERE operation_id = $1`,
        [begun.entry.state.operationId],
      );
      expect(audit.rows).toEqual([
        {
          actor_id: first.kind === "reset" ? "operator-a" : "operator-b",
          action: "unpark_escalated",
          reason:
            first.kind === "reset"
              ? "reviewed chain provider recovery"
              : "concurrent duplicate reset",
          generation: "7",
        },
      ]);
      const nextClaim = await run(
        attempts.recordAttemptStart({
          operationId: begun.entry.state.operationId,
          reservationMs: 60_000,
        }),
      );
      expect(nextClaim.kind).toBe("reserved");
      if (nextClaim.kind !== "reserved") throw new Error("unparked claim unavailable");
      expect(nextClaim.state.generation).toBe(8);
      expect(
        await run(
          attempts.recordAttemptSuccess({
            operationId: begun.entry.state.operationId,
            generation: nextClaim.state.generation,
          }),
        ),
      ).toMatchObject({ kind: "finalized" });
      expect(
        await run(
          operator.resetEscalatedAttempt({
            operationId: begun.entry.state.operationId,
            actorId: "operator-c",
            reason: "healthy row cannot be reset",
          }),
        ),
      ).toEqual({ kind: "not-escalated" });
    });
    completedTestCount += 1;
  });

  test("selects only due hash-bearing candidates and excludes the reserved one", async () => {
    await withSchema(async (connection, admin) => {
      const { begun } = await begin(connection, { nonce: "nonce_due_selection" });
      const operationId = begun.entry.state.operationId;
      const transactionHash = `0x${"ab".repeat(32)}` as `0x${string}`;
      const observationId = `0x${"cd".repeat(32)}`;
      await admin.query(
        `UPDATE community_purchase_funding_journal
            SET state = 'confirming', version = 2,
                snapshot = jsonb_set(jsonb_set(snapshot, '{state}', '"confirming"'), '{version}', '2'),
                funding_receipt_status = 'reverted',
                funding_transaction_hash = $2,
                funding_observation_id = $3,
                updated_at = clock_timestamp()
          WHERE operation_id = $1`,
        [operationId, transactionHash, observationId],
      );
      const query = makeControlPlaneCommunityPurchaseFundingQueryStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      expect(await run(query.listReconcilable({ limit: 10 }))).toEqual([
        { operationId, transactionHash },
      ]);
      const attempts = makeControlPlaneCommunityPurchaseFundingAttemptStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const reserved = await run(
        attempts.recordAttemptStart({ operationId, reservationMs: 60_000 }),
      );
      expect(reserved.kind).toBe("reserved");
      expect(await run(query.listReconcilable({ limit: 10 }))).toEqual([]);
    });
    completedTestCount += 1;
  });

  afterAll(async () => {
    if (connectionString !== undefined && completedTestCount === 24) {
      await Bun.write(sentinelPath, sentinelContents);
    }
  });
});
