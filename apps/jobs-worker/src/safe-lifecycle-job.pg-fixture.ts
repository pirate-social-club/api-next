import { expect, mock } from "bun:test";
import {
  AlertCollector,
  ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneTransactionOutcomeUnknown,
} from "@pirate/application";
import { Effect, Layer } from "effect";
import type { MegapotCommitmentBucket } from "../../../packages/platform-cf/src/megapot-commitment-r2.ts";
import type { MegapotV2FullRpcClient } from "../../../packages/platform-cf/src/megapot-v2-rpc.ts";
import { makeControlPlaneRewardSafeWorkStore } from "../../../packages/platform-cf/src/reward-safe-work-repository.ts";
import { JobContext } from "./registry.ts";
import { makeSerialStudyMegapotRecoveryJob } from "./serial-study-megapot-recovery.ts";
import type { makeSongMegapotFundingRecovery } from "./song-megapot-funding-recovery.ts";
import { makeSongMegapotFundingRecoveryJob } from "./song-megapot-funding-recovery.ts";

mock.module("cloudflare:workers", () => ({ DurableObject: class DurableObject {} }));
const { makeSafePoolPilotJob } = await import("./safe-pool-pilot.ts");
const { makeStudySpokenAnswerRecoveryJob } = await import("./study-spoken-answer-recovery.ts");

/** Production job declarations and stores; only external chain and R2 are local. */
export function makeSafeLifecycleJobProof(input: {
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>;
  rpc: MegapotV2FullRpcClient;
  now: () => number;
  funding: ReturnType<typeof makeSongMegapotFundingRecovery>;
  ensure: () => Effect.Effect<void, unknown>;
  custody: { attestationId: string; chainId: number; safeAddress: string };
}) {
  const objects = new Map<string, { uploaded: Date; text: () => Promise<string> }>();
  const bucket: MegapotCommitmentBucket = {
    get: async (key) => objects.get(key) ?? null,
    put: async (key, text) => {
      if (objects.has(key)) return null;
      const value = { uploaded: new Date(), text: async () => text };
      objects.set(key, value);
      return value;
    },
  };
  const job = makeSerialStudyMegapotRecoveryJob(
    { log: () => {} },
    makeStudySpokenAnswerRecoveryJob(
      {},
      { head: async () => null, delete: async () => {} },
      undefined,
      1,
    ),
    makeSafePoolPilotJob(
      {},
      {
        environment: "staging",
        attestationId: input.custody.attestationId,
        rpcUrl: "https://local.invalid",
        requiredConfirmations: 1,
        productionEnabled: false,
        minimumEntrySeconds: 60,
        observationTtlMs: 120_000,
        commitmentBucket: bucket,
        commitmentPublicOrigin: "https://commitments.test",
      },
      { rpcFor: () => input.rpc, now: input.now },
    ),
    makeSongMegapotFundingRecoveryJob({
      runtime: input.funding,
      enabled: true,
      limit: 1,
      ensure: input.ensure,
    }),
  );
  let ticks = 0;
  return {
    tick: async (runtime = input.layer) => {
      const alerts: unknown[] = [];
      const started = Date.now();
      await Effect.runPromise(
        job.run.pipe(
          Effect.provide(runtime),
          Effect.provideService(AlertCollector, {
            emit: (alert) =>
              Effect.sync(() => {
                alerts.push(alert);
              }),
          }),
          Effect.provideService(JobContext, {
            owner: "local-job-proof",
            attemptId: `local-tick-${++ticks}`,
            startedAtMs: started,
            lease: () => ({ owner: "local-job-proof", generation: 1, expiresAt: started + 60_000 }),
            adapterSafety: { isProven: () => true, markAbortedOrFenced: () => {} },
          }),
        ),
      );
      expect(alerts).toEqual([]);
    },
    prepared: async (kind: string) => {
      const calls = await Effect.runPromise(
        makeControlPlaneRewardSafeWorkStore(input.layer).loadPreparedCalls(input.custody),
      );
      const matching = calls.filter((call) => call.kind === kind);
      expect(matching).toHaveLength(1);
      const call = matching[0];
      if (!call) throw Error("Prepared job call missing");
      return call;
    },
  };
}

/** Lose only the acknowledgement after the real final Study transaction commits. */
export function loseOneStudyCommitAcknowledgement(
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
) {
  return Layer.effect(
    ControlPlaneDb,
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      let armed = true;
      const wrapped: ControlPlaneDb["Service"] = {
        execute: db.execute,
        withTransaction: (use) => {
          let completed = false;
          return db
            .withTransaction((tx) =>
              use({
                ...tx,
                execute: (statement) => {
                  if (statement.label === "study-v2.spoken.command-complete") completed = true;
                  return tx.execute(statement);
                },
              }),
            )
            .pipe(
              Effect.flatMap((result) => {
                if (!completed || !armed) return Effect.succeed(result);
                armed = false;
                return Effect.fail(
                  new ControlPlaneTransactionOutcomeUnknown({
                    phase: "commit",
                    label: "local-study-ack-loss",
                    limitMs: 2000,
                    elapsedMs: 2000,
                  }),
                );
              }),
            );
        },
      };
      return wrapped;
    }),
  ).pipe(Layer.provide(layer));
}
