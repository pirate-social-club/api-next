import { expect, test } from "bun:test";
import { shutdownPredicates } from "./database-evidence.mjs";
import { assertRefundScope, refundScopeQuery } from "./refund-scope.mjs";

const pin = {
  offerId: "offer-1",
  legId: "leg-1",
  fundingEffectId: "0xfunding",
  sponsor: "0x8b4fa94e81ea7ae27f9f290f4dee663e69355fe3",
  principalAtomic: "1000000",
};
const nothing = Object.fromEntries(shutdownPredicates.map(([category]) => [category, []]));
const refund = {
  refund_effect_id: "0xrefund",
  leg_id: "leg-1",
  funding_effect_id: "0xfunding",
  destination_address: pin.sponsor,
  amount_atomic: "1000000",
};
// Before the jobs Worker confirms: the offer, its leg and its funding are open.
const unconfirmed = {
  ...nothing,
  open_offers: ["offer-1"],
  open_legs: ["leg-1"],
  unresolved_funding: ["0xfunding"],
  refunds: [],
};
// While the refund is in flight: the leg owes its principal and one effect is unresolved.
const refunding = {
  ...nothing,
  leg_liabilities: ["leg-1"],
  unresolved_chain_effects: ["0xrefund"],
  refunds: [refund],
};
const refusal = (scope: Record<string, unknown>) => {
  try {
    assertRefundScope(scope, pin);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
};

test("the query reads every canonical shutdown category, by row", () => {
  const query = refundScopeQuery();
  for (const [category, table, predicate] of shutdownPredicates) {
    expect(query).toContain(`AS ${category}`);
    expect(query).toContain(`FROM api_next.${table} WHERE ${predicate}`);
  }
});

test("the pinned funding alone is accepted at each stage, and so is a clean stack", () => {
  expect(refusal(unconfirmed)).toBeNull();
  expect(refusal(refunding)).toBeNull();
  expect(refusal({ ...nothing, refunds: [refund] })).toBeNull();
});

test("another leg's liability is refused even when that leg is terminal", () => {
  expect(refusal({ ...refunding, leg_liabilities: ["leg-1", "leg-old"] })).toContain(
    "leg_liabilities: leg-old is outside the pinned funding",
  );
});

test("a sponsor liability is refused", () => {
  expect(refusal({ ...refunding, sponsor_liabilities: ["account-9:84532:0xtoken"] })).toContain(
    "sponsor_liabilities: account-9:84532:0xtoken",
  );
});

test("an unresolved chain effect that is not the pinned refund is refused", () => {
  expect(refusal({ ...refunding, unresolved_chain_effects: ["0xrefund", "0xpurchase"] })).toContain(
    "unresolved_chain_effects: 0xpurchase",
  );
  // With no refund row at all, no chain effect is permitted.
  expect(refusal({ ...unconfirmed, unresolved_chain_effects: ["0xother"] })).toContain(
    "unresolved_chain_effects: 0xother",
  );
});

test("another open offer, leg or funding is refused", () => {
  expect(refusal({ ...unconfirmed, open_offers: ["offer-1", "offer-2"] })).toContain("offer-2");
  expect(refusal({ ...unconfirmed, open_legs: ["leg-2"] })).toContain("leg-2");
  expect(refusal({ ...unconfirmed, unresolved_funding: ["0xfunding", "0xelse"] })).toContain(
    "0xelse",
  );
});

test("a credit, a drawing, a gas top-up or a winner send is refused", () => {
  for (const category of [
    "unpaid_credits",
    "unresolved_drawings",
    "unresolved_gas_topups",
    "unresolved_winner_sends",
  ])
    expect(refusal({ ...refunding, [category]: ["row-1"] })).toContain(`${category}: row-1`);
});

test("a refund that is not the whole principal to the sponsor is refused, and so is its chain effect", () => {
  for (const wrong of [
    { amount_atomic: "990000" },
    { destination_address: "0x0000000000000000000000000000000000000001" },
    { funding_effect_id: "0xelse" },
  ]) {
    const message = refusal({ ...refunding, refunds: [{ ...refund, ...wrong }] });
    expect(message).toContain("refund 0xrefund is not the pinned refund");
    expect(message).toContain("unresolved_chain_effects: 0xrefund");
  }
  expect(
    refusal({ ...refunding, refunds: [refund, { ...refund, refund_effect_id: "0xsecond" }] }),
  ).toContain("more than one refund");
});

test("a category that cannot be read is refused rather than taken as empty", () => {
  const partial: Record<string, unknown> = { ...refunding };
  delete partial.unpaid_credits;
  expect(refusal(partial)).toContain("unpaid_credits unreadable");
});
