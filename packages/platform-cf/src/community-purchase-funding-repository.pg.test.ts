import { afterAll, describe, expect, test } from "bun:test";
import {
  admitCommunityPurchaseFunding,
  makeCommunityPurchaseFundingExpiryUseCase,
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
  makeControlPlaneCommunityPurchaseFundingExpiryStore,
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

function expiryFor(connection: string) {
  return makeCommunityPurchaseFundingExpiryUseCase(
    interpreterFor(connection),
    makeControlPlaneCommunityPurchaseFundingExpiryStore(
      makeDirectPostgresControlPlaneLayer(connection),
    ),
  );
}

function queryFor(connection: string) {
  return makeControlPlaneCommunityPurchaseFundingQueryStore(
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

  test("parks a silent planned operation as legacy-ambiguous through the journal", async () => {
    await withSchema(async (connection, admin) => {
      await insertAdmissionPlan(admin, { shortLived: true });
      const admitted = await admit(connection);
      const operationId = admitted.entry.state.operationId;
      await Bun.sleep(2_100);
      const result = await run(
        expiryFor(connection)({
          operationId,
          ownerId: "worker_1",
          leaseMs: 30_000,
          source: "reconciler",
        }),
      );
      expect(result.kind).toBe("expired");
      const journal = await admin.query(
        `SELECT state, version, failure_tag, failure_reason,
                funding_transaction_hash, funding_log_index, funding_observation_id
           FROM community_purchase_funding_journal
          WHERE operation_id = $1`,
        [operationId],
      );
      expect(journal.rows[0]).toEqual({
        state: "reconciliation_required",
        version: "2",
        failure_tag: "legacy",
        failure_reason: "planned_observation_window_expired",
        funding_transaction_hash: null,
        funding_log_index: null,
        funding_observation_id: null,
      });
      const planRow = await admin.query(
        `SELECT status, operation_id FROM community_purchase_funding_plans
          WHERE quote_id = 'quote_admission'`,
      );
      expect(planRow.rows[0]).toEqual({ status: "bound", operation_id: operationId });
      const request = await admin.query(
        `SELECT status FROM community_purchase_funding_requests WHERE operation_id = $1`,
        [operationId],
      );
      expect(request.rows[0]).toEqual({ status: "reconciliation_required" });
      const transition = await admin.query(
        `SELECT source, event_type, observation_id, transaction_hash, log_index
           FROM community_purchase_funding_transitions
          WHERE operation_id = $1`,
        [operationId],
      );
      expect(transition.rows[0]).toEqual({
        source: "reconciler",
        event_type: "planned_observation_window_expired",
        observation_id: null,
        transaction_hash: null,
        log_index: null,
      });
    });
    completedTestCount += 1;
  });

  test("does not expire before the database-clock deadline", async () => {
    await withSchema(async (connection, admin) => {
      await insertAdmissionPlan(admin);
      const admitted = await admit(connection);
      const operationId = admitted.entry.state.operationId;
      const result = await run(
        expiryFor(connection)({
          operationId,
          ownerId: "worker_1",
          leaseMs: 30_000,
          source: "reconciler",
        }),
      );
      expect(result.kind).toBe("not_due");
      const journal = await admin.query(
        `SELECT state, version FROM community_purchase_funding_journal WHERE operation_id = $1`,
        [operationId],
      );
      expect(journal.rows[0]).toEqual({ state: "planned", version: "1" });
      const transitions = await admin.query(
        "SELECT count(*) FROM community_purchase_funding_transitions",
      );
      expect(transitions.rows[0]?.count).toBe("0");
    });
    completedTestCount += 1;
  });

  test("excludes a parked hashless operation from listReconcilable", async () => {
    await withSchema(async (connection, admin) => {
      await insertAdmissionPlan(admin, { shortLived: true });
      const admitted = await admit(connection);
      const parkedId = admitted.entry.state.operationId;
      const { interpreter, begun } = await begin(connection, {
        nonce: "nonce_2",
        fundingPlan: plan("quote_2", "purchase_2"),
      });
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
            evidence: { ...evidence(), observedHeadBlockNumber: 123 },
          },
        }),
      );
      await Bun.sleep(2_100);
      const expired = await run(
        expiryFor(connection)({
          operationId: parkedId,
          ownerId: "worker_1",
          leaseMs: 30_000,
          source: "reconciler",
        }),
      );
      expect(expired.kind).toBe("expired");
      const reconcilable = await run(queryFor(connection).listReconcilable({ limit: 10 }));
      expect(reconcilable.map((candidate) => candidate.operationId)).toEqual([
        begun.entry.state.operationId,
      ]);
    });
    completedTestCount += 1;
  });

  test("resolves a parked operation from later actor-supplied evidence", async () => {
    await withSchema(async (connection, admin) => {
      await insertAdmissionPlan(admin, { shortLived: true });
      const admitted = await admit(connection);
      const operationId = admitted.entry.state.operationId;
      await Bun.sleep(2_100);
      const expired = await run(
        expiryFor(connection)({
          operationId,
          ownerId: "worker_1",
          leaseMs: 30_000,
          source: "reconciler",
        }),
      );
      expect(expired.kind).toBe("expired");
      const interpreter = interpreterFor(connection);
      const lease = await run(
        interpreter.acquireLease({ operationId, ownerId: "worker_1", leaseMs: 60_000 }),
      );
      const resolved = await run(
        interpreter.transition({
          lease,
          source: "request",
          expectedVersion: 2,
          event: {
            type: "reconciliation_resolved",
            expectedVersion: 2,
            at: expired.entry.state.updatedAt + 1,
            evidence: evidence(),
          },
        }),
      );
      expect(resolved.entry.status).toBe("confirmed");
      const receipt = await admin.query(
        `SELECT transaction_hash, log_index FROM community_purchase_funding_receipts
          WHERE operation_id = $1`,
        [operationId],
      );
      expect(receipt.rows[0]).toEqual({
        transaction_hash: TRANSACTION_HASH,
        log_index: 4,
      });
    });
    completedTestCount += 1;
  });

  test("rolls back expiry when the transition cannot persist", async () => {
    await withSchema(async (connection, admin) => {
      await insertAdmissionPlan(admin, { shortLived: true });
      const admitted = await admit(connection);
      const operationId = admitted.entry.state.operationId;
      await admin.query(`
        CREATE FUNCTION fail_funding_expiry_transition() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'injected transition failure';
        END;
        $$;
        CREATE TRIGGER fail_funding_expiry_transition
        BEFORE INSERT ON community_purchase_funding_transitions
        FOR EACH ROW EXECUTE FUNCTION fail_funding_expiry_transition();
      `);
      await Bun.sleep(2_100);
      await expect(
        run(
          expiryFor(connection)({
            operationId,
            ownerId: "worker_1",
            leaseMs: 30_000,
            source: "reconciler",
          }),
        ),
      ).rejects.toMatchObject({ reason: "unavailable" });
      const journal = await admin.query(
        `SELECT state, version FROM community_purchase_funding_journal WHERE operation_id = $1`,
        [operationId],
      );
      expect(journal.rows[0]).toEqual({ state: "planned", version: "1" });
      const transitions = await admin.query(
        "SELECT count(*) FROM community_purchase_funding_transitions",
      );
      expect(transitions.rows[0]?.count).toBe("0");
      const planRow = await admin.query(
        `SELECT status, operation_id FROM community_purchase_funding_plans
          WHERE quote_id = 'quote_admission'`,
      );
      expect(planRow.rows[0]).toEqual({ status: "bound", operation_id: operationId });
    });
    completedTestCount += 1;
  });

  test("trigger accepts the planned expiry edge and rejects neighboring edges", async () => {
    await withSchema(async (connection, admin) => {
      const { interpreter, begun } = await begin(connection);
      const firstLease = await run(
        interpreter.acquireLease({
          operationId: begun.entry.state.operationId,
          ownerId: "worker_1",
          leaseMs: 60_000,
        }),
      );
      await run(
        interpreter.transition({
          lease: firstLease,
          source: "request",
          expectedVersion: 1,
          event: {
            type: "reclaimable_failure_recorded",
            expectedVersion: 1,
            at: 1_001,
            failure: { _tag: "reclaimable", mayRebroadcast: true, mayRetry: true },
            reason: "provider_unavailable_before_observation",
          },
        }),
      );
      await expect(
        admin.query(
          `UPDATE community_purchase_funding_journal
              SET state = 'reconciliation_required', version = 3,
                  updated_at = clock_timestamp()
            WHERE operation_id = $1`,
          [begun.entry.state.operationId],
        ),
      ).rejects.toThrow("journal transition is not allowed");

      const second = await begin(connection, {
        nonce: "nonce_2",
        fundingPlan: plan("quote_2", "purchase_2"),
      });
      const secondLease = await run(
        interpreter.acquireLease({
          operationId: second.begun.entry.state.operationId,
          ownerId: "worker_1",
          leaseMs: 60_000,
        }),
      );
      await run(
        interpreter.transition({
          lease: secondLease,
          source: "request",
          expectedVersion: 1,
          event: {
            type: "funding_evidence_observed",
            expectedVersion: 1,
            at: 1_001,
            evidence: { ...evidence(), observedHeadBlockNumber: 123 },
          },
        }),
      );
      await expect(
        admin.query(
          `UPDATE community_purchase_funding_journal
              SET state = 'reclaimable_failed', version = 3,
                  updated_at = clock_timestamp()
            WHERE operation_id = $1`,
          [second.begun.entry.state.operationId],
        ),
      ).rejects.toThrow("journal transition is not allowed");
    });
    completedTestCount += 1;
  });

  afterAll(async () => {
    if (connectionString !== undefined && completedTestCount === 17) {
      await Bun.write(sentinelPath, sentinelContents);
    }
  });
});
