import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import {
  ControlPlaneDb,
  type ControlPlaneStatement,
  type ControlPlaneTransaction,
  ControlPlaneTransactionOutcomeUnknown,
} from "../../application/src/ports.ts";
import { canonicalBodyHash } from "../../application/src/use-cases/content/common.ts";
import { songFundingContextFixture } from "../../testing/src/song-funding-context-fixture.ts";
import type { MegapotV2DeploymentAttestation, MegapotV2DrawingState } from "./megapot-v2.ts";
import {
  instantiateSharedSongRewardPolicyIn,
  makeControlPlaneSharedSongContextProducer,
} from "./shared-song-megapot-production.ts";

const h = "a".repeat(64);
const encode = (value: unknown) =>
  JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
/** The actual producer and transaction boundary consume deterministic DB/RPC
 * packets. These tests never construct a provider client, socket or SQL server. */
async function fixture(
  options: {
    drift?: boolean;
    advance?: boolean;
    nowMs?: number;
    pendingAfter?: bigint;
    gas?: bigint;
    providerUnknown?: boolean;
    unknownCommit?: boolean;
    pending?: bigint;
  } = {},
) {
  const facts = songFundingContextFixture();
  const { now: _now, schedule: _schedule, wireSchedule: _wire, ...base } = facts;
  const deployment: MegapotV2DeploymentAttestation = {
    attestationId: "attestation",
    environment: "test",
    chainId: 84532,
    jackpotAddress: `0x${"44".repeat(20)}`,
    ticketNftAddress: `0x${"55".repeat(20)}`,
    usdcAddress: facts.tokenAddress,
    custodyAddress: facts.custodyAddress,
    referrerAddress: `0x${"66".repeat(20)}`,
    jackpotCodeHash: `0x${h}`,
    ticketNftCodeHash: `0x${h}`,
    usdcCodeHash: `0x${h}`,
  };
  const qualificationDocuments = [];
  const qualificationTemplates = [];
  for (const template of facts.qualificationTemplates) {
    const body = { family: template.grading_family };
    const hash = await Effect.runPromise(
      canonicalBodyHash([
        "pirate.shared-song-qualification-policy.v1",
        template.qualification_policy_id,
        template.activity,
        "fictional-policy",
        body,
      ]),
    );
    qualificationDocuments.push({
      policyId: template.qualification_policy_id,
      activity: template.activity,
      kind: "fictional-policy",
      document: template.activity === "dance" ? { ...body, policy_hash: hash } : body,
    });
    qualificationTemplates.push({ ...template, qualification_policy_hash: hash });
  }
  const work = JSON.parse(
    encode({
      workId: "work",
      token: "lease-token",
      attempt: 1,
      templateHash: h,
      profileId: "profile",
      validUntil: new Date(50000).toISOString(),
      noncePolicy: { hash: h, maxAgeMs: 2000 },
      deployment,
      attestationBlock: "10",
      attestationBlockHash: `0x${h}`,
      operations: {
        disclosureVersion: "disclosure",
        feePolicyId: "accepted-fees",
        scheduleRuleId: "initialized-drawings",
        scheduleRuleHash: h,
        priceRuleHash: h,
        finalityPolicyId: "selected-finality",
        cadenceSeconds: "1",
        entryCutoffSeconds: 2,
        purchaseLeadSeconds: 1,
        maximumContextAttempts: 3,
        contextLeaseMs: 4000,
        maximumContextWorkPerAccount: 3,
        maximumContextWorkGlobal: 5,
        contextWorkPerAttempt: 1,
        inboundRequiredGasWei: "1",
        refundEnvelopeMinimumWei: "10",
        legalActivationGate: "test_only",
        initializedDrawingIds: ["43"],
      },
      facts: { ...base, qualificationTemplates },
      qualificationDocuments,
      drawingStates: [],
    }),
  );
  const trace: string[] = [],
    statements: ControlPlaneStatement[] = [],
    contexts: unknown[] = [],
    failures: string[] = [];
  let depth = 0,
    heads = 0,
    pendingReads = 0;
  const balanceBlocks: Array<bigint | undefined> = [];
  const execute: ControlPlaneTransaction["execute"] = <Row>(s: ControlPlaneStatement) =>
    Effect.sync(() => {
      statements.push(s);
      trace.push(s.label);
      let packet: unknown = null;
      if (s.label === "shared-song.context.claim") packet = work;
      else if (s.label === "shared-song.context.persist")
        contexts.push(JSON.parse(String(s.values[2])));
      else if (s.label === "shared-song.context.finish-unavailable")
        failures.push(String(s.values[2]));
      else throw new Error(`Unexpected DB call ${s.label}`);
      return { rows: [{ packet }] as Row[], rowCount: 1 };
    });
  const db = ControlPlaneDb.of({
    execute,
    withTransaction: (use) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          depth++;
          trace.push("BEGIN");
        }),
        () =>
          Effect.gen(function* () {
            const value = yield* use({ execute });
            if (options.unknownCommit && statements.at(-1)?.label === "shared-song.context.persist")
              return yield* new ControlPlaneTransactionOutcomeUnknown({
                phase: "commit",
                label: "COMMIT",
                limitMs: 100,
                elapsedMs: 100,
              });
            trace.push("COMMIT");
            return value;
          }),
        () =>
          Effect.sync(() => {
            depth--;
          }),
      ),
  });
  const rpcRead = async <A>(name: string, value: A) => {
    expect(depth).toBe(0);
    trace.push(`rpc:${name}`);
    if (options.providerUnknown) throw new Error("Fictional unknown read");
    return value;
  };
  const producer = makeControlPlaneSharedSongContextProducer({
    runtime: Layer.succeed(ControlPlaneDb, db),
    now: () => new Date(options.nowMs ?? 1000).toISOString(),
    rpcFor: () => ({
      deployment,
      attestDeploymentAt: () => rpcRead("attest", undefined),
      readHead: () => {
        const advanced = options.advance && ++heads > 1;
        return rpcRead("head", {
          blockNumber: advanced ? 101n : 100n,
          blockHash: `0x${advanced ? "b".repeat(64) : h}`,
          blockTimestamp: advanced ? 2n : 1n,
        });
      },
      readBlock: (blockNumber) =>
        rpcRead(`anchor:${blockNumber}`, {
          blockNumber,
          blockHash: `0x${options.drift && blockNumber === 100n ? "b".repeat(64) : h}`,
          blockTimestamp: 1n,
        }),
      readCurrentDrawingId: () => rpcRead("current", 42n),
      readDrawing: (id) => {
        const state: MegapotV2DrawingState = {
          prizePool: 10n,
          ticketPrice: 1000000n,
          edgePerTicket: 1n,
          referralWinShare: 0n,
          referralFee: 0n,
          globalTicketsBought: 0n,
          lpEarnings: 0n,
          drawingTime: id === 42n ? 12n : 22n,
          winningTicket: 0n,
          ballMax: 35,
          bonusballMax: 10,
          payoutCalculator: deployment.jackpotAddress,
          jackpotLock: false,
        };
        return rpcRead(`drawing:${id}`, state);
      },
      readTransactionCount: () => rpcRead("confirmed-nonce", 4n),
      readPendingNonce: () =>
        rpcRead(
          "pending-nonce",
          ++pendingReads > 1 ? (options.pendingAfter ?? 4n) : (options.pending ?? 4n),
        ),
      readNativeBalance: (account, blockNumber) => {
        balanceBlocks.push(blockNumber);
        return rpcRead(`gas:${account}`, options.gas ?? 100n);
      },
    }),
  });
  return { producer, contexts, failures, statements, trace, balanceBlocks };
}
const options = { enabled: true, ensure: () => Effect.void };
describe("actual shared-song background context producer", () => {
  test("claims once, observes exact initialized IDs outside transactions and persists a real three-activity prospective quote", async () => {
    const f = await fixture();
    await Effect.runPromise(f.producer.run(options));
    expect(f.contexts).toHaveLength(1);
    expect(f.failures).toEqual([]);
    expect(f.contexts[0]).toMatchObject({
      readiness: "ready",
      target: { kind: "empty", offer_id: null, pool_leg_id: null },
      limits: { maximum_atomic: "2000000" },
      quote: {
        kind: "prospective",
        prospective_terms: {
          planned_drawing_ids: ["42", "43"],
          empty_behavior: "no_purchase",
          eligible_activities: ["study", "karaoke", "dance"],
        },
      },
    });
    expect(f.trace.slice(0, 3)).toEqual(["BEGIN", "shared-song.context.claim", "COMMIT"]);
    expect(f.trace.filter((name) => name.startsWith("rpc:drawing:"))).toEqual([
      "rpc:drawing:42",
      "rpc:drawing:43",
    ]);
    expect(f.statements.map((s) => s.label)).toEqual([
      "shared-song.context.claim",
      "shared-song.context.persist",
    ]);
    expect(
      f.statements.some((s) =>
        /nonce.*reserve|create_song_contribution|claim.*submission|sendRawTransaction/.test(s.text),
      ),
    ).toBe(false);
  });
  test("a normal head advance preserves the pinned snapshot within its age limit", async () => {
    const f = await fixture({ advance: true, nowMs: 2000 });
    await Effect.runPromise(f.producer.run(options));
    expect(f.contexts).toHaveLength(1);
    expect(f.failures).toEqual([]);
    expect(f.trace.filter((name) => name === "rpc:head")).toHaveLength(1);
    expect(f.trace).toContain("rpc:anchor:100");
    expect(f.balanceBlocks).toEqual([100n, 100n]);
    expect(f.trace.indexOf("rpc:anchor:100")).toBeGreaterThan(f.trace.indexOf("rpc:drawing:43"));
  });
  test("nonce changes, a replaced snapshot block, invalid age and insufficient gas refuse a ready context", async () => {
    for (const [fixtureOptions, code] of [
      [{ pending: 5n }, "wallet_nonce_busy"],
      [{ pendingAfter: 5n }, "wallet_nonce_busy"],
      [{ drift: true }, "observation_stale"],
      [{ nowMs: 3001 }, "observation_stale"],
      [{ nowMs: 999 }, "observation_stale"],
      [{ gas: 0n }, "gas_budget_unavailable"],
    ] as const) {
      const f = await fixture(fixtureOptions);
      await Effect.runPromise(f.producer.run(options));
      expect(f.contexts).toEqual([]);
      expect(f.failures).toEqual([code]);
      expect(f.statements.filter((s) => s.label === "shared-song.context.claim")).toHaveLength(1);
    }
  });
  test("unknown provider read retains its charged attempt without another read/claim or ready result", async () => {
    const f = await fixture({ providerUnknown: true });
    await Effect.runPromise(f.producer.run(options));
    expect(f.contexts).toEqual([]);
    expect(f.failures).toEqual(["outcome_unknown"]);
    expect(f.trace.filter((s) => s.startsWith("rpc:"))).toEqual(["rpc:head"]);
    expect(f.statements.filter((s) => s.label === "shared-song.context.claim")).toHaveLength(1);
  });
  test("unknown context COMMIT escapes by its original phase; no transaction or RPC replay and no compensating rewrite", async () => {
    const f = await fixture({ unknownCommit: true });
    await expect(Effect.runPromise(f.producer.run(options))).rejects.toMatchObject({
      _tag: "ControlPlaneTransactionOutcomeUnknown",
      phase: "commit",
    });
    expect(f.contexts).toHaveLength(1);
    expect(f.failures).toEqual([]);
    expect(f.statements.map((s) => s.label)).toEqual([
      "shared-song.context.claim",
      "shared-song.context.persist",
    ]);
  });
  test("disabled source performs no DB or provider work", async () => {
    const f = await fixture();
    await Effect.runPromise(f.producer.run({ ...options, enabled: false }));
    expect(f.trace).toEqual([]);
  });
  test("policy instantiation writes actual immutable offer identity/hash through existing policy authority", async () => {
    const statements: ControlPlaneStatement[] = [];
    const template = {
      version: "shared_song_megapot_v2",
      pool_entry: "qualifying_account",
      claim_verification: "megapot_claim_time_verification_v1",
    };
    const execute: ControlPlaneTransaction["execute"] = <Row>(s: ControlPlaneStatement) =>
      Effect.sync(() => {
        statements.push(s);
        return {
          rows: [
            {
              packet:
                s.label === "shared-song.policy.template"
                  ? { reward_policy: template }
                  : s.values[5],
            },
          ] as Row[],
          rowCount: 1,
        };
      });
    const identity = { accountId: "A", communityId: "community" };
    const hash = await Effect.runPromise(
      instantiateSharedSongRewardPolicyIn({ execute }, identity, "snapshot", "offer", h),
    );
    const policy = JSON.parse(String(statements[1]?.values[4]));
    expect(policy).toEqual({
      ...template,
      community_id: "community",
      offer_id: "offer",
      uniqueness: { kind: "single_authority", authority_id: "offer" },
    });
    expect(hash).toBe(await Effect.runPromise(canonicalBodyHash(policy)));
    expect(statements.map((s) => s.label)).toEqual([
      "shared-song.policy.template",
      "shared-song.policy.instantiate",
    ]);
    expect(policy).not.toHaveProperty("owner_only");
    expect(policy).not.toHaveProperty("membership");
  });
});
