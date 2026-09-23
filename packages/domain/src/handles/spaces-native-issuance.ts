/**
 * Native Spaces claim issuance (spec 012 §5.3.13.5, §5.3.13.7, §5.3.13.8).
 * One pure reducer moves a claim, its registry item, the handle key fence,
 * and the account-cap reservation together, because every event is applied
 * in one transaction. Callers load the current rows, apply the decision, and
 * persist it. Nothing here frees a name on time, retry exhaustion, or a
 * missing callback: only an acknowledged outcome, final verification, or a
 * stop before any possible delivery changes the fence or the cap.
 */

/** The six upstream registry outcomes (subs 4dcc923 `REGISTRY.md`). */
export type SpacesUpstreamAckOutcomeV1 =
  | "staged"
  | "already_staged_same_spk"
  | "already_committed_same_spk"
  | "already_staged_different_spk"
  | "already_committed_different_spk"
  | "invalid";

/** The HNS `blocked` state has no Spaces transition. */
export type SpacesClaimStateV1 = "issuance_pending" | "issued" | "issuance_failed";

export type SpacesRegistryItemStateV1 =
  /** No `/pending` response has included the item. */
  | "undelivered"
  /** A `/pending` response may have included it; redelivered until acknowledged. */
  | "delivered"
  /** Possibly delivered, never delivered again, and still unresolved upstream. */
  | "redelivery_stopped"
  | "settled_same_spk"
  | "settled_different_spk"
  | "settled_invalid"
  /** Retired without any delivery. */
  | "withdrawn";

export type SpacesHandleKeyFenceStateV1 =
  /** References the claim. */
  | "pending_issuance"
  /** References the acknowledgment observation; survives the losing claim. */
  | "external_conflict"
  | "permanent_grant"
  | "released";

export type SpacesCapReservationStateV1 = "reserved" | "converted_to_grant" | "released";

export type SpacesIssuanceStateV1 = Readonly<{
  claim: SpacesClaimStateV1;
  item: SpacesRegistryItemStateV1;
  fence: SpacesHandleKeyFenceStateV1;
  cap: SpacesCapReservationStateV1;
  /** Verification is accelerated; the reconciler still leases every pending claim. */
  verification_due: boolean;
}>;

export type SpacesIssuanceEventV1 =
  | Readonly<{ kind: "delivery_recorded" }>
  | Readonly<{
      kind: "acknowledged";
      outcome: SpacesUpstreamAckOutcomeV1;
      /** Whether another unresolved delivery of the same handle key could still issue it. */
      unresolved_delivery_of_key_remains: boolean;
    }>
  | Readonly<{ kind: "committed_hint" }>
  | Readonly<{ kind: "final_issuance_verified"; owner_persona_retired: boolean }>
  | Readonly<{ kind: "key_deliveries_resolved" }>
  | Readonly<{ kind: "platform_stop" }>;

export type SpacesCapChangeV1 =
  | "reserve"
  | "release"
  | "convert_to_active_grant"
  | "convert_to_tombstoned_grant";

export type SpacesIssuanceDecisionV1 =
  | Readonly<{
      kind: "applied";
      next: SpacesIssuanceStateV1;
      cap_change: SpacesCapChangeV1 | null;
      grant_status: "active" | "tombstoned" | null;
      alert: "invalid_outcome" | null;
    }>
  /** An idempotent replay or a no-op; nothing is written. */
  | Readonly<{ kind: "unchanged" }>
  /** Never applied; recorded as a scope anomaly and alerted. */
  | Readonly<{
      kind: "scope_anomaly";
      reason: "no_delivered_item" | "contradicts_recorded_outcome";
    }>
  | Readonly<{ kind: "refused"; reason: "not_deliverable" | "claim_terminal" }>;

const SAME_OWNER: ReadonlySet<SpacesUpstreamAckOutcomeV1> = new Set([
  "staged",
  "already_staged_same_spk",
  "already_committed_same_spk",
]);
const OTHER_OWNER: ReadonlySet<SpacesUpstreamAckOutcomeV1> = new Set([
  "already_staged_different_spk",
  "already_committed_different_spk",
]);

const settledItem = (outcome: SpacesUpstreamAckOutcomeV1): SpacesRegistryItemStateV1 =>
  SAME_OWNER.has(outcome)
    ? "settled_same_spk"
    : OTHER_OWNER.has(outcome)
      ? "settled_different_spk"
      : "settled_invalid";
const neverDelivered = (item: SpacesRegistryItemStateV1): boolean =>
  item === "undelivered" || item === "withdrawn";
const awaitingOutcome = (item: SpacesRegistryItemStateV1): boolean =>
  item === "delivered" || item === "redelivery_stopped";

const applied = (
  next: SpacesIssuanceStateV1,
  extra: Partial<
    Omit<Extract<SpacesIssuanceDecisionV1, { kind: "applied" }>, "kind" | "next">
  > = {},
): SpacesIssuanceDecisionV1 => ({
  kind: "applied",
  next,
  cap_change: extra.cap_change ?? null,
  grant_status: extra.grant_status ?? null,
  alert: extra.alert ?? null,
});
const UNCHANGED: SpacesIssuanceDecisionV1 = { kind: "unchanged" };

function acknowledge(
  state: SpacesIssuanceStateV1,
  event: Extract<SpacesIssuanceEventV1, { kind: "acknowledged" }>,
): SpacesIssuanceDecisionV1 {
  if (neverDelivered(state.item)) return { kind: "scope_anomaly", reason: "no_delivered_item" };
  const item = settledItem(event.outcome);
  if (!awaitingOutcome(state.item)) {
    return state.item === item
      ? UNCHANGED
      : { kind: "scope_anomaly", reason: "contradicts_recorded_outcome" };
  }
  if (state.claim === "issued") {
    // Verification can beat the acknowledgment; only a same-owner outcome agrees with it.
    return SAME_OWNER.has(event.outcome)
      ? applied({ ...state, item })
      : { kind: "scope_anomaly", reason: "contradicts_recorded_outcome" };
  }
  if (state.claim === "issuance_failed") return { kind: "refused", reason: "claim_terminal" };
  if (SAME_OWNER.has(event.outcome)) {
    // The acknowledgment alone never creates a grant; verification is independent.
    return applied({ ...state, item, verification_due: true });
  }
  const failed = {
    ...state,
    item,
    claim: "issuance_failed",
    cap: "released",
    verification_due: false,
  } as const;
  if (OTHER_OWNER.has(event.outcome)) {
    return applied({ ...failed, fence: "external_conflict" }, { cap_change: "release" });
  }
  return applied(
    { ...failed, fence: event.unresolved_delivery_of_key_remains ? state.fence : "released" },
    { cap_change: "release", alert: "invalid_outcome" },
  );
}

function finalize(
  state: SpacesIssuanceStateV1,
  ownerPersonaRetired: boolean,
): SpacesIssuanceDecisionV1 {
  if (state.claim === "issued") return UNCHANGED;
  if (state.claim === "issuance_failed") return { kind: "refused", reason: "claim_terminal" };
  const item =
    state.item === "undelivered"
      ? "withdrawn"
      : state.item === "delivered"
        ? "redelivery_stopped"
        : state.item;
  return applied(
    {
      claim: "issued",
      item,
      fence: "permanent_grant",
      cap: "converted_to_grant",
      verification_due: false,
    },
    ownerPersonaRetired
      ? { cap_change: "convert_to_tombstoned_grant", grant_status: "tombstoned" }
      : { cap_change: "convert_to_active_grant", grant_status: "active" },
  );
}

/**
 * Before any `/pending` response may have included the item, a stop withdraws
 * it and releases the fence and cap. Afterwards it only stops redelivery; the
 * fence, the cap reservation, and reconciliation stay until upstream work is
 * resolved, and the member keeps seeing the claim as pending.
 */
function stop(state: SpacesIssuanceStateV1): SpacesIssuanceDecisionV1 {
  if (state.claim !== "issuance_pending") return UNCHANGED;
  if (state.item === "undelivered") {
    return applied(
      {
        claim: "issuance_failed",
        item: "withdrawn",
        fence: "released",
        cap: "released",
        verification_due: false,
      },
      { cap_change: "release" },
    );
  }
  return state.item === "delivered" ? applied({ ...state, item: "redelivery_stopped" }) : UNCHANGED;
}

export function reduceSpacesIssuanceV1(
  state: SpacesIssuanceStateV1,
  event: SpacesIssuanceEventV1,
): SpacesIssuanceDecisionV1 {
  switch (event.kind) {
    case "delivery_recorded":
      return state.claim === "issuance_pending" &&
        (state.item === "undelivered" || state.item === "delivered")
        ? applied({ ...state, item: "delivered" })
        : { kind: "refused", reason: "not_deliverable" };
    case "acknowledged":
      return acknowledge(state, event);
    case "committed_hint":
      // A reconciliation hint only; it never creates a grant.
      if (neverDelivered(state.item)) return { kind: "scope_anomaly", reason: "no_delivered_item" };
      return state.claim === "issuance_pending" && !state.verification_due
        ? applied({ ...state, verification_due: true })
        : UNCHANGED;
    case "final_issuance_verified":
      return finalize(state, event.owner_persona_retired);
    case "key_deliveries_resolved":
      return state.claim === "issuance_failed" &&
        state.item === "settled_invalid" &&
        state.fence === "pending_issuance"
        ? applied({ ...state, fence: "released" })
        : UNCHANGED;
    case "platform_stop":
      return stop(state);
  }
}

/** Account-scoped counter; sibling personas of one account share it. */
export type SpacesAccountCapCounterV1 = Readonly<{
  active_grant_count: number;
  pending_issuance_count: number;
}>;

/** A pending Spaces claim occupies a slot from submission, so finalization never exceeds the cap. */
export function spacesAccountCapAdmitsV1(
  maxActiveGrantsPerAccount: number | null,
  counter: SpacesAccountCapCounterV1,
): boolean {
  return (
    maxActiveGrantsPerAccount === null ||
    counter.active_grant_count + counter.pending_issuance_count < maxActiveGrantsPerAccount
  );
}

/**
 * A tombstoned-at-birth grant (persona retired while pending) is inserted
 * active and tombstoned in the same transaction, so the active count nets to
 * zero while the pending slot is still consumed exactly once.
 */
export function applySpacesCapChangeV1(
  counter: SpacesAccountCapCounterV1,
  change: SpacesCapChangeV1,
): SpacesAccountCapCounterV1 {
  if (change === "reserve") {
    return { ...counter, pending_issuance_count: counter.pending_issuance_count + 1 };
  }
  if (counter.pending_issuance_count < 1) throw new TypeError("No pending issuance reservation");
  const pending_issuance_count = counter.pending_issuance_count - 1;
  return change === "convert_to_active_grant"
    ? { active_grant_count: counter.active_grant_count + 1, pending_issuance_count }
    : { ...counter, pending_issuance_count };
}

/** Submission reserves one slot and starts the claim pending with an undelivered item. */
export function submitSpacesClaimV1(input: {
  max_active_grants_per_account: number | null;
  counter: SpacesAccountCapCounterV1;
}):
  | Readonly<{
      kind: "accepted";
      state: SpacesIssuanceStateV1;
      counter: SpacesAccountCapCounterV1;
    }>
  | Readonly<{ kind: "refused"; reason: "account_grant_limit_reached" }> {
  if (!spacesAccountCapAdmitsV1(input.max_active_grants_per_account, input.counter)) {
    return { kind: "refused", reason: "account_grant_limit_reached" };
  }
  return {
    kind: "accepted",
    state: {
      claim: "issuance_pending",
      item: "undelivered",
      fence: "pending_issuance",
      cap: "reserved",
      verification_due: false,
    },
    counter: applySpacesCapChangeV1(input.counter, "reserve"),
  };
}

export type SpacesCapClaimRecordV1 = Readonly<{
  account_id: string;
  owner_persona_id: string;
  offering_id: string;
  claim: SpacesClaimStateV1;
  grant_status: "active" | "revoked" | "tombstoned" | null;
}>;

/**
 * Recomputes the counter for `(account_id, offering_id)` from claim records
 * of every persona of that account. Only pending claims and active grants
 * occupy slots.
 */
export function tallySpacesAccountCapV1(input: {
  account_id: string;
  offering_id: string;
  records: readonly SpacesCapClaimRecordV1[];
}): SpacesAccountCapCounterV1 {
  let active_grant_count = 0;
  let pending_issuance_count = 0;
  for (const record of input.records) {
    if (record.account_id !== input.account_id || record.offering_id !== input.offering_id) {
      continue;
    }
    if (record.claim === "issuance_pending") pending_issuance_count += 1;
    if (record.claim === "issued" && record.grant_status === "active") active_grant_count += 1;
  }
  return { active_grant_count, pending_issuance_count };
}

/**
 * `delayed` is meaningful only while pending: commits are paused for any
 * reason, or the claim is past its overdue alert. With no observation the
 * pause is unknown, so it is not reported (ruling Q6).
 */
export function spacesClaimDelayedV1(input: {
  claim: SpacesClaimStateV1;
  commits_paused: boolean | null;
  past_overdue_alert: boolean;
}): boolean {
  return (
    input.claim === "issuance_pending" &&
    (input.commits_paused === true || input.past_overdue_alert)
  );
}
