import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import {
  ControlPlaneDb,
  type ControlPlaneStatement,
  type ControlPlaneTransaction,
  ControlPlaneTransactionOutcomeUnknown,
} from "../../application/src/ports.ts";
import { digestFundingPreimageV2 } from "../../application/src/rewards/song-megapot-contributions.ts";
import { canonicalBodyHash } from "../../application/src/use-cases/content/common.ts";
import * as C from "../../contracts/src/rewards-song-contributions-v2.ts";
import { songFundingContextFixture } from "../../testing/src/song-funding-context-fixture.ts";
import type { MegapotV2DeploymentAttestation, MegapotV2DrawingState } from "./megapot-v2.ts";
import {
  instantiateSharedSongRewardPolicyIn,
  makeControlPlaneSharedSongContextProducer,
} from "./shared-song-megapot-production.ts";
import {
  SHARED_SONG_SUCCESSOR_PRICE_RULE,
  SHARED_SONG_SUCCESSOR_RULE,
  SHARED_SONG_SUCCESSOR_RULE_ID,
} from "./shared-song-successor-schedule.ts";

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
    successor?: boolean;
    badRuleHash?: boolean;
    badDeployment?: boolean;
    missingRecurrence?: boolean;
    duration?: bigint;
    price?: bigint;
    currentId?: bigint;
    drawingTime?: bigint;
    drawingPrice?: bigint;
    headSeconds?: bigint;
    original?: {
      target: C.CommittedTargetV2;
      terms: C.TermsV2;
      originContext: C.ContextReadyV2;
    };
  } = {},
) {
  const facts = songFundingContextFixture();
  const { now: _now, schedule: _schedule, wireSchedule: _wire, ...base } = facts;
  const deployment: MegapotV2DeploymentAttestation = {
    attestationId: "attestation",
    environment: "test",
    chainId: 84532,
    jackpotAddress: options.successor
      ? SHARED_SONG_SUCCESSOR_RULE.jackpotAddress
      : `0x${"44".repeat(20)}`,
    ticketNftAddress: `0x${"55".repeat(20)}`,
    usdcAddress: facts.tokenAddress,
    custodyAddress: facts.custodyAddress,
    referrerAddress: `0x${"66".repeat(20)}`,
    jackpotCodeHash:
      options.successor && !options.badDeployment
        ? SHARED_SONG_SUCCESSOR_RULE.jackpotCodeHash
        : `0x${h}`,
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
  if (options.successor) {
    work.validUntil = new Date(7_200_000).toISOString();
    work.noncePolicy.maxAgeMs = 120_000;
    Object.assign(work.operations, {
      scheduleRuleId: SHARED_SONG_SUCCESSOR_RULE_ID,
      scheduleRuleHash: options.badRuleHash
        ? h
        : await Effect.runPromise(
            canonicalBodyHash(["pirate.shared-song-schedule-rule.v2", SHARED_SONG_SUCCESSOR_RULE]),
          ),
      priceRuleHash: await Effect.runPromise(
        canonicalBodyHash(["pirate.shared-song-price-rule.v2", SHARED_SONG_SUCCESSOR_PRICE_RULE]),
      ),
      cadenceSeconds: "1800",
      entryCutoffSeconds: 120,
      purchaseLeadSeconds: 900,
      initializedDrawingIds: [],
    });
    Object.assign(work.facts.capacityProfile, {
      maxDrawings: 1,
      reservationMs: 60_000,
      safetyMarginMs: 30_000,
      maximumWitnessAgeMs: 120_000,
      validUntil: 7_200_000,
      attestationValidUntil: 7_200_000,
      priceCeilingAtomic: "10000",
      minimumAtomic: "10000",
    });
  }
  if (options.original !== undefined) {
    work.facts.slot = options.original.target;
    work.facts.committedTerms = options.original.terms;
    work.facts.legSnapshotId = "committed-snapshot";
    work.facts.slotGeneration = 1;
  }
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
      else if (s.label === "shared-song.frozen-plan.read") packet = options.original;
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
          blockTimestamp: options.headSeconds ?? (advanced ? 2n : 1n),
        });
      },
      readBlock: (blockNumber) =>
        rpcRead(`anchor:${blockNumber}`, {
          blockNumber,
          blockHash: `0x${options.drift && blockNumber === 100n ? "b".repeat(64) : h}`,
          blockTimestamp: options.headSeconds ?? 1n,
        }),
      readCurrentDrawingId: () => rpcRead("current", options.currentId ?? 42n),
      ...(options.missingRecurrence
        ? {}
        : {
            readDrawingRecurrence: (block: bigint) =>
              rpcRead(`recurrence:${block}`, {
                durationSeconds: options.duration ?? 1800n,
                ticketPrice: options.price ?? 10000n,
              }),
          }),
      readDrawing: (id) => {
        if (options.successor && id !== (options.currentId ?? 42n))
          throw Error("An uninitialized future row must not be decoded");
        const state: MegapotV2DrawingState = {
          prizePool: 10n,
          ticketPrice: options.successor ? (options.drawingPrice ?? 10000n) : 1000000n,
          edgePerTicket: 1n,
          referralWinShare: 0n,
          referralFee: 0n,
          globalTicketsBought: 0n,
          lpEarnings: 0n,
          drawingTime: options.successor ? (options.drawingTime ?? 1801n) : id === 42n ? 12n : 22n,
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
  test("the opt-in successor quote selects only one conditional future ID with a full funding window", async () => {
    const f = await fixture({ successor: true });
    await Effect.runPromise(f.producer.run(options));
    expect(f.failures).toEqual([]);
    const context = Schema.decodeUnknownSync(C.ContextReadyV2)(f.contexts[0]);
    expect(context.limits.maximum_atomic).toBe("10000");
    expect(context.schedule.rows).toEqual([
      {
        drawing_id: "43",
        drawing_time: new Date(3_601_000).toISOString(),
        entry_cutoff_at: new Date(3_481_000).toISOString(),
        purchase_deadline_at: new Date(2_701_000).toISOString(),
        price_atomic: "10000",
        price_ceiling_atomic: "10000",
        initialized: false,
        proof_kind: "attested_recurrence",
      },
    ]);
    expect(context.quote).toMatchObject({
      kind: "prospective",
      prospective_terms: { planned_drawing_ids: ["43"], first_drawing_id: "43" },
    });
    expect(f.trace.filter((s) => s.startsWith("rpc:drawing:"))).toEqual(["rpc:drawing:42"]);
    expect(f.trace).toContain("rpc:recurrence:100");
  });
  test("changed code/rule/settings, missing capability and a window closed during reads do not persist a quote", async () => {
    for (const [overrides, code] of [
      [{ badDeployment: true }, "schedule_unproven"],
      [{ badRuleHash: true }, "schedule_unproven"],
      [{ missingRecurrence: true }, "schedule_unproven"],
      [{ duration: 1801n }, "schedule_unproven"],
      [{ price: 9999n }, "schedule_unproven"],
      // At head time this has 2100 seconds left. At final observation it has
      // 2001, below the required2010. The pinned head is still fresh.
      [{ drawingTime: 1201n, nowMs: 100_000 }, "quote_expired"],
    ] as const) {
      const f = await fixture({ successor: true, ...overrides });
      await Effect.runPromise(f.producer.run(options));
      expect(f.contexts).toEqual([]);
      expect(f.failures).toEqual([code]);
    }
  });
  test("committed successor contexts retain the original plan, refuse drift and close fresh funding after initialization", async () => {
    const first = await fixture({ successor: true });
    await Effect.runPromise(first.producer.run(options));
    const originContext = Schema.decodeUnknownSync(C.ContextReadyV2)(first.contexts[0]);
    if (originContext.quote.kind !== "prospective") throw Error("Expected prospective fixture");
    const p = originContext.quote.prospective_terms;
    const target: C.CommittedTargetV2 = {
      ...p.target,
      kind: "committed",
      offer_id: "offer",
      pool_leg_id: "leg",
    };
    const bindings = p.qualification_templates.map((t) => ({
      ...t,
      binding_id: `binding-${t.activity}`,
      objective_id: `objective-${t.activity}`,
      offer_id: "offer",
      leg_id: "leg",
    }));
    const digest = (preimage: string) => Effect.runPromise(digestFundingPreimageV2(preimage));
    let terms: C.TermsV2 = {
      version: "shared-song-megapot-v2",
      profile_id: p.profile_id,
      profile_hash: p.profile_hash,
      terms_hash: h,
      funding_policy_revision: p.funding_policy_revision,
      funding_policy_hash: p.funding_policy_hash,
      budget_source: p.budget_source,
      empty_behavior: p.empty_behavior,
      eligible_activities: p.eligible_activities,
      dance_scope: p.dance_scope,
      starts_at: new Date(1000).toISOString(),
      ends_at: p.fixed_ends_at,
      first_drawing_id: p.first_drawing_id,
      last_planned_drawing_id: p.last_planned_drawing_id,
      ticket_price_ceiling_atomic: p.ticket_price_ceiling_atomic,
      disclosure_version: p.disclosure_version,
      origin_prospective_terms_hash: originContext.quote.prospective_terms_hash,
      origin_slot_generation: 0,
      reward_policy_hash: h,
      qualification_bindings: bindings,
      qualification_bindings_hash: await digest(
        C.fundingHashPreimageV2(
          "pirate.shared-song-qualification-bindings.v1",
          bindings.map(C.projectQualificationBinding),
        ),
      ),
      planned_drawing_ids: p.planned_drawing_ids,
      planned_schedule_hash: p.planned_schedule_hash,
    };
    terms = { ...terms, terms_hash: await digest(C.committedTermsPreimageV2(terms)) };
    const original = { target, terms, originContext };
    {
      const f = await fixture({ successor: true, original });
      await Effect.runPromise(f.producer.run(options));
      expect(f.failures).toEqual([]);
      const context = Schema.decodeUnknownSync(C.ContextReadyV2)(f.contexts[0]);
      expect(context.schedule.rows).toEqual(originContext.schedule.rows);
      expect(context.quote).toEqual({
        kind: "committed",
        committed_terms: terms,
        committed_terms_hash: terms.terms_hash,
      });
      expect(
        f.statements.some((s) => s.label === "shared-song.frozen-plan.read" && s.readonly),
      ).toBe(true);
    }
    // The original current drawing is due at 1801. Once its successor really
    // initializes, only 899 seconds remain to purchase; no fresh quote is allowed.
    const initialized = await fixture({
      successor: true,
      original,
      currentId: 43n,
      drawingTime: 3601n,
      headSeconds: 1802n,
      nowMs: 1_802_000,
    });
    await Effect.runPromise(initialized.producer.run(options));
    expect(initialized.contexts).toEqual([]);
    expect(initialized.failures).toEqual(["quote_expired"]);
    for (const drift of [
      { currentId: 44n },
      { drawingTime: 1802n },
      { currentId: 43n, drawingTime: 3600n },
      { currentId: 43n, drawingTime: 3601n, drawingPrice: 9999n },
    ]) {
      const f = await fixture({ successor: true, original, ...drift });
      await Effect.runPromise(f.producer.run(options));
      expect(f.contexts).toEqual([]);
      expect(f.failures).toEqual(["schedule_unproven"]);
    }
  });
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
