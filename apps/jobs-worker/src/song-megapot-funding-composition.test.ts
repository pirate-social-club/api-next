import { describe, expect, mock, test } from "bun:test";
import {
  AlertCollector,
  ControlPlaneDb,
  type ControlPlaneStatement,
  ControlPlaneStatementFailed,
  RewardOperationsPaused,
} from "@pirate/application";
import { Effect, Layer } from "effect";
import {
  makeBoundedSongFundingConnection,
  makeSongFundingRecoveryRuntime,
} from "./megapot-rewards-runtime.ts";
import { buildJobRegistry, JobContext, SONG_FUNDING_RECOVERY_WRITES } from "./registry.ts";

mock.module("cloudflare:workers", () => ({ DurableObject: class DurableObject {} }));
const { makeJobsWorkerDeclarations } = await import("./index.ts");

// Real serving declaration/runtime, with an offline ControlPlaneDb port. An
// empty durable queue must never construct a per-deployment RPC or call fetch.
function fixture() {
  const labels: string[] = [];
  let paused = false;
  const execute: ControlPlaneDb["Service"]["execute"] = <Row>(statement: ControlPlaneStatement) => {
    labels.push(statement.label);
    if (paused && statement.label === "reward-run-authority.require")
      return Effect.fail(
        new ControlPlaneStatementFailed({
          label: statement.label,
          sqlState: "PR001",
          constraint: null,
          outcomeCertainty: "completed",
        }),
      );
    return Effect.succeed({
      rows: (statement.label === "shared-song.context.claim" ? [{ packet: null }] : []) as Row[],
      rowCount: statement.label === "shared-song.context.claim" ? 1 : 0,
    });
  };
  const layer = Layer.succeed(ControlPlaneDb, {
    execute,
    withTransaction: (use) => use({ execute }),
  });
  const runtime = makeSongFundingRecoveryRuntime({
    controlPlane: layer,
    rpcUrl: "https://offline.invalid/no-provider",
    environment: "development",
    now: () => "2026-10-21T12:00:00.000Z",
  });
  const declarations = (enabled: boolean) =>
    makeJobsWorkerDeclarations(
      {},
      "https://offline.invalid/no-provider",
      { enabled: false },
      "development",
      null,
      false,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      enabled ? runtime : undefined,
    );
  const context = {
    owner: "offline-owner",
    attemptId: "offline-attempt",
    lease: () => {
      throw new Error("No provider or lease mutation in this empty-queue fixture");
    },
    adapterSafety: { markAbortedOrFenced: () => undefined, isProven: () => true },
  };
  return {
    declarations,
    labels,
    context,
    layer,
    pause: () => {
      paused = true;
    },
  };
}

describe("serving Funding observer/recovery composition", () => {
  test("both selected lanes use only the dedicated bounded Jobs connection for authority, context and recovery", async () => {
    const general = { connectionString: "postgres://dance@fixture.invalid/db" };
    const funding = { connectionString: "postgres://funding_jobs@fixture.invalid/db" };
    for (const lane of ["safe", "eoa"] as const) {
      const calls: string[] = [];
      const layer = makeBoundedSongFundingConnection(funding, general, lane, (url, config) => {
        expect(url).toBe(funding.connectionString);
        expect(config.connectionTimeoutMillis).toBe(3000);
        expect(config.statement_timeout).toBe(2000);
        return {
          connect: async () => {},
          end: async () => {},
          query: async ({ text }) => {
            calls.push(text);
            const rows = text.includes("claim_next_shared_song_context_v2")
              ? [{ packet: null }]
              : [];
            return { rows, rowCount: rows.length };
          },
        };
      });
      const runtime = makeSongFundingRecoveryRuntime({
        controlPlane: layer,
        rpcUrl: "https://offline.invalid/no-provider",
        environment: "staging",
        now: () => new Date().toISOString(),
      });
      await Effect.runPromise(runtime.run({ enabled: true, limit: 1, ensure: runtime.ensure }));
      expect(calls.filter((s) => s.includes("require_reward_run_authority_v1"))).toHaveLength(2);
      expect(calls.filter((s) => s.includes("claim_next_shared_song_context_v2"))).toHaveLength(1);
      expect(calls.filter((s) => s.includes("list_song_funding_candidates_v2"))).toHaveLength(1);
      expect(() => makeBoundedSongFundingConnection(undefined, general, lane)).toThrow(
        "Dedicated song funding",
      );
      expect(() => makeBoundedSongFundingConnection(general, general, lane)).toThrow(
        "Dedicated song funding",
      );
    }
  });
  test("missing bounded database composition refuses rather than disabling recovery or using an unbounded fallback", () => {
    expect(() =>
      makeSongFundingRecoveryRuntime({
        controlPlane: undefined,
        rpcUrl: "https://offline.invalid/no-provider",
        environment: "development",
        now: () => "2026-10-21T12:00:00.000Z",
      }),
    ).toThrow("Bounded Funding database runtime required");
  });
  test("disabled serving declarations contain no V2 recovery job or dependency calls", async () => {
    const f = fixture();
    const registry = await Effect.runPromise(buildJobRegistry(f.declarations(false)));
    expect(registry.byName.has("song-megapot-funding-recovery.v2")).toBe(false);
    expect(f.labels).toEqual([]);
  });

  test("enabled serving registry selects the actual runtime with its complete exclusive write inventory, restart-safe empty work and a live brake", async () => {
    const f = fixture();
    const registry = await Effect.runPromise(buildJobRegistry(f.declarations(true)));
    const job = registry.byName.get("song-megapot-funding-recovery.v2");
    if (job === undefined) throw new Error("Serving funding job is missing");
    expect(job.requiresAdapterSafety).toBe(true);
    expect(job.writes).toEqual(SONG_FUNDING_RECOVERY_WRITES);
    const run = () =>
      Effect.runPromise(
        job.run.pipe(
          Effect.provideService(JobContext, f.context),
          Effect.provide(f.layer),
          Effect.provideService(AlertCollector, { emit: () => Effect.void }),
        ),
      );
    await run();
    await run();
    expect(f.labels).toEqual([
      "reward-run-authority.require",
      "shared-song.context.claim",
      "reward-run-authority.require",
      "song-funding.work.list",
      "reward-run-authority.require",
      "shared-song.context.claim",
      "reward-run-authority.require",
      "song-funding.work.list",
    ]);
    f.pause();
    await expect(run()).rejects.toBeInstanceOf(RewardOperationsPaused);
    expect(f.labels).toEqual([
      "reward-run-authority.require",
      "shared-song.context.claim",
      "reward-run-authority.require",
      "song-funding.work.list",
      "reward-run-authority.require",
      "shared-song.context.claim",
      "reward-run-authority.require",
      "song-funding.work.list",
      "reward-run-authority.require",
    ]);
  });
});
