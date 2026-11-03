import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import * as C from "../../../contracts/src/rewards-song-contributions-v2.ts";
import { songFundingContextFixture } from "../../../testing/src/song-funding-context-fixture.ts";
import { buildSongMegapotFundingContext } from "./song-megapot-context.ts";
import { digestFundingPreimageV2 } from "./song-megapot-contributions.ts";
import {
  frozenSongMegapotPurchaseDeadline,
  resolveFrozenSongMegapotDrawing,
} from "./song-megapot-frozen-plan.ts";

const start = 1_800_000_000_000;
const drawingTime = start + 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const hash = (s: string) => Effect.runPromise(digestFundingPreimageV2(s));

async function fixture(projected = true) {
  const facts = songFundingContextFixture();
  const capacity = facts.capacityProfile;
  const schedule = facts.schedule;
  if (capacity === null || schedule === null) throw Error("Expected capacity fixture");
  const row = {
    id: "43",
    drawingTime,
    entryCutoff: drawingTime - 120_000,
    purchaseDeadline: drawingTime - 900_000,
    priceAtomic: 1_000_000n,
    proof: projected ? ("attested_recurrence" as const) : ("initialized_state" as const),
    state: "uncommitted" as const,
    reservedCostAtomic: 0n,
  };
  const context = await Effect.runPromise(
    buildSongMegapotFundingContext({
      ...facts,
      now: start,
      capacityProfile: {
        ...capacity,
        maxDrawings: 1,
        reservationMs: 60_000,
        safetyMarginMs: 30_000,
        maximumWitnessAgeMs: 120_000,
        validUntil: start + 7_200_000,
        attestationValidUntil: start + 7_200_000,
      },
      schedule: {
        ...schedule,
        observedAt: start,
        validUntil: start + 120_000,
        recurrenceProven: projected,
        rows: [row],
      },
      wireSchedule: {
        ...facts.wireSchedule,
        anchor: {
          ...facts.wireSchedule.anchor,
          block_timestamp: iso(start),
          observed_at: iso(start),
        },
        valid_until: iso(start + 120_000),
        rows: [
          {
            drawing_id: row.id,
            drawing_time: iso(row.drawingTime),
            entry_cutoff_at: iso(row.entryCutoff),
            purchase_deadline_at: iso(row.purchaseDeadline),
            price_atomic: row.priceAtomic.toString(),
            price_ceiling_atomic: "1000000",
            initialized: !projected,
            proof_kind: row.proof,
          },
        ],
      },
    }),
  );
  if (context.quote.kind !== "prospective") throw Error("Expected prospective fixture");
  const p = context.quote.prospective_terms;
  const target = { ...p.target, kind: "committed" as const, offer_id: "offer", pool_leg_id: "leg" };
  const bindings = p.qualification_templates.map((t) => ({
    ...t,
    binding_id: `binding-${t.activity}`,
    objective_id: `objective-${t.activity}`,
    offer_id: target.offer_id,
    leg_id: target.pool_leg_id,
  }));
  let terms: C.TermsV2 = {
    version: "shared-song-megapot-v2",
    profile_id: p.profile_id,
    profile_hash: p.profile_hash,
    terms_hash: "0".repeat(64),
    funding_policy_revision: p.funding_policy_revision,
    funding_policy_hash: p.funding_policy_hash,
    budget_source: p.budget_source,
    empty_behavior: p.empty_behavior,
    eligible_activities: p.eligible_activities,
    dance_scope: p.dance_scope,
    starts_at: iso(start),
    ends_at: p.fixed_ends_at,
    first_drawing_id: p.first_drawing_id,
    last_planned_drawing_id: p.last_planned_drawing_id,
    ticket_price_ceiling_atomic: p.ticket_price_ceiling_atomic,
    disclosure_version: p.disclosure_version,
    origin_prospective_terms_hash: context.quote.prospective_terms_hash,
    origin_slot_generation: 0,
    reward_policy_hash: "a".repeat(64),
    qualification_bindings: bindings,
    qualification_bindings_hash: await hash(
      C.fundingHashPreimageV2(
        "pirate.shared-song-qualification-bindings.v1",
        bindings.map(C.projectQualificationBinding),
      ),
    ),
    planned_drawing_ids: p.planned_drawing_ids,
    planned_schedule_hash: p.planned_schedule_hash,
  };
  terms = { ...terms, terms_hash: await hash(C.committedTermsPreimageV2(terms)) };
  return { target, terms, originContext: context, drawingId: "43" };
}

describe("frozen shared-song drawing plan", () => {
  test("resolves a projected row from its original hashes without turning it into an initialized proof", async () => {
    const input = await fixture();
    const before = JSON.stringify(input);
    const plan = await Effect.runPromise(resolveFrozenSongMegapotDrawing(input));
    expect(plan).toEqual({
      drawingId: "43",
      drawingTimeMs: drawingTime,
      entryCutoffAtMs: drawingTime - 120_000,
      purchaseDeadlineAtMs: drawingTime - 900_000,
      priceAtomic: 1_000_000n,
      proofKind: "attested_recurrence",
    });
    expect(JSON.stringify(input)).toBe(before);
    const actual = {
      drawingId: 43n,
      drawingTime: BigInt(drawingTime / 1000),
      ticketPrice: 1_000_000n,
      jackpotLock: false,
      entryCutoffSeconds: 120,
    };
    expect(frozenSongMegapotPurchaseDeadline(plan, actual, 600)).toBe(drawingTime - 900_000);
    expect(frozenSongMegapotPurchaseDeadline(plan, actual, 1000)).toBe(drawingTime - 1_120_000);
  });

  test("actual drawing drift in either direction, wrong ID, lock or cutoff refuses purchase", async () => {
    const plan = await Effect.runPromise(resolveFrozenSongMegapotDrawing(await fixture()));
    const actual = {
      drawingId: 43n,
      drawingTime: BigInt(drawingTime / 1000),
      ticketPrice: 1_000_000n,
      jackpotLock: false,
      entryCutoffSeconds: 120,
    };
    for (const change of [
      { drawingId: 44n },
      { drawingTime: actual.drawingTime - 1n },
      { drawingTime: actual.drawingTime + 1n },
      { ticketPrice: 999_999n },
      { ticketPrice: 1_000_001n },
      { ticketPrice: 0n },
      { jackpotLock: true },
      { entryCutoffSeconds: 121 },
    ])
      expect(frozenSongMegapotPurchaseDeadline(plan, { ...actual, ...change }, 600)).toBeNull();
    expect(frozenSongMegapotPurchaseDeadline(plan, actual, 59)).toBeNull();
  });

  test("original initialized plans retain their proof and deadline", async () => {
    const plan = await Effect.runPromise(resolveFrozenSongMegapotDrawing(await fixture(false)));
    expect(plan.proofKind).toBe("initialized_state");
    expect(plan.purchaseDeadlineAtMs).toBe(drawingTime - 900_000);
  });

  test("rewritten frozen rows, proof kind or a foreign lineage cannot be substituted", async () => {
    const input = await fixture();
    const originalRow = input.originContext.schedule.rows[0];
    if (originalRow === undefined) throw Error("Expected frozen row");
    const changed = (row: Partial<C.ScheduleRowV2>) => ({
      ...input,
      originContext: {
        ...input.originContext,
        schedule: {
          ...input.originContext.schedule,
          rows: [{ ...originalRow, ...row }],
        },
      },
    });
    for (const candidate of [
      changed({ price_atomic: "999999" }),
      changed({ drawing_time: iso(drawingTime - 1000) }),
      changed({ proof_kind: "initialized_state", initialized: true }),
      { ...input, drawingId: "44" },
      { ...input, target: { ...input.target, post_id: "another-song" } },
      { ...input, terms: { ...input.terms, terms_hash: "b".repeat(64) } },
      { ...input, terms: { ...input.terms, origin_prospective_terms_hash: "b".repeat(64) } },
      {
        ...input,
        terms: {
          ...input.terms,
          qualification_bindings: input.terms.qualification_bindings.map((b) => ({
            ...b,
            objective_id: `foreign-${b.activity}`,
          })),
        },
      },
    ])
      await expect(
        Effect.runPromise(resolveFrozenSongMegapotDrawing(candidate)),
      ).rejects.toMatchObject({ code: "schedule_unproven" });
  });
});
