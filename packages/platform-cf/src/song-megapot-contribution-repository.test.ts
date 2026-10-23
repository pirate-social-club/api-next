import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import { ControlPlaneDb, type ControlPlaneTransaction } from "../../application/src/ports.ts";
import {
  type ContributionState,
  digestFundingPreimageV2,
  SongContributionFailure,
} from "../../application/src/rewards/song-megapot-contributions.ts";
import * as C from "../../contracts/src/rewards-song-contributions-v2.ts";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresClientLike,
  type PostgresQueryConfig,
  type PostgresQueryResponse,
} from "./postgres.ts";
import {
  type FundingPrincipalEvidence,
  type FundingRecoveryEvidence,
  recoveryEvidencePreimage,
} from "./reward-funding-receipt-discovery.ts";
import {
  makeControlPlaneSongContributionPorts,
  makeControlPlaneSongContributionReadPorts,
  makeControlPlaneSongFundingRecoveryStore,
  persistRewardFundingPrincipalIn,
  withSongMegapotContributionTransaction,
} from "./song-megapot-contribution-repository.ts";

type Identity = Parameters<typeof withSongMegapotContributionTransaction>[0];
const identity: Identity = {
  accountId: "account_a",
  communityId: "community",
  postId: "song",
  contributionId: null,
  operation: "CreateSongMegapotContributionV2",
  key: "contribution_key_0001",
  hash: "a".repeat(64),
};
const principalProof: FundingPrincipalEvidence = {
  receiptId: "receipt",
  contributionId: "contribution",
  category: "pool_principal",
  evidence: {
    chain_id: 84532,
    transaction_hash: `0x${identity.hash}`,
    transfer_log_index: 0,
    sender_nonce: "4",
    block_number: "21",
    block_hash: `0x${identity.hash}`,
    block_timestamp: "2026-10-18T12:00:00.000Z",
    first_observed_at: "2026-10-18T12:01:00.000Z",
    finalized_at: "2026-10-18T12:02:00.000Z",
    actual_amount_atomic: "2000000",
    attestation_id: "attestation",
  },
  senderAddress: `0x${"11".repeat(20)}`,
  recipientAddress: `0x${"22".repeat(20)}`,
  tokenAddress: `0x${"33".repeat(20)}`,
  instructionHash: identity.hash,
  attestationHash: identity.hash,
  policyHash: identity.hash,
  checkpointBlock: "25",
  checkpointHash: `0x${identity.hash}`,
  observedConfirmedNonce: "5",
  exactInstruction: true,
};

const lockSql = "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))";
const marker = {
  label: "song-megapot-contribution.test.read",
  text: "SELECT $1::text AS marker",
  values: ["owned_command"],
  readonly: true,
} as const;
const empty = (): PostgresQueryResponse => ({ rows: [], rowCount: 0 });

/** In-memory driver only. No pg.Client/default factory, socket, server or schema.
 * The real accepted postgres.ts Layer/transaction/error lifecycle is exercised.
 */
class OfflineDriver implements PostgresClientLike {
  readonly queries: PostgresQueryConfig[] = [];
  readonly events: string[] = [];
  readonly pending = new Set<(e: unknown) => void>();
  onQuery: (query: PostgresQueryConfig) => Promise<PostgresQueryResponse> = async (q) =>
    q.text === marker.text ? { rows: [{ marker: q.values?.[0] }], rowCount: 1 } : empty();
  readonly connection = {
    stream: {
      destroy: () => {
        this.events.push("destroy");
        for (const reject of [...this.pending]) reject(new Error("offline driver destroyed"));
      },
    },
  };
  connect(): Promise<void> {
    this.events.push("connect");
    return Promise.resolve();
  }
  query(query: PostgresQueryConfig): Promise<PostgresQueryResponse> {
    this.queries.push(query);
    return this.onQuery(query);
  }
  end(): Promise<void> {
    this.events.push("end");
    return Promise.resolve();
  }
  hang(): Promise<PostgresQueryResponse> {
    return new Promise((_, reject) => {
      const fail = (error: unknown) => {
        this.pending.delete(fail);
        reject(error);
      };
      this.pending.add(fail);
    });
  }
}

function run<A, E>(
  program: Effect.Effect<A, E, ControlPlaneDb>,
  driver: OfflineDriver,
  timeout = 1000,
  signal?: AbortSignal,
) {
  return Effect.runPromiseExit(
    program.pipe(
      Effect.provide(
        makeDirectPostgresControlPlaneLayer("postgres://offline.invalid/unused", {
          clientFactory: () => driver, // Explicit injection: never create a real pg client.
          logger: { info: () => undefined, error: () => undefined },
          statementTimeoutMs: timeout,
        }),
      ),
    ),
    signal === undefined ? undefined : { signal },
  );
}
function failures<E>(exit: Exit.Exit<unknown, E>): readonly E[] {
  return Exit.isFailure(exit)
    ? exit.cause.reasons.filter(Cause.isFailReason).map((r) => r.error)
    : [];
}
const count = (driver: OfflineDriver, text: string) =>
  driver.queries.filter((q) => q.text === text).length;
const body = (transaction: ControlPlaneTransaction) =>
  transaction.execute<{ marker: string }>(marker);

describe("available funding SQL transaction boundary (offline driver)", () => {
  test("actual Jobs claim retains ambiguous COMMIT without a second lease/charge callback", async () => {
    const driver = new OfflineDriver();
    let allocations = 0;
    driver.onQuery = async (q) => {
      if (q.text.includes("claim_song_funding_work_v2")) {
        allocations++;
        return { rows: [{ packet: null }], rowCount: 1 };
      }
      if (q.text === "COMMIT") throw new Error("offline claim acknowledgement lost");
      return empty();
    };
    const store = makeControlPlaneSongFundingRecoveryStore(
      makeDirectPostgresControlPlaneLayer("postgres://offline.invalid/unused", {
        clientFactory: () => driver,
      }),
    );
    const exit = await Effect.runPromiseExit(store.claim("work", "lease"));
    expect(failures(exit)).toMatchObject([
      {
        code: "outcome_unknown",
        underlying: { _tag: "ControlPlaneTransactionOutcomeUnknown", phase: "commit" },
      },
    ]);
    expect(allocations).toBe(1);
    expect(count(driver, "COMMIT")).toBe(1);
  });
  test("snapshot recovery policy and permanent lease cannot establish current cancellation evidence", async () => {
    const driver = new OfflineDriver();
    const address = `0x${"11".repeat(20)}`;
    // This direct port test exercises only the immutable fields used by the
    // lease lookup; it does not create a contribution or grant authority.
    const state = {
      revision: 0,
      owner: { account_id: "account_a", persona_id: "persona", sender_address: address },
      receipt: {
        contribution_id: "contribution",
        command_id: "command",
        request_hash: identity.hash,
        reservation: { nonce_lease_id: "lease" },
        instruction: {
          chain_id: 84532,
          from: address,
          wallet_assignment_id: "wallet",
          nonce: "4",
          instruction_hash: identity.hash,
          attestation_id: "snapshot-attestation",
          attestation_hash: identity.hash,
        },
      },
    } as ContributionState;
    const snapshotPolicy = {
      object: "nonce_cancellation_recovery_policy" as const,
      version: "nonce-cancellation-recovery-v1" as const,
      policy_id: "old-snapshot-policy",
      policy_hash: identity.hash,
      chain_id: 84532 as const,
      valid_from: "2026-10-18T12:00:00.000Z",
      valid_until: "2026-10-19T12:00:00.000Z",
      dispatch_ttl_seconds: 180,
      max_preparations_per_contribution: 2,
      fee_policy_id: "test-fee",
      fee_policy_hash: identity.hash,
      attestation_contract_version: "test",
    };
    let currentEvidence: FundingRecoveryEvidence | null = null;
    for (const policy of [null, snapshotPolicy]) {
      driver.onQuery = async (q) => {
        if (q.text.includes("load_song_contribution_recovery_v2"))
          return {
            rows: [
              {
                packet: {
                  policy,
                  attestationId: "snapshot-attestation",
                  attestationHash: identity.hash,
                  attestationValidUntil: "2026-10-19T12:00:00.000Z",
                  originalWalletStillOwned: true,
                  currentSigningRefusal: null,
                  boundedWorkAvailable: true,
                  currentEvidence,
                },
              },
            ],
            rowCount: 1,
          };
        if (q.text.includes("to_char(clock_timestamp"))
          return { rows: [{ packet: "2026-10-18T12:00:00.000Z" }], rowCount: 1 };
        if (q.text.includes("load_reward_funding_wallet_nonce_owner_v2"))
          return {
            rows: [
              {
                lease_id: "lease",
                owner_id: "contribution",
                command_id: "command",
                account_id: "account_a",
                persona_id: "persona",
                wallet_assignment_id: "wallet",
                chain_id: "84532",
                sender_address: address,
                request_hash: identity.hash,
                nonce: "4",
              },
            ],
            rowCount: 1,
          };
        return empty();
      };
      const ports = makeControlPlaneSongContributionPorts(
        makeDirectPostgresControlPlaneLayer("postgres://offline.invalid/unused", {
          clientFactory: () => driver,
        }),
        { authorize: () => Effect.succeed({ accountId: identity.accountId }) },
        { rewardsEnabled: true },
      );
      const authority = await Effect.runPromise(
        ports.transaction(
          {
            ...identity,
            operation: "PrepareSongMegapotContributionCancellationV2",
            contributionId: "contribution",
          },
          (tx) => tx.recoveryAuthority(state),
        ),
      );
      expect(authority.originalWalletStillOwned).toBe(true);
      expect(authority.attestationValidUntil).toBe("2026-10-19T12:00:00.000Z");
      expect(authority.policy).toBeNull();
      if (policy !== null) {
        const raw = {
          kind: "cancellation_recovery_v2" as const,
          contributionId: "contribution",
          stateRevision: 0,
          profileId: "profile",
          profileHash: identity.hash,
          policyHash: identity.hash,
          instructionHash: identity.hash,
          attestationId: "snapshot-attestation",
          attestationHash: identity.hash,
          chainId: 84532 as const,
          sender: address,
          walletAssignmentId: "wallet",
          token: `0x${"22".repeat(20)}`,
          custody: `0x${"33".repeat(20)}`,
          observedAt: "2026-10-18T12:00:00.000Z",
          validUntil: "2026-10-18T12:01:00.000Z",
          noncePolicyHash: identity.hash,
          blockNumber: "20",
          blockHash: `0x${identity.hash}`,
          blockTimestamp: "2026-10-18T12:00:00.000Z",
          confirmedNonce: "4",
          pendingNonce: "4",
        };
        currentEvidence = {
          ...raw,
          witnessHash: await Effect.runPromise(
            digestFundingPreimageV2(recoveryEvidencePreimage(raw)),
          ),
        };
        const read = () =>
          Effect.runPromise(
            ports.transaction(
              {
                ...identity,
                operation: "PrepareSongMegapotContributionCancellationV2",
                contributionId: "contribution",
              },
              (tx) => tx.recoveryAuthority(state),
            ),
          );
        expect((await read()).policy).toEqual(policy);
        currentEvidence = { ...currentEvidence, witnessHash: "f".repeat(64) };
        expect((await read()).policy).toBeNull();
        currentEvidence = null;
        expect((await read()).policy).toBeNull();
      }
    }
    expect(
      driver.queries.some((q) => q.text.includes("reserve_reward_funding_wallet_nonce_v2")),
    ).toBe(false);
  });
  test("principal persistence rejects every missing/null/mistyped required field before SQL", async () => {
    const proof = principalProof;
    const driver = new OfflineDriver();
    const persist = (input: unknown) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((tx) =>
            persistRewardFundingPrincipalIn(tx, input as FundingPrincipalEvidence),
          );
        }),
        driver,
      );
    for (const [nested, fields] of [
      [false, Object.keys(proof)],
      [true, Object.keys(proof.evidence)],
    ] as const) {
      for (const field of fields) {
        for (const variant of ["missing", "null", "wrong_type"]) {
          const input = structuredClone(proof);
          const object = (nested ? input.evidence : input) as Record<string, unknown>;
          if (variant === "missing") delete object[field];
          else
            object[field] =
              variant === "null" ? null : typeof object[field] === "string" ? 1 : "wrong-type";
          const exit = await persist(input);
          expect(failures(exit)).toMatchObject([{ code: "receipt_mismatch" }]);
        }
      }
    }
    expect(driver.queries.some((q) => q.text.includes("accept_reward_funding_principal_v2"))).toBe(
      false,
    );
    expect(Exit.isSuccess(await persist(proof))).toBe(true);
    const writes = driver.queries.filter((q) =>
      q.text.includes("accept_reward_funding_principal_v2"),
    );
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0]?.values?.[0]))).toEqual(proof);
  });
  test("actual persistence port loads immutable private receipts without fresh business guards", async () => {
    const driver = new OfflineDriver();
    const receipt = {
      object: "contribution_observation_command_receipt",
      version: 2,
      command_id: "command",
      request_hash: identity.hash,
      contribution_id: "contribution",
      accepted_candidate_hash: `0x${"ab".repeat(32)}`,
      current_state_href: "/communities/community/posts/song/megapot-contributions/contribution",
    } as const;
    driver.onQuery = async (q) =>
      q.text.includes("load_song_contribution_command_v2")
        ? { rows: [{ packet: { requestHash: identity.hash, receipt } }], rowCount: 1 }
        : empty();
    const ports = makeControlPlaneSongContributionPorts(
      makeDirectPostgresControlPlaneLayer("postgres://offline.invalid/unused", {
        clientFactory: () => driver,
      }),
      { authorize: () => Effect.succeed({ accountId: identity.accountId }) },
      { rewardsEnabled: true },
    );
    const loaded = await Effect.runPromise(
      ports.lookup({
        ...identity,
        operation: "ObserveSongMegapotContributionV2",
        contributionId: "contribution",
      }),
    );
    expect(loaded?.receipt).toEqual(receipt);
    expect(driver.queries.some((q) => q.text.includes("lock_song_contribution_context_v2"))).toBe(
      false,
    );
    expect(count(driver, "BEGIN")).toBe(0);
  });
  test("actual persistence port retains an unknown COMMIT phase and never replays its callback", async () => {
    const driver = new OfflineDriver();
    let callbacks = 0;
    driver.onQuery = async (q) => {
      if (q.text === "COMMIT") throw new Error("offline commit acknowledgement lost");
      if (q.text.includes("load_song_contribution_command_v2"))
        return { rows: [{ packet: null }], rowCount: 1 };
      return empty();
    };
    const ports = makeControlPlaneSongContributionPorts(
      makeDirectPostgresControlPlaneLayer("postgres://offline.invalid/unused", {
        clientFactory: () => driver,
      }),
      { authorize: () => Effect.succeed({ accountId: identity.accountId }) },
      { rewardsEnabled: true },
    );
    const exit = await Effect.runPromiseExit(
      ports.transaction(identity, (tx) => {
        callbacks++;
        return tx.lookup();
      }),
    );
    expect(failures(exit)).toMatchObject([
      {
        code: "outcome_unknown",
        underlying: { _tag: "ControlPlaneTransactionOutcomeUnknown", phase: "commit" },
      },
    ]);
    expect(callbacks).toBe(1);
    expect(count(driver, "COMMIT")).toBe(1);
  });
  test("SQL read errors are retained, not converted into a confirmed command miss", async () => {
    const driver = new OfflineDriver();
    driver.onQuery = async (q) => {
      if (q.text.includes("load_song_contribution_command_v2"))
        throw new Error("offline read failed");
      return empty();
    };
    const ports = makeControlPlaneSongContributionPorts(
      makeDirectPostgresControlPlaneLayer("postgres://offline.invalid/unused", {
        clientFactory: () => driver,
      }),
      { authorize: () => Effect.succeed({ accountId: identity.accountId }) },
      { rewardsEnabled: true },
    );
    const exit = await Effect.runPromiseExit(ports.lookup(identity));
    expect(failures(exit)).toMatchObject([
      { code: "outcome_unknown", underlying: { _tag: "ControlPlaneStatementFailed" } },
    ]);
    expect(
      driver.queries.filter((q) => q.text.includes("load_song_contribution_command_v2")),
    ).toHaveLength(1);
  });
  test("uses one real accepted transaction, locks before callback queries, commits before returning", async () => {
    const driver = new OfflineDriver();
    let calls = 0;
    let committed = false;
    const query = driver.onQuery;
    driver.onQuery = async (q) => {
      if (q.text === "COMMIT") committed = true;
      return query(q);
    };
    const exit = await run(
      withSongMegapotContributionTransaction(identity, (tx) =>
        Effect.gen(function* () {
          calls++;
          expect(committed).toBe(false);
          return yield* body(tx);
        }),
      ),
      driver,
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.rows).toEqual([{ marker: "owned_command" }]);
    expect(committed).toBe(true);
    expect(calls).toBe(1);
    expect(count(driver, "BEGIN")).toBe(1);
    expect(count(driver, "COMMIT")).toBe(1);
    expect(count(driver, "ROLLBACK")).toBe(0);
    const texts = driver.queries.map((q) => q.text);
    expect(texts.indexOf(lockSql)).toBeLessThan(texts.indexOf(marker.text));
    expect(texts.indexOf(marker.text)).toBeLessThan(texts.indexOf("COMMIT"));
    expect(driver.events).toEqual(["connect", "end"]);
  });
  test("same account/operation/key keeps the same lock across body hash and path conflicts", async () => {
    const values: unknown[] = [];
    for (const i of [
      identity,
      { ...identity, communityId: "other_community", postId: "other_song", hash: "b".repeat(64) },
    ]) {
      const driver = new OfflineDriver();
      const exit = await run(
        withSongMegapotContributionTransaction(i, () => Effect.void),
        driver,
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      values.push(driver.queries.find((q) => q.text === lockSql)?.values);
    }
    expect(values[0]).toEqual(values[1]);
    expect(values[0]).toEqual([
      JSON.stringify([
        "song-megapot-contribution-command-v2",
        identity.accountId,
        identity.operation,
        identity.key,
      ]),
    ]);
  });
  test("account, operation and key are distinct namespaces; identities remain parameterized", async () => {
    const keys = new Set<string>();
    for (const i of [
      identity,
      { ...identity, accountId: "κοινότητα 'quoted'" },
      { ...identity, key: "another_command_key_01" },
      {
        ...identity,
        operation: "ObserveSongMegapotContributionV2" as const,
        contributionId: "contribution",
      },
    ]) {
      const driver = new OfflineDriver();
      expect(
        Exit.isSuccess(
          await run(
            withSongMegapotContributionTransaction(i, () => Effect.void),
            driver,
          ),
        ),
      ).toBe(true);
      const lock = driver.queries.find((q) => q.text === lockSql);
      expect(lock?.text).toBe(lockSql);
      expect(lock?.text).not.toContain(i.accountId);
      keys.add(JSON.stringify(lock?.values));
    }
    expect(keys.size).toBe(4);
  });
  test("invalid command identities refuse before invoking the database boundary", async () => {
    let starts = 0;
    let calls = 0;
    const db: ControlPlaneDb["Service"] = {
      execute: () => Effect.die("unexpected standalone execute"),
      withTransaction: () => {
        starts++;
        return Effect.die("unexpected transaction");
      },
    };
    for (const i of [
      { ...identity, contributionId: "unexpected" },
      { ...identity, key: "short" },
      { ...identity, hash: "invalid" },
      { ...identity, accountId: "" },
      { ...identity, extra: "undeclared" },
    ]) {
      const exit = await Effect.runPromiseExit(
        withSongMegapotContributionTransaction(i, () =>
          Effect.sync(() => {
            calls++;
          }),
        ).pipe(Effect.provideService(ControlPlaneDb, db)),
      );
      expect(failures(exit)).toMatchObject([{ code: "invalid_request" }]);
    }
    expect(starts).toBe(0);
    expect(calls).toBe(0);
  });
  test("BEGIN or command lock failure never invokes the callback or retries", async () => {
    for (const failed of ["BEGIN", lockSql]) {
      const driver = new OfflineDriver();
      let calls = 0;
      driver.onQuery = async (q) => {
        if (q.text === failed)
          throw Object.assign(new Error("private driver detail"), { code: "40001" });
        return empty();
      };
      const exit = await run(
        withSongMegapotContributionTransaction(identity, () =>
          Effect.sync(() => {
            calls++;
          }),
        ),
        driver,
      );
      expect(calls).toBe(0);
      expect(count(driver, failed)).toBe(1);
      expect(count(driver, "COMMIT")).toBe(0);
      expect(failures(exit)).toMatchObject([
        { _tag: "ControlPlaneStatementFailed", sqlState: "40001" },
      ]);
      expect(JSON.stringify(failures(exit))).not.toContain("private driver detail");
      expect(driver.events.at(-1)).toBe("end");
    }
  });
  test("unknown receipt-read failure remains a typed failure, never a miss or replay trigger", async () => {
    const driver = new OfflineDriver();
    let calls = 0;
    driver.onQuery = async (q) => {
      if (q.text === marker.text) throw new Error("unavailable read");
      return empty();
    };
    const exit = await run(
      withSongMegapotContributionTransaction(identity, (tx) =>
        Effect.gen(function* () {
          calls++;
          return yield* body(tx);
        }),
      ),
      driver,
    );
    expect(failures(exit)).toMatchObject([
      { _tag: "ControlPlaneStatementFailed", outcomeCertainty: "unknown", label: marker.label },
    ]);
    expect(calls).toBe(1);
    expect(count(driver, marker.text)).toBe(1);
    expect(count(driver, "ROLLBACK")).toBe(1);
    expect(count(driver, "COMMIT")).toBe(0);
  });
  test("successful callback is not returned after ambiguous COMMIT, regardless of possible application", async () => {
    for (const couldHaveApplied of [false, true]) {
      const driver = new OfflineDriver();
      let calls = 0;
      let applied = false;
      driver.onQuery = async (q) => {
        if (q.text === "COMMIT") {
          applied = couldHaveApplied;
          throw new Error("lost acknowledgement");
        }
        return empty();
      };
      const exit = await run(
        withSongMegapotContributionTransaction(identity, () =>
          Effect.sync(() => {
            calls++;
            return "not an acknowledged result";
          }),
        ),
        driver,
      );
      expect(failures(exit)).toMatchObject([
        { _tag: "ControlPlaneTransactionOutcomeUnknown", phase: "commit" },
      ]);
      expect(applied).toBe(couldHaveApplied);
      expect(calls).toBe(1);
      expect(count(driver, "COMMIT")).toBe(1);
      expect(count(driver, "BEGIN")).toBe(1);
      expect(count(driver, "ROLLBACK")).toBe(0);
      expect(driver.events.at(-1)).toBe("end");
    }
  });
  test("original application refusal is retained by identity after known rollback", async () => {
    const driver = new OfflineDriver();
    const refusal = new SongContributionFailure({ code: "idempotency_conflict" });
    let calls = 0;
    const exit = await run(
      withSongMegapotContributionTransaction(identity, () =>
        Effect.gen(function* () {
          calls++;
          return yield* Effect.fail(refusal);
        }),
      ),
      driver,
    );
    expect(failures(exit)).toEqual([refusal]);
    expect(failures(exit)[0]).toBe(refusal);
    expect(calls).toBe(1);
    expect(count(driver, "ROLLBACK")).toBe(1);
    expect(count(driver, "COMMIT")).toBe(0);
  });
  test("rollback uncertainty does not replace the original business error or erase its own uncertainty", async () => {
    const driver = new OfflineDriver();
    const original = new SongContributionFailure({ code: "policy_unavailable" });
    let calls = 0;
    driver.onQuery = async (q) => {
      if (q.text === "ROLLBACK") throw new Error("lost rollback reply");
      return empty();
    };
    const exit = await run(
      withSongMegapotContributionTransaction(identity, () =>
        Effect.gen(function* () {
          calls++;
          return yield* Effect.fail(original);
        }),
      ),
      driver,
    );
    const errors = failures(exit);
    expect(errors).toContain(original);
    expect(
      errors.some(
        (e) => e._tag === "ControlPlaneTransactionOutcomeUnknown" && e.phase === "rollback",
      ),
    ).toBe(true);
    expect(calls).toBe(1);
    expect(count(driver, "ROLLBACK")).toBe(1);
    expect(count(driver, "COMMIT")).toBe(0);
  });
  test("callback defects stay defects, including undefined, rather than becoming ordinary refusals", async () => {
    for (const defect of [undefined, new Error("callback defect")]) {
      const driver = new OfflineDriver();
      let calls = 0;
      const exit = await run(
        withSongMegapotContributionTransaction(identity, () =>
          Effect.gen(function* () {
            calls++;
            return yield* Effect.die(defect);
          }),
        ),
        driver,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(exit.cause.reasons.some((r) => Cause.isDieReason(r) && r.defect === defect)).toBe(
          true,
        );
      expect(calls).toBe(1);
      expect(count(driver, "ROLLBACK")).toBe(1);
      expect(count(driver, "COMMIT")).toBe(0);
    }
  });
  test("rollback failure preserves an undefined callback defect alongside typed uncertainty", async () => {
    const driver = new OfflineDriver();
    let calls = 0;
    driver.onQuery = async (q) => {
      if (q.text === "ROLLBACK") throw new Error("lost rollback reply");
      return empty();
    };
    const exit = await run(
      withSongMegapotContributionTransaction(identity, () =>
        Effect.gen(function* () {
          calls++;
          return yield* Effect.die(undefined);
        }),
      ),
      driver,
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit))
      expect(exit.cause.reasons.some((r) => Cause.isDieReason(r) && r.defect === undefined)).toBe(
        true,
      );
    expect(failures(exit)).toMatchObject([
      { _tag: "ControlPlaneTransactionOutcomeUnknown", phase: "rollback" },
    ]);
    expect(calls).toBe(1);
    expect(count(driver, "ROLLBACK")).toBe(1);
  });
  test("read failure and rollback failure both survive without an implicit receipt miss", async () => {
    const driver = new OfflineDriver();
    let calls = 0;
    driver.onQuery = async (q) => {
      if (q.text === marker.text || q.text === "ROLLBACK") throw new Error("unavailable");
      return empty();
    };
    const exit = await run(
      withSongMegapotContributionTransaction(identity, (tx) =>
        Effect.gen(function* () {
          calls++;
          return yield* body(tx);
        }),
      ),
      driver,
    );
    expect(failures(exit)).toMatchObject([
      { _tag: "ControlPlaneStatementFailed", label: marker.label, outcomeCertainty: "unknown" },
      { _tag: "ControlPlaneTransactionOutcomeUnknown", phase: "rollback" },
    ]);
    expect(calls).toBe(1);
    expect(count(driver, marker.text)).toBe(1);
    expect(count(driver, "ROLLBACK")).toBe(1);
  });
  test("read and COMMIT timeout never replay the callback and close all fake pending work", async () => {
    for (const stalled of [marker.text, "COMMIT"]) {
      const driver = new OfflineDriver();
      let calls = 0;
      const ordinary = driver.onQuery;
      driver.onQuery = (q) => (q.text === stalled ? driver.hang() : ordinary(q));
      const exit = await run(
        withSongMegapotContributionTransaction(identity, (tx) =>
          Effect.gen(function* () {
            calls++;
            return yield* body(tx);
          }),
        ),
        driver,
        20,
      );
      expect(calls).toBe(1);
      expect(count(driver, stalled)).toBe(1);
      expect(driver.pending.size).toBe(0);
      expect(driver.events).toContain("destroy");
      expect(driver.events.at(-1)).toBe("end");
      if (stalled === "COMMIT")
        expect(failures(exit)).toMatchObject([
          { _tag: "ControlPlaneTransactionOutcomeUnknown", phase: "commit" },
        ]);
      else
        expect(failures(exit)).toMatchObject([
          { _tag: "ControlPlaneOperationTimedOut", label: marker.label },
        ]);
    }
  });
  test("the boundary preserves a callback's original immutable replay value without issuing authority", async () => {
    const driver = new OfflineDriver();
    let calls = 0;
    // Callback stands in ONLY for a future owned receipt lookup. No table/read is implemented here.
    const replay = Object.freeze({
      receipt: Object.freeze({ command_id: "original_command", request_hash: identity.hash }),
      delivery: Object.freeze({ kind: "recovery_only", replayed: true }),
    });
    const exit = await run(
      withSongMegapotContributionTransaction(identity, () =>
        Effect.sync(() => {
          calls++;
          return replay;
        }),
      ),
      driver,
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toBe(replay);
    expect(calls).toBe(1);
    expect(count(driver, "COMMIT")).toBe(1);
  });
  test("request interruption is not converted to success, a miss or a callback retry", async () => {
    const driver = new OfflineDriver();
    const controller = new AbortController();
    let calls = 0;
    let notifyStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const ordinary = driver.onQuery;
    driver.onQuery = (q) => {
      if (q.text === marker.text) {
        notifyStarted();
        return driver.hang();
      }
      return ordinary(q);
    };
    const completion = run(
      withSongMegapotContributionTransaction(identity, (tx) =>
        Effect.gen(function* () {
          calls++;
          return yield* body(tx);
        }),
      ),
      driver,
      1000,
      controller.signal,
    );
    await started;
    controller.abort();
    const exit = await completion;
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(calls).toBe(1);
    expect(count(driver, marker.text)).toBe(1);
    expect(count(driver, "COMMIT")).toBe(0);
    expect(driver.pending.size).toBe(0);
    expect(driver.events.at(-1)).toBe("end");
  });
  for (const callback of ["success", "refusal", "undefined defect"] as const) {
    test(`cancellation during acknowledged ${callback === "success" ? "COMMIT" : "ROLLBACK"} retains ${callback} without inventing uncertainty`, async () => {
      const driver = new OfflineDriver();
      const controller = new AbortController();
      const original = new SongContributionFailure({ code: "policy_unavailable" });
      const sql = callback === "success" ? "COMMIT" : "ROLLBACK";
      let calls = 0;
      let notifyStarted: () => void = () => {};
      let acknowledge: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      const reply = new Promise<PostgresQueryResponse>((resolve) => {
        acknowledge = () => resolve(empty());
      });
      const ordinary = driver.onQuery;
      driver.onQuery = (q) => {
        if (q.text === sql) {
          notifyStarted();
          return reply;
        }
        return ordinary(q);
      };
      const completion = run(
        withSongMegapotContributionTransaction(identity, () =>
          Effect.gen(function* () {
            calls++;
            if (callback === "refusal") return yield* Effect.fail(original);
            if (callback === "undefined defect") return yield* Effect.die(undefined);
            return "committed but request canceled";
          }),
        ),
        driver,
        1000,
        controller.signal,
      );
      await started;
      controller.abort();
      acknowledge();
      const exit = await completion;
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        if (callback === "undefined defect")
          expect(
            exit.cause.reasons.some((r) => Cause.isDieReason(r) && r.defect === undefined),
          ).toBe(true);
      }
      expect(failures(exit)).toEqual(callback === "refusal" ? [original] : []);
      if (callback === "refusal") expect(failures(exit)[0]).toBe(original);
      expect(calls).toBe(1);
      expect(count(driver, "BEGIN")).toBe(1);
      expect(count(driver, sql)).toBe(1);
      expect(count(driver, sql === "COMMIT" ? "ROLLBACK" : "COMMIT")).toBe(0);
      expect(driver.events).toEqual(["connect", "end"]);
    });
    for (const releaseFailure of ["rejection", "timeout"] as const) {
      test(`external cancellation during ${callback === "success" ? "COMMIT" : "ROLLBACK"} ${releaseFailure} retains ${callback} and release uncertainty`, async () => {
        const driver = new OfflineDriver();
        const controller = new AbortController();
        const original = new SongContributionFailure({ code: "policy_unavailable" });
        const phase = callback === "success" ? "commit" : "rollback";
        const sql = phase === "commit" ? "COMMIT" : "ROLLBACK";
        let calls = 0;
        let notifyStarted: () => void = () => {};
        const started = new Promise<void>((resolve) => {
          notifyStarted = resolve;
        });
        const ordinary = driver.onQuery;
        driver.onQuery = (q) => {
          if (q.text === sql) {
            const pending = driver.hang();
            notifyStarted();
            return pending;
          }
          return ordinary(q);
        };
        const completion = run(
          withSongMegapotContributionTransaction(identity, () =>
            Effect.gen(function* () {
              calls++;
              if (callback === "refusal") return yield* Effect.fail(original);
              if (callback === "undefined defect") return yield* Effect.die(undefined);
              return "not an acknowledged commit";
            }),
          ),
          driver,
          releaseFailure === "timeout" ? 20 : 1000,
          controller.signal,
        );
        // The callback has finished and release is actually pending before cancellation.
        await started;
        expect(driver.pending.size).toBe(1);
        controller.abort();
        if (releaseFailure === "rejection") {
          for (const reject of [...driver.pending]) reject(new Error("lost release reply"));
        }
        const exit = await completion;
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterrupts(exit.cause), JSON.stringify(exit.cause)).toBe(true);
          if (callback === "undefined defect")
            expect(
              exit.cause.reasons.some((r) => Cause.isDieReason(r) && r.defect === undefined),
            ).toBe(true);
        }
        const errors = failures(exit);
        if (callback === "refusal") expect(errors).toContain(original);
        expect(
          errors.some(
            (e) =>
              e._tag === "ControlPlaneTransactionOutcomeUnknown" &&
              e.phase === phase &&
              e.label === `control-plane.transaction.${phase}`,
          ),
        ).toBe(true);
        expect(calls).toBe(1);
        expect(count(driver, "BEGIN")).toBe(1);
        expect(count(driver, sql)).toBe(1);
        expect(count(driver, phase === "commit" ? "ROLLBACK" : "COMMIT")).toBe(0);
        expect(driver.pending.size).toBe(0);
        if (releaseFailure === "timeout") expect(driver.events).toContain("destroy");
        expect(driver.events.filter((event) => event === "end")).toHaveLength(1);
        expect(driver.events.at(-1)).toBe("end");
      });
    }
  }
  test("a callback with no SQL can still be externally canceled and rolled back once", async () => {
    const driver = new OfflineDriver();
    const controller = new AbortController();
    let calls = 0;
    let notifyStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const completion = run(
      withSongMegapotContributionTransaction(identity, () =>
        Effect.gen(function* () {
          calls++;
          yield* Effect.sync(notifyStarted);
          return yield* Effect.never;
        }),
      ),
      driver,
      1000,
      controller.signal,
    );
    await started;
    controller.abort();
    const exit = await completion;
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(failures(exit)).toEqual([]);
    expect(calls).toBe(1);
    expect(count(driver, "BEGIN")).toBe(1);
    expect(count(driver, marker.text)).toBe(0);
    expect(count(driver, "COMMIT")).toBe(0);
    expect(count(driver, "ROLLBACK")).toBe(1);
    expect(driver.events).toEqual(["connect", "end"]);
  });
});

describe("actual private V5 SQL read and feature boundaries (offline driver)", () => {
  test("uses only narrow own-scope read functions and never allocates or starts a transaction", async () => {
    const driver = new OfflineDriver();
    driver.onQuery = async (q) =>
      q.text.includes("read_owned_song_contribution_current_v2")
        ? { rows: [{ packet: null }], rowCount: 1 }
        : q.text.includes("read_song_contribution_command_v2")
          ? { rows: [{ packet: { immutable: "fixture evidence" } }], rowCount: 1 }
          : empty();
    const authorization = { authorize: () => Effect.succeed({ accountId: identity.accountId }) };
    const reads = makeControlPlaneSongContributionReadPorts(
      makeDirectPostgresControlPlaneLayer("postgres://offline.invalid/unused", {
        clientFactory: () => driver,
      }),
      authorization,
      { rewardsEnabled: false },
    );
    const scope = { communityId: "community", postId: "song", contributionId: "original" };
    expect(await Effect.runPromise(reads.current(scope, identity.accountId))).toBeNull();
    expect(
      await Effect.runPromise(
        reads.command(scope, identity.accountId, "RecoverSongMegapotContributionV2", identity.key),
      ),
    ).toEqual({ immutable: "fixture evidence" });
    const queries = driver.queries.filter((q) => q.text.includes("read_"));
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(JSON.parse(String(query.values?.[0]))).toEqual({
        ...scope,
        accountId: identity.accountId,
      });
    }
    expect(count(driver, "BEGIN")).toBe(0);
    expect(
      driver.queries.some((q) =>
        /INSERT|UPDATE|pg_advisory|create_song|enqueue_song/iu.test(q.text),
      ),
    ).toBe(false);
  });
  test("an unknown read cannot become a404 or a null receipt", async () => {
    for (const mode of ["error", "missing_row", "missing_packet"] as const) {
      const driver = new OfflineDriver();
      driver.onQuery = async (q) => {
        if (!q.text.includes("read_song_contribution_command_v2")) return empty();
        if (mode === "error") throw new Error("injected private read uncertainty");
        return mode === "missing_row" ? empty() : { rows: [{}], rowCount: 1 };
      };
      const reads = makeControlPlaneSongContributionReadPorts(
        makeDirectPostgresControlPlaneLayer("postgres://offline.invalid/unused", {
          clientFactory: () => driver,
        }),
        { authorize: () => Effect.succeed({ accountId: identity.accountId }) },
        { rewardsEnabled: false },
      );
      await expect(
        Effect.runPromise(
          reads.command(
            identity,
            identity.accountId,
            "RecoverSongMegapotContributionV2",
            identity.key,
          ),
        ),
      ).rejects.toMatchObject({ code: "outcome_unknown" });
      expect(count(driver, "BEGIN")).toBe(0);
    }
  });
  test("feature-off refuses new funding inside the locked true-miss path before touching financial admission", async () => {
    const driver = new OfflineDriver();
    const ports = makeControlPlaneSongContributionPorts(
      makeDirectPostgresControlPlaneLayer("postgres://offline.invalid/unused", {
        clientFactory: () => driver,
      }),
      { authorize: () => Effect.succeed({ accountId: identity.accountId }) },
      { rewardsEnabled: false },
    );
    const request = C.decodeFundingCommandV2("CreateSongMegapotContributionV2", {
      version: 2,
      idempotency_key: identity.key,
      persona_id: "persona",
      funding_amount_atomic: "1",
      expected_context_hash: "a".repeat(64),
      expected_lifecycle_revision: 0,
      context_version: "funding-context-reference-v1",
      context_slot_id: "slot",
      context_slot_generation: 0,
      context_leg_snapshot_id: "",
      context_schedule_witness_id: "witness",
      context_profile_id: "profile",
      context_profile_hash: "b".repeat(64),
      context_funding_policy_hash: "c".repeat(64),
      context_wallet_assignment_id: "wallet",
      context_wallet_assignment_revision: 1,
      context_lifecycle_revision: 0,
      expected_terms_kind: "prospective",
      expected_terms_hash: "d".repeat(64),
    });
    await expect(
      Effect.runPromise(ports.transaction(identity, (tx) => tx.fundingAdmission(request))),
    ).rejects.toMatchObject({ code: "paused" });
    expect(driver.queries.some((q) => q.text.includes("lock_song_contribution_context_v2"))).toBe(
      false,
    );
    expect(
      driver.queries.some((q) => q.text.includes("reserve_reward_funding_wallet_nonce_v2")),
    ).toBe(false);
  });
});

describe("shared durable observer principal boundary (offline driver)", () => {
  test("stale work is refused before principal write; unknown COMMIT is retained with no callback retry", async () => {
    for (const mode of ["success", "stale_lease", "unknown_commit"] as const) {
      const driver = new OfflineDriver();
      driver.onQuery = async (q) => {
        if (mode === "stale_lease" && q.text.includes("require_song_funding_work_lease_v2"))
          throw Object.assign(new Error("fixture fenced lease"), { code: "PCV06" });
        if (mode === "unknown_commit" && q.text === "COMMIT")
          throw new Error("fixture lost COMMIT acknowledgement");
        return empty();
      };
      const store = makeControlPlaneSongFundingRecoveryStore(
        makeDirectPostgresControlPlaneLayer("postgres://offline.invalid/unused", {
          clientFactory: () => driver,
        }),
      );
      // Only immutable work/command identity is read by this persistence port.
      const work = { workId: "owned-work", token: "owned-token", identity } as Parameters<
        typeof store.accept
      >[0];
      const exit = await Effect.runPromiseExit(store.accept(work, principalProof));
      const fence = driver.queries.findIndex((q) =>
        q.text.includes("require_song_funding_work_lease_v2"),
      );
      const writes = driver.queries.filter((q) =>
        q.text.includes("accept_reward_funding_principal_v2"),
      );
      expect(fence).toBeGreaterThan(-1);
      if (mode === "stale_lease") {
        expect(writes).toEqual([]);
        expect(failures(exit)).toMatchObject([{ code: "lifecycle_changed" }]);
      } else {
        expect(writes).toHaveLength(1);
        expect(driver.queries.indexOf(writes[0]!)).toBeGreaterThan(fence);
        if (mode === "success") expect(Exit.isSuccess(exit)).toBe(true);
        else expect(failures(exit)).toMatchObject([{ code: "outcome_unknown" }]);
      }
      expect(count(driver, "BEGIN")).toBe(1);
      expect(count(driver, "COMMIT")).toBe(mode === "stale_lease" ? 0 : 1);
    }
  });
});

describe("durable original Create refusal (offline transaction driver)", () => {
  const receipt = {
    command_id: "refused-command",
    request_hash: identity.hash,
    allocation: "none",
    instruction_issued: false,
  } as const;
  const packet = {
    accountId: identity.accountId,
    communityId: identity.communityId,
    postId: identity.postId,
    operation: "CreateSongMegapotContributionV2",
    key: identity.key,
    requestHash: identity.hash,
    refusal: { code: "paused", receipt },
  } as const;
  const portsFor = (driver: OfflineDriver) =>
    makeControlPlaneSongContributionPorts(
      makeDirectPostgresControlPlaneLayer("postgres://offline.invalid/unused", {
        clientFactory: () => driver,
        logger: { info: () => undefined, error: () => undefined },
      }),
      { authorize: () => Effect.succeed({ accountId: identity.accountId }) },
      { rewardsEnabled: false },
    );
  const normal = async (q: PostgresQueryConfig): Promise<PostgresQueryResponse> => {
    if (q.text.includes("load_song_contribution_command_v2"))
      return { rows: [{ packet: null }], rowCount: 1 };
    if (q.text.includes("record_song_contribution_refusal_v2")) {
      return {
        rows: [
          {
            packet: {
              ...packet,
              refusal: { code: q.values?.[1], receipt: { ...receipt, command_id: q.values?.[2] } },
            },
          },
        ],
        rowCount: 1,
      };
    }
    return empty();
  };
  const refuse = (driver: OfflineDriver) =>
    portsFor(driver).transaction(identity, (tx) =>
      Effect.gen(function* () {
        yield* tx.lookup();
        return yield* new SongContributionFailure({ code: "paused" });
      }),
    );

  test("holds command fence outside savepoint, rolls creation back, and acknowledges COMMIT before proof", async () => {
    const driver = new OfflineDriver();
    driver.onQuery = normal;
    const exit = await Effect.runPromiseExit(refuse(driver));
    expect(failures(exit)).toMatchObject([
      {
        code: "paused",
        refusalReceipt: {
          request_hash: identity.hash,
          allocation: "none",
          instruction_issued: false,
        },
      },
    ]);
    const texts = driver.queries.map((q) => q.text);
    const position = (part: string) => texts.findIndex((text) => text.includes(part));
    expect(position("pg_advisory_xact_lock")).toBeLessThan(
      position("SAVEPOINT contribution_creation"),
    );
    expect(position("SAVEPOINT contribution_creation")).toBeLessThan(
      position("load_song_contribution_command_v2"),
    );
    expect(position("load_song_contribution_command_v2")).toBeLessThan(
      position("ROLLBACK TO SAVEPOINT"),
    );
    expect(position("ROLLBACK TO SAVEPOINT")).toBeLessThan(
      position("record_song_contribution_refusal_v2"),
    );
    expect(position("record_song_contribution_refusal_v2")).toBeLessThan(position("COMMIT"));
    expect(count(driver, "COMMIT")).toBe(1);
    expect(count(driver, "ROLLBACK")).toBe(0);
  });

  for (const phase of ["rollback", "persist", "commit"] as const)
    test(`${phase} uncertainty never delivers no-allocation proof`, async () => {
      const driver = new OfflineDriver();
      driver.onQuery = async (q) => {
        if (
          (phase === "rollback" && q.text.startsWith("ROLLBACK TO")) ||
          (phase === "persist" && q.text.includes("record_song_contribution_refusal_v2")) ||
          (phase === "commit" && q.text === "COMMIT")
        )
          throw new Error("lost database acknowledgement");
        return normal(q);
      };
      const exit = await Effect.runPromiseExit(refuse(driver));
      expect(failures(exit)).toMatchObject([{ code: "outcome_unknown" }]);
      expect(failures(exit).every((error) => error.refusalReceipt === undefined)).toBe(true);
      expect(count(driver, "COMMIT")).toBe(phase === "commit" ? 1 : 0);
      expect(
        driver.queries.filter((q) => q.text.includes("record_song_contribution_refusal_v2")),
      ).toHaveLength(phase === "rollback" ? 0 : 1);
    });

  for (const extra of ["defect", "interruption"] as const)
    test(`mixed refusal and ${extra} preserves the whole Cause without proof`, async () => {
      const driver = new OfflineDriver();
      driver.onQuery = normal;
      const cause = Cause.combine(
        Cause.fail(new SongContributionFailure({ code: "paused" })),
        extra === "defect" ? Cause.die("fixture defect") : Cause.interrupt(123),
      );
      const exit = await Effect.runPromiseExit(
        portsFor(driver).transaction(identity, (tx) =>
          Effect.gen(function* () {
            yield* tx.lookup();
            return yield* Effect.failCause(cause);
          }),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(
          exit.cause.reasons.some(extra === "defect" ? Cause.isDieReason : Cause.isInterruptReason),
        ).toBe(true);
      expect(
        driver.queries.some((q) => q.text.includes("record_song_contribution_refusal_v2")),
      ).toBe(false);
      expect(count(driver, "COMMIT")).toBe(0);
    });

  test("a business refusal without a positively observed locked miss is not proof", async () => {
    const driver = new OfflineDriver();
    driver.onQuery = normal;
    const exit = await Effect.runPromiseExit(
      portsFor(driver).transaction(identity, () =>
        Effect.fail(new SongContributionFailure({ code: "paused" })),
      ),
    );
    expect(failures(exit)).toMatchObject([{ code: "paused" }]);
    expect(failures(exit)[0]?.refusalReceipt).toBeUndefined();
    expect(driver.queries.some((q) => q.text.includes("record_song_contribution_refusal_v2"))).toBe(
      false,
    );
    expect(count(driver, "COMMIT")).toBe(0);
  });

  test("a persisted refusal resolves the original command while Rewards is off", async () => {
    const driver = new OfflineDriver();
    driver.onQuery = async (q) =>
      q.text.includes("load_song_contribution_command_v2")
        ? { rows: [{ packet }], rowCount: 1 }
        : empty();
    const exit = await Effect.runPromiseExit(portsFor(driver).lookup(identity));
    expect(failures(exit)).toMatchObject([{ code: "paused", refusalReceipt: receipt }]);
    expect(count(driver, "BEGIN")).toBe(0);
  });

  for (const change of [
    { hash: "b".repeat(64) },
    { postId: "other-song" },
    { communityId: "other-community" },
  ] as const)
    test(`refusal replay binds canonical hash and original route: ${Object.keys(change)[0]}`, async () => {
      const driver = new OfflineDriver();
      driver.onQuery = async (q) =>
        q.text.includes("load_song_contribution_command_v2")
          ? { rows: [{ packet }], rowCount: 1 }
          : empty();
      const exit = await Effect.runPromiseExit(portsFor(driver).lookup({ ...identity, ...change }));
      expect(failures(exit)).toMatchObject([{ code: "idempotency_conflict" }]);
      expect(failures(exit)[0]?.refusalReceipt).toBeUndefined();
    });

  test("malformed no-allocation evidence fails closed", async () => {
    const driver = new OfflineDriver();
    driver.onQuery = async (q) =>
      q.text.includes("load_song_contribution_command_v2")
        ? {
            rows: [
              {
                packet: {
                  ...packet,
                  refusal: { code: "paused", receipt: { ...receipt, instruction_issued: true } },
                },
              },
            ],
            rowCount: 1,
          }
        : empty();
    const exit = await Effect.runPromiseExit(portsFor(driver).lookup(identity));
    expect(failures(exit)).toMatchObject([{ code: "outcome_unknown" }]);
    expect(failures(exit)[0]?.refusalReceipt).toBeUndefined();
  });
});
