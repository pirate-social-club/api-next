import { type ControlPlaneDb, SongContributionFailure } from "@pirate/application";
import type { MegapotV2FullRpcClient } from "@pirate/platform-cf/megapot-v2-rpc";
import { Effect, Schedule } from "effect";
import {
  makeCurrentFundingRecoveryEvidence,
  makeMegapotFundingHistoricalVerifier,
  makeRewardFundingReceiptDiscovery,
} from "../../../packages/platform-cf/src/reward-funding-receipt-discovery.ts";
import type {
  makeControlPlaneSongFundingRecoveryStore,
  SongFundingWork,
} from "../../../packages/platform-cf/src/song-megapot-contribution-repository.ts";
import {
  JobContext,
  type JobDeclaration,
  SONG_FUNDING_RECOVERY_READS,
  SONG_FUNDING_RECOVERY_WRITES,
} from "./registry.ts";

type Store = ReturnType<typeof makeControlPlaneSongFundingRecoveryStore>;
export function makeSongMegapotFundingRecovery(input: {
  readonly store: Store;
  readonly rpcFor: (work: Pick<SongFundingWork, "source" | "state">) => MegapotV2FullRpcClient;
  readonly now: () => string;
  readonly observe: (
    work: SongFundingWork,
    transactionHash: string,
    discover: ReturnType<typeof makeRewardFundingReceiptDiscovery>,
  ) => Effect.Effect<unknown | null, SongContributionFailure>;
}) {
  const process = Effect.fn("SongFundingRecovery.process")(function* (work: SongFundingWork) {
    const rpc = input.rpcFor(work),
      i = work.state.receipt.instruction,
      p = work.workPolicy;
    // Bounded discovery occurs after claim committed, with no DB transaction open.
    const current = yield* makeCurrentFundingRecoveryEvidence(rpc, input.now)(
      work.state,
      work.source,
    ).pipe(
      // Known current unavailability must be persisted before historical reads.
      // RPC/chain uncertainty escapes; historical success cannot mint authority.
      Effect.catchTag("SongContributionFailure", (e) =>
        e.code === "cancellation_recovery_unavailable" || e.code === "attestation_unavailable"
          ? input.store.invalidate(work, e.code).pipe(Effect.as(null))
          : Effect.fail(e),
      ),
    );
    if (current !== null)
      yield* input.store
        .record(work, current)
        .pipe(
          Effect.catchTag("SongContributionFailure", (e) =>
            e.code === "cancellation_recovery_unavailable"
              ? input.store.invalidate(work, e.code)
              : Effect.fail(e),
          ),
        );
    const read = <A>(f: () => Promise<A>) => Effect.tryPromise(f);
    const finalized = yield* read(() => rpc.readFinalizedHead());
    const anchor = BigInt(work.state.receipt.reservation.valid_from_block_exclusive) + 1n;
    const cursor = work.nextBlock === null ? anchor : BigInt(work.nextBlock);
    const from = cursor < anchor ? anchor : cursor;
    const to =
      from + BigInt(p.maximumBlocks) - 1n < finalized.blockNumber
        ? from + BigInt(p.maximumBlocks) - 1n
        : finalized.blockNumber;
    const candidates = new Set<string>();
    if (work.hint !== null) candidates.add(work.hint.transactionHash);
    if (from <= to) {
      const readLogs = rpc.readFundingTransferLogs;
      if (readLogs === undefined)
        return yield* new SongContributionFailure({ code: "attestation_unavailable" });
      const logs = yield* read(() =>
        readLogs({
          sender: i.from,
          custody: i.recipient_custody,
          token: i.to_token,
          fromBlock: from,
          toBlock: to,
          maximumBlocks: p.maximumBlocks,
          maximumLogs: p.maximumLogs,
        }),
      );
      for (const log of logs) candidates.add(log.transactionHash);
    }
    const discover = makeRewardFundingReceiptDiscovery({
      rpc,
      policy: p.receipt,
      now: input.now,
      verifyHistoricalAttestation: makeMegapotFundingHistoricalVerifier(
        rpc,
        BigInt(work.source.attestationBlock),
        work.source.attestationBlockHash,
      ),
    });
    const nextBlock = from <= to ? to + 1n : from;
    for (const hash of candidates) {
      const tx = yield* read(() => rpc.readTransaction(hash));
      if (tx === null || tx.from !== i.from || tx.nonce !== BigInt(i.nonce)) continue;
      // Self cancellation/revert proves no Transfer principal here. No nonce or
      // liability is closed without the separately required custody interpreter.
      const accepted = yield* input
        .observe(work, hash, discover)
        .pipe(
          Effect.catchTag("SongContributionFailure", (e) =>
            e.code === "receipt_mismatch" ? Effect.succeed(null) : Effect.fail(e),
          ),
        );
      if (accepted !== null) return { complete: true, nextBlock: null, error: null };
    }
    return {
      complete: false,
      nextBlock: nextBlock.toString(),
      error: null,
    };
  });
  return {
    run: Effect.fn("SongFundingRecovery.run")(function* (options: {
      readonly enabled: boolean;
      readonly limit: number;
      readonly ensure: () => Effect.Effect<void, unknown>;
    }) {
      if (!options.enabled) return;
      yield* options.ensure();
      const candidates = yield* input.store.list(
        options.limit,
        Math.floor(Date.parse(input.now()) / 60_000),
      );
      for (const candidate of candidates) {
        yield* options.ensure();
        // A bounded readiness read cannot accept principal or mint signing authority.
        // Waiting for a known block to finalize is not another discovery attempt.
        if (candidate.nextBlock !== null) {
          const ready = yield* Effect.tryPromise({
            try: async () => {
              const rpc = input.rpcFor(candidate);
              const finalized = await rpc.readFinalizedHead();
              if (finalized.blockNumber < BigInt(candidate.nextBlock ?? "0")) return false;
              if (candidate.hint !== null) {
                const tx = await rpc.readTransaction(candidate.hint.transactionHash);
                const i = candidate.state.receipt.instruction;
                if (
                  tx !== null &&
                  tx.chainId === i.chain_id &&
                  tx.from === i.from &&
                  tx.nonce.toString() === i.nonce &&
                  tx.blockNumber !== null &&
                  tx.blockNumber > finalized.blockNumber
                )
                  return false;
              }
              return true;
            },
            catch: () => new SongContributionFailure({ code: "outcome_unknown" }),
          });
          if (!ready) continue;
        }
        const work = yield* input.store.claim(candidate.workId, crypto.randomUUID());
        if (work === null) continue;
        const result = yield* process(work).pipe(
          Effect.catch(
            Effect.fn("SongFundingRecovery.retainUnknown")(function* (error: unknown) {
              const code =
                error instanceof SongContributionFailure ? error.code : "outcome_unknown";
              yield* input.store.invalidate(
                work,
                code === "lifecycle_changed" || code === "paused" ? code : "outcome_unknown",
              );
              return { complete: false, nextBlock: work.nextBlock, error: code };
            }),
          ),
        );
        // Unknown provider/commit outcomes retain liability and a durable result.
        // A failed/fenced finish is not retried or represented as success.
        yield* input.store.finish(work, result);
      }
    }),
  };
}

/** Selected only by the serving composition's existing Rewards enablement gate.
 * No signer or provider submission capability is held by this declaration. */
export function makeSongMegapotFundingRecoveryJob(input: {
  readonly runtime: ReturnType<typeof makeSongMegapotFundingRecovery>;
  readonly enabled: boolean;
  readonly limit: number;
  readonly ensure: () => Effect.Effect<void, unknown>;
}): JobDeclaration<unknown, ControlPlaneDb> {
  return {
    name: "song-megapot-funding-recovery.v2",
    lane: "rewards",
    schedule: "* * * * *",
    timeout: "1 minute",
    retry: Schedule.recurs(0),
    expectedFailures: [
      "SongContributionFailure",
      "RewardOperationsPaused",
      "RewardRunAuthorityUnavailable",
    ],
    severity: {
      expectedFailure: {
        SongContributionFailure: "medium",
        RewardOperationsPaused: "medium",
        RewardRunAuthorityUnavailable: "high",
      },
      timeout: "high",
      transactionOutcomeUnknown: "high",
      defect: "high",
    },
    reads: SONG_FUNDING_RECOVERY_READS,
    writes: SONG_FUNDING_RECOVERY_WRITES,
    requiresAdapterSafety: true,
    run: input.runtime
      .run({ enabled: input.enabled, limit: input.limit, ensure: input.ensure })
      .pipe(
        Effect.onInterrupt(() =>
          JobContext.use((c) => Effect.sync(c.adapterSafety.markAbortedOrFenced)),
        ),
      ),
  };
}
