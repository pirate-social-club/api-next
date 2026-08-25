import { describe, expect, test } from "bun:test";
import type {
  MegapotCutoffCandidate,
  MegapotCutoffResult,
  MegapotCutoffStore,
} from "@pirate/application";
import type { MegapotBeneficiarySnapshot } from "@pirate/domain";
import { Effect } from "effect";
import { makeMegapotCutoffCoordinator } from "./megapot-cutoff-coordinator.ts";

const termsHash = `0x${"11".repeat(32)}`;
const frozenAt = "2026-08-26T12:00:00.000Z";

function candidate(input: Partial<MegapotCutoffCandidate> = {}): MegapotCutoffCandidate {
  return {
    poolLegId: "pool-leg-1",
    drawingId: 100n,
    version: 1,
    entryCutoffAt: "2026-08-26T11:59:00.000Z",
    termsHash,
    emptyPoolPolicy: "no_purchase",
    fundingSource: "leg_budget",
    fallbackBeneficiary: null,
    shares: [
      { accountId: "account-b", personaId: "persona-b" },
      { accountId: "account-a", personaId: "persona-a" },
    ],
    ...input,
  };
}

function result(value: MegapotCutoffCandidate, snapshot: MegapotBeneficiarySnapshot | null) {
  return {
    poolLegId: value.poolLegId,
    drawingId: value.drawingId,
    version: 2,
    status: snapshot === null ? "closed_no_entries" : "cutoff_frozen",
    frozenShareCount: value.shares.length,
    fallback: snapshot?.published.fallback ?? false,
    reservedTicketCostAtomic: snapshot === null ? 0n : 10_000n,
    snapshotId: snapshot === null ? null : `snapshot-${value.drawingId}`,
    snapshotHash: snapshot?.published.snapshotHash ?? null,
    terminalReason: snapshot === null ? "no_entries" : null,
  } satisfies MegapotCutoffResult;
}

describe("Megapot cutoff coordinator", () => {
  test("builds a private deterministic participant snapshot at cutoff", async () => {
    const due = candidate();
    const recorded: Array<MegapotBeneficiarySnapshot | null> = [];
    const store: MegapotCutoffStore = {
      loadDue: () => Effect.succeed([due]),
      freeze: (input) => {
        recorded.push(input.snapshot);
        return Effect.succeed(result(input.candidate, input.snapshot));
      },
    };
    const coordinator = makeMegapotCutoffCoordinator({
      store,
      externalSponsorDailyTicketCeiling: 5,
      externalSponsorDailySpendCeilingAtomic: 50_000n,
      sharedSponsorDailyTicketCeiling: 10,
      sharedSponsorDailySpendCeilingAtomic: 100_000n,
      now: () => Date.parse(frozenAt),
    });
    const outcomes = await Effect.runPromise(coordinator.freezeDue());
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: "cutoff_frozen", frozenShareCount: 2 });
    const snapshot = recorded[0];
    if (snapshot === null || snapshot === undefined) throw new Error("missing snapshot");
    expect(snapshot.published.leafCount).toBe(2);
    expect(snapshot.published.fallback).toBe(false);
    expect(JSON.stringify(snapshot.published)).not.toContain("account-");
    expect(snapshot.privateLeaves.map((leaf) => leaf.accountId).sort()).toEqual([
      "account-a",
      "account-b",
    ]);
  });

  test("closes no-entry drawings without manufacturing a beneficiary", async () => {
    const due = candidate({ shares: [] });
    const store: MegapotCutoffStore = {
      loadDue: () => Effect.succeed([due]),
      freeze: (input) => Effect.succeed(result(input.candidate, input.snapshot)),
    };
    const coordinator = makeMegapotCutoffCoordinator({
      store,
      externalSponsorDailyTicketCeiling: 5,
      externalSponsorDailySpendCeilingAtomic: 50_000n,
      sharedSponsorDailyTicketCeiling: 10,
      sharedSponsorDailySpendCeilingAtomic: 100_000n,
      now: () => Date.parse(frozenAt),
    });
    await expect(Effect.runPromise(coordinator.freezeDue())).resolves.toEqual([
      {
        poolLegId: due.poolLegId,
        drawingId: due.drawingId,
        version: 2,
        status: "closed_no_entries",
        frozenShareCount: 0,
        fallback: false,
        reservedTicketCostAtomic: 0n,
        snapshotId: null,
        snapshotHash: null,
        terminalReason: "no_entries",
      },
    ]);
  });

  test("uses the frozen sponsor only when a fallback drawing has no shares", async () => {
    const due = candidate({
      emptyPoolPolicy: "funder_fallback",
      fallbackBeneficiary: { accountId: "sponsor-account", personaId: "sponsor-persona" },
      shares: [],
    });
    const recorded: MegapotBeneficiarySnapshot[] = [];
    const store: MegapotCutoffStore = {
      loadDue: () => Effect.succeed([due]),
      freeze: (input) => {
        if (input.snapshot !== null) recorded.push(input.snapshot);
        return Effect.succeed(result(input.candidate, input.snapshot));
      },
    };
    const coordinator = makeMegapotCutoffCoordinator({
      store,
      externalSponsorDailyTicketCeiling: 5,
      externalSponsorDailySpendCeilingAtomic: 50_000n,
      sharedSponsorDailyTicketCeiling: 10,
      sharedSponsorDailySpendCeilingAtomic: 100_000n,
      now: () => Date.parse(frozenAt),
    });
    const [outcome] = await Effect.runPromise(coordinator.freezeDue());
    expect(outcome).toMatchObject({ status: "cutoff_frozen", fallback: true });
    expect(recorded[0]?.privateLeaves).toMatchObject([
      { accountId: "sponsor-account", personaId: "sponsor-persona" },
    ]);
  });
});
