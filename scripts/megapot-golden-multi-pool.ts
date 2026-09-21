import {
  AddMegapotPoolLeg,
  GetSongMegapotPool,
  ObserveMegapotPoolFunding,
  OpenSongRewardOffer,
} from "@pirate/contracts";
import { type GoldenHttpOptions, requestJson } from "./megapot-golden-http.ts";
import type { GoldenJournalPort } from "./megapot-golden-journal.ts";
import type { MultiGoldenInput } from "./megapot-golden-multi-input.ts";

/** Never transfers funds or signs: returns instructions, then observes the owner's exact transfer. */
export async function prepareGoldenPool(
  input: MultiGoldenInput,
  options: GoldenHttpOptions,
  journal: GoldenJournalPort,
) {
  const deps = { fetcher: fetch };
  const guard = () => {
    if (
      !input.authorization ||
      Date.now() >= Date.parse(input.authorization.qualification_deadline)
    )
      throw new Error("Qualification window ended before pool mutation.");
  };
  const key = (step: string) => `megapot-golden-${input.run_id}-${step}`;
  const base = `/communities/${encodeURIComponent(input.community_id)}/posts/${encodeURIComponent(input.post_id)}`;
  let instructions: unknown = null;
  if (!journal.state.leg_id) {
    guard();
    const opened = await requestJson(
      deps,
      options,
      `${base}/reward-offers`,
      OpenSongRewardOffer.response,
      {
        method: "POST",
        body: {
          idempotency_key: key("offer"),
          persona_id: input.persona_id,
          starts_at: input.starts_at,
          ends_at: input.ends_at,
        },
      },
    );
    if (opened.offer.audio_revision !== input.audio_revision)
      throw new Error("Offer audio revision mismatch.");
    guard();
    const added = await requestJson(
      deps,
      options,
      `/reward-offers/${encodeURIComponent(opened.offer.offer_id)}/megapot-pool-legs`,
      AddMegapotPoolLeg.response,
      {
        method: "POST",
        body: {
          idempotency_key: key("leg"),
          persona_id: input.persona_id,
          funding_amount_atomic: input.funding_amount_atomic,
          max_ticket_price_atomic: input.max_ticket_price_atomic,
          entry_cutoff_seconds: input.entry_cutoff_seconds,
          eligible_activities: ["study", "karaoke"],
          min_score_bps: 7000,
          empty_pool_policy: "no_purchase",
          fallback_payout_persona_id: null,
          fallback_disclosure_acknowledged: false,
        },
      },
    );
    await journal.save({
      ...journal.state,
      leg_id: added.leg.leg_id,
      funding_effect_id: added.funding.funding_effect_id,
    });
    instructions = added.funding;
  }
  if (!input.funding_transaction_hash)
    return {
      state: "awaiting_funder_transfer" as const,
      instructions,
      leg_id: journal.state.leg_id,
      funding_effect_id: journal.state.funding_effect_id,
    };
  const legId = journal.state.leg_id;
  const fundingId = journal.state.funding_effect_id;
  if (!legId || !fundingId) throw new Error("Funding journal is incomplete.");
  guard();
  const funding = await requestJson(
    deps,
    options,
    `/reward-offer-legs/${encodeURIComponent(legId)}/funding/${encodeURIComponent(fundingId)}/observations`,
    ObserveMegapotPoolFunding.response,
    {
      method: "POST",
      body: {
        idempotency_key: key("funding"),
        persona_id: input.persona_id,
        transaction_hash: input.funding_transaction_hash,
      },
    },
  );
  if (funding.funding.status !== "confirmed")
    return {
      state: "funding_pending" as const,
      funding_status: funding.funding.status,
      leg_id: legId,
      funding_effect_id: fundingId,
    };
  const { pool } = await requestJson(
    deps,
    options,
    `${base}/rewards/megapot-pool`,
    GetSongMegapotPool.response,
  );
  if (
    !pool ||
    pool.leg_id !== legId ||
    !pool.drawing ||
    !input.authorization ||
    Date.parse(pool.drawing.entry_cutoff_at) <=
      Date.parse(input.authorization.qualification_deadline)
  ) {
    throw new Error("Exact funded drawing and safe qualification window required.");
  }
  if (journal.state.drawing_id && journal.state.drawing_id !== pool.drawing.drawing_id)
    throw new Error("Drawing changed; reconciliation only.");
  await journal.save({ ...journal.state, drawing_id: pool.drawing.drawing_id });
  return { state: "funded" as const, leg_id: legId, drawing_id: pool.drawing.drawing_id };
}
