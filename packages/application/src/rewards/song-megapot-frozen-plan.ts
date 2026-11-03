import { Effect, Schema } from "effect";
import * as C from "../../../contracts/src/rewards-song-contributions-v2.ts";
import {
  digestFundingPreimageV2,
  fundingContextPreimageV2,
  SongContributionFailure,
} from "./song-megapot-contributions.ts";

const Input = Schema.Struct({
  target: C.TargetV2,
  terms: C.TermsV2,
  originContext: C.ContextReadyV2,
  drawingId: C.UIntV2,
});
const refused = () => new SongContributionFailure({ code: "schedule_unproven" });

export type FrozenSongMegapotDrawing = Readonly<{
  drawingId: string;
  drawingTimeMs: number;
  entryCutoffAtMs: number;
  purchaseDeadlineAtMs: number;
  priceAtomic: bigint;
  proofKind: C.ScheduleRowV2["proof_kind"];
}>;

/** Recover the original plan, including its original proof kind. The expired
 * context is historical evidence only; this function grants no signing authority.
 * Callers must load it through the contribution's immutable snapshot lineage. */
export const resolveFrozenSongMegapotDrawing = Effect.fn("resolveFrozenSongMegapotDrawing")(
  function* (raw: unknown) {
    const {
      target,
      terms,
      originContext: context,
      drawingId,
    } = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(Input, { onExcessProperty: "error" })(raw),
      catch: refused,
    });
    if (
      target.kind !== "committed" ||
      context.target.kind !== "empty" ||
      context.quote.kind !== "prospective"
    )
      return yield* refused();
    const prospectus = context.quote.prospective_terms;
    const ids = terms.planned_drawing_ids;
    if (
      new Set(ids).size !== ids.length ||
      ids[0] !== terms.first_drawing_id ||
      ids.at(-1) !== terms.last_planned_drawing_id ||
      !ids.includes(drawingId) ||
      context.target.slot_generation !== terms.origin_slot_generation ||
      context.context_ref.slot_generation !== terms.origin_slot_generation ||
      context.context_ref.slot_id !== context.target.slot_id ||
      context.context_ref.profile_id !== terms.profile_id ||
      context.context_ref.profile_hash !== terms.profile_hash ||
      context.context_ref.funding_policy_hash !== terms.funding_policy_hash ||
      context.context_ref.schedule_witness_id !== context.schedule.schedule_witness_id ||
      context.actor.community_id !== target.community_id ||
      context.chain_id !== context.schedule.anchor.chain_id ||
      context.attestation_id !== context.schedule.anchor.attestation_id ||
      JSON.stringify(C.projectSongTarget(context.target)) !==
        JSON.stringify(C.projectSongTarget(target)) ||
      JSON.stringify(C.projectSongTarget(prospectus.target)) !==
        JSON.stringify(C.projectSongTarget(target)) ||
      context.quote.prospective_terms_hash !== terms.origin_prospective_terms_hash ||
      prospectus.profile_id !== terms.profile_id ||
      prospectus.profile_hash !== terms.profile_hash ||
      prospectus.funding_policy_hash !== terms.funding_policy_hash ||
      prospectus.funding_policy_revision !== terms.funding_policy_revision ||
      prospectus.fixed_ends_at !== terms.ends_at ||
      prospectus.first_drawing_id !== terms.first_drawing_id ||
      prospectus.last_planned_drawing_id !== terms.last_planned_drawing_id ||
      prospectus.ticket_price_ceiling_atomic !== terms.ticket_price_ceiling_atomic ||
      prospectus.disclosure_version !== terms.disclosure_version ||
      prospectus.planned_schedule_hash !== terms.planned_schedule_hash ||
      JSON.stringify(prospectus.planned_drawing_ids) !== JSON.stringify(ids) ||
      terms.qualification_bindings.some(
        (binding) => binding.offer_id !== target.offer_id || binding.leg_id !== target.pool_leg_id,
      )
    )
      return yield* refused();
    const order = ["study", "karaoke", "dance"];
    const bindings = [...terms.qualification_bindings].sort(
      (a, b) => order.indexOf(a.activity) - order.indexOf(b.activity),
    );
    const templates = [...prospectus.qualification_templates].sort(
      (a, b) => order.indexOf(a.activity) - order.indexOf(b.activity),
    );
    const bindingsHash = yield* digestFundingPreimageV2(
      C.fundingHashPreimageV2(
        "pirate.shared-song-qualification-bindings.v1",
        bindings.map(C.projectQualificationBinding),
      ),
    );
    if (
      bindingsHash !== terms.qualification_bindings_hash ||
      JSON.stringify(bindings.map(C.projectQualificationTemplate)) !==
        JSON.stringify(templates.map(C.projectQualificationTemplate)) ||
      (yield* digestFundingPreimageV2(C.committedTermsPreimageV2(terms))) !== terms.terms_hash ||
      (yield* digestFundingPreimageV2(C.prospectiveTermsPreimageV2(prospectus))) !==
        terms.origin_prospective_terms_hash ||
      (yield* digestFundingPreimageV2(fundingContextPreimageV2(context))) !== context.context_hash
    )
      return yield* refused();
    const rows = ids.map((id) => context.schedule.rows.filter((row) => row.drawing_id === id));
    if (rows.some((matches) => matches.length !== 1)) return yield* refused();
    const selected = rows.flat();
    const hash = yield* digestFundingPreimageV2(
      C.fundingHashPreimageV2(
        "pirate.shared-song-planned-schedule.v1",
        selected.map((row) => [
          row.drawing_id,
          row.drawing_time,
          row.entry_cutoff_at,
          row.purchase_deadline_at,
          row.price_atomic,
          row.proof_kind,
        ]),
      ),
    );
    const row = selected.find((r) => r.drawing_id === drawingId);
    if (
      row === undefined ||
      hash !== terms.planned_schedule_hash ||
      selected.at(-1)?.drawing_time !== terms.ends_at ||
      selected.some(
        (r) =>
          r.initialized !== (r.proof_kind === "initialized_state") ||
          BigInt(r.price_atomic) <= 0n ||
          BigInt(r.price_atomic) > BigInt(terms.ticket_price_ceiling_atomic) ||
          r.price_ceiling_atomic !== terms.ticket_price_ceiling_atomic ||
          Date.parse(r.entry_cutoff_at) > Date.parse(r.drawing_time) ||
          Date.parse(r.purchase_deadline_at) > Date.parse(r.drawing_time),
      )
    )
      return yield* refused();
    return {
      drawingId,
      drawingTimeMs: Date.parse(row.drawing_time),
      entryCutoffAtMs: Date.parse(row.entry_cutoff_at),
      purchaseDeadlineAtMs: Date.parse(row.purchase_deadline_at),
      priceAtomic: BigInt(row.price_atomic),
      proofKind: row.proof_kind,
    } satisfies FrozenSongMegapotDrawing;
  },
);

/** A projected row becomes spendable only when the actual current initialized
 * drawing matches it. A lower price or an earlier date also changes the plan. */
export function frozenSongMegapotPurchaseDeadline(
  plan: FrozenSongMegapotDrawing,
  actual: Readonly<{
    drawingId: bigint;
    drawingTime: bigint;
    ticketPrice: bigint;
    jackpotLock: boolean;
    entryCutoffSeconds: number;
  }>,
  minimumEntrySeconds: number,
): number | null {
  if (
    !Number.isSafeInteger(minimumEntrySeconds) ||
    minimumEntrySeconds < 60 ||
    !Number.isSafeInteger(actual.entryCutoffSeconds) ||
    actual.entryCutoffSeconds <= 0 ||
    actual.jackpotLock ||
    actual.drawingId.toString() !== plan.drawingId ||
    actual.drawingTime * 1000n !== BigInt(plan.drawingTimeMs) ||
    actual.ticketPrice !== plan.priceAtomic ||
    plan.entryCutoffAtMs !== plan.drawingTimeMs - actual.entryCutoffSeconds * 1000
  )
    return null;
  return Math.min(plan.purchaseDeadlineAtMs, plan.entryCutoffAtMs - minimumEntrySeconds * 1000);
}
