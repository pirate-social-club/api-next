import {
  AddMegapotPoolLeg,
  GetMegapotPoolFunding,
  GetSongMegapotPool,
  ObserveMegapotPoolFunding,
  OpenSongRewardOffer,
} from "@pirate/contracts";
import {
  type GoldenHttpDependencies,
  type GoldenHttpOptions,
  requestJson,
} from "./megapot-golden-http.ts";
import type { GoldenJournalPort } from "./megapot-golden-journal.ts";
import type { MultiGoldenInput } from "./megapot-golden-multi-input.ts";

/** Adoption performs only GETs. The app has already signed and observed funding. */
async function adoptGoldenPool(
  input: MultiGoldenInput,
  options: GoldenHttpOptions,
  journal: GoldenJournalPort,
  deps: GoldenHttpDependencies,
) {
  const adopted = input.app_funded_pool;
  if (!adopted || !input.authorization) throw new Error("App-funded handoff is incomplete.");
  if (
    (journal.state.leg_id && journal.state.leg_id !== adopted.leg_id) ||
    (journal.state.funding_effect_id &&
      journal.state.funding_effect_id !== adopted.funding_effect_id)
  ) {
    throw new Error("App-funded handoff differs from the journal; reconciliation only.");
  }
  const base = `/communities/${encodeURIComponent(input.community_id)}/posts/${encodeURIComponent(input.post_id)}`;
  const { funding } = await requestJson(
    deps,
    options,
    `/reward-offer-legs/${encodeURIComponent(adopted.leg_id)}/funding/${encodeURIComponent(adopted.funding_effect_id)}`,
    GetMegapotPoolFunding.response,
  );
  const { pool } = await requestJson(
    deps,
    options,
    `${base}/rewards/megapot-pool`,
    GetSongMegapotPool.response,
  );
  if (
    funding.funding_effect_id !== adopted.funding_effect_id ||
    funding.leg_id !== adopted.leg_id ||
    funding.status !== "confirmed" ||
    funding.sender_address !== adopted.sender_address ||
    funding.transaction_hash !== adopted.transaction_hash ||
    funding.expected_amount_atomic !== input.funding_amount_atomic ||
    funding.confirmed_amount_atomic !== input.funding_amount_atomic ||
    !pool ||
    pool.offer_id !== adopted.offer_id ||
    pool.leg_id !== adopted.leg_id ||
    pool.community_id !== input.community_id ||
    pool.post_id !== input.post_id ||
    pool.offer_status !== "active" ||
    pool.leg_status !== "active" ||
    pool.chain_id !== 84532 ||
    pool.token_address !== funding.token_address ||
    pool.token_decimals !== 6 ||
    pool.funded_atomic !== input.funding_amount_atomic ||
    pool.available_budget_atomic !== input.funding_amount_atomic ||
    pool.max_ticket_price_atomic !== input.max_ticket_price_atomic ||
    pool.entry_cutoff_seconds !== input.entry_cutoff_seconds ||
    pool.eligible_activities.length !== 2 ||
    !pool.eligible_activities.includes("study") ||
    !pool.eligible_activities.includes("karaoke") ||
    pool.min_score_bps !== 7000 ||
    pool.empty_pool_policy !== "no_purchase" ||
    pool.allocation_rule !== "equal_v1" ||
    pool.ticket_custody !== "pirate" ||
    !pool.drawing ||
    pool.drawing.lifecycle_status !== "entry_open" ||
    pool.drawing.actual_ticket_cost_atomic !== "0" ||
    BigInt(pool.drawing.ticket_price_ceiling_atomic) > BigInt(input.max_ticket_price_atomic) ||
    Date.parse(pool.drawing.entry_cutoff_at) <=
      Date.parse(input.authorization.qualification_deadline)
  ) {
    throw new Error("App-funded pool does not match the exact open approved drawing.");
  }
  if (journal.state.drawing_id && journal.state.drawing_id !== pool.drawing.drawing_id)
    throw new Error("Drawing changed; reconciliation only.");
  await journal.save({
    ...journal.state,
    leg_id: adopted.leg_id,
    funding_effect_id: adopted.funding_effect_id,
    drawing_id: pool.drawing.drawing_id,
  });
  return { state: "funded" as const, leg_id: adopted.leg_id, drawing_id: pool.drawing.drawing_id };
}

/** Never transfers funds or signs: returns instructions, then observes the owner's exact transfer. */
export async function prepareGoldenPool(
  input: MultiGoldenInput,
  options: GoldenHttpOptions,
  journal: GoldenJournalPort,
  deps: GoldenHttpDependencies = { fetcher: fetch },
) {
  if (input.app_funded_pool) return adoptGoldenPool(input, options, journal, deps);
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
