// Settlement failure fencing (api-next 000 §6): reclaimable means an explicit
// pre-broadcast failure ONLY — the effect may safely retry. Ambiguous means a
// broadcast may be in flight; it is reconciliation-only and must never be
// re-broadcast. Legacy rows predate the fence and inherit ambiguity.

export type ReclaimableFailure = {
  readonly _tag: "reclaimable";
  readonly mayRebroadcast: true;
  readonly mayRetry: true;
};

export type AmbiguousFailure = {
  readonly _tag: "ambiguous";
  readonly mayRebroadcast: false;
  readonly mayRetry: false;
  readonly disposition: "reconciliation_required";
};

export type LegacyFailure = {
  readonly _tag: "legacy";
  readonly mayRebroadcast: false;
  readonly mayRetry: false;
  readonly disposition: "reconciliation_required";
};

export type FailureFence = ReclaimableFailure | AmbiguousFailure | LegacyFailure;

export type FailureObservation =
  | { readonly error: "explicit_prebroadcast"; readonly broadcastAttempted: false }
  | { readonly error: "explicit_prebroadcast"; readonly broadcastAttempted: true }
  | { readonly error: "chain_ambiguous"; readonly broadcastAttempted: boolean }
  | { readonly error: "unclassified" };

export const RECLAIMABLE: ReclaimableFailure = {
  _tag: "reclaimable",
  mayRebroadcast: true,
  mayRetry: true,
};
export const AMBIGUOUS: AmbiguousFailure = {
  _tag: "ambiguous",
  mayRebroadcast: false,
  mayRetry: false,
  disposition: "reconciliation_required",
};
export const LEGACY: LegacyFailure = {
  _tag: "legacy",
  mayRebroadcast: false,
  mayRetry: false,
  disposition: "reconciliation_required",
};

export function classifySettlementFailure(observation: FailureObservation): FailureFence {
  if (observation.error === "explicit_prebroadcast" && !observation.broadcastAttempted)
    return RECLAIMABLE;
  if (observation.error === "explicit_prebroadcast" && observation.broadcastAttempted)
    return AMBIGUOUS;
  if (observation.error === "chain_ambiguous") return AMBIGUOUS;
  return LEGACY;
}

export function isFailureFenceReclaimable(fence: FailureFence): fence is ReclaimableFailure {
  return fence._tag === "reclaimable";
}
