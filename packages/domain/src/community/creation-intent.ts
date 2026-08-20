export type CommunityCreationStatus =
  | "draft"
  | "verification_required"
  | "commit_ready"
  | "committed"
  | "quota_exceeded"
  | "gate_unsupported"
  | "expired"
  | "cancelled";

export type NextActionWaitReasonCode =
  | "verification_pending"
  | "membership_pending"
  | "operation_pending"
  | "reconciliation_pending";

export type CreationNextAction =
  | {
      readonly kind: "start_verification";
      readonly provider_id: string;
      readonly intent_id: string;
    }
  | { readonly kind: "commit" }
  | {
      readonly kind: "wait";
      readonly reason_code: NextActionWaitReasonCode;
      readonly retry_after_seconds?: number;
    }
  | { readonly kind: "blocked"; readonly reason: "quota_exceeded" | "gate_unsupported" }
  | { readonly kind: "none"; readonly reason: "committed" | "expired" | "cancelled" };

export type CommittedCommunityResource = Readonly<{
  readonly community_id: string;
  readonly href: string;
}>;

export type CommunityCreationIntentState = Readonly<{
  readonly intent_id: string;
  readonly revision: number;
  readonly status: CommunityCreationStatus;
  readonly canonical_policy_revision: number;
  readonly canonical_policy_hash: string;
  readonly verification_requirement_hash: string;
  readonly verification_provider_id: string;
  readonly expires_at: string;
  readonly committed_resource: CommittedCommunityResource | null;
}>;

export type CommunityCreationIntentEvent =
  | Readonly<{
      readonly type: "draft_saved";
      readonly expected_revision: number;
      readonly canonical_policy_revision: number;
      readonly canonical_policy_hash: string;
      readonly verification_requirement_hash: string;
    }>
  | Readonly<{
      /** A synchronous save + capability/evidence preflight is one durable revision. */
      readonly type: "draft_preflight_completed";
      readonly expected_revision: number;
      readonly canonical_policy_revision: number;
      readonly canonical_policy_hash: string;
      readonly verification_requirement_hash: string;
      readonly outcome:
        | "evidence_satisfied"
        | "verification_required"
        | "quota_exceeded"
        | "gate_unsupported";
    }>
  | Readonly<{
      readonly type: "preflight_completed";
      readonly expected_revision: number;
      readonly outcome:
        | "evidence_satisfied"
        | "verification_required"
        | "quota_exceeded"
        | "gate_unsupported";
    }>
  | Readonly<{
      readonly type: "verification_completed";
      readonly expected_revision: number;
    }>
  | Readonly<{
      readonly type: "commit_completed";
      readonly expected_revision: number;
      readonly resource: CommittedCommunityResource;
    }>
  | Readonly<{
      /** A quota race may be lost after preflight but before the commit lock. */
      readonly type: "commit_quota_exceeded";
      readonly expected_revision: number;
    }>
  | Readonly<{
      readonly type: "expired" | "cancelled";
      readonly expected_revision: number;
    }>;

export type CommunityCreationTransitionRejection =
  | "invalid_state"
  | "invalid_event"
  | "stale_revision"
  | "terminal";

export type CommunityCreationTransitionResult =
  | Readonly<{ readonly kind: "accepted"; readonly state: CommunityCreationIntentState }>
  | Readonly<{
      readonly kind: "rejected";
      readonly reason: CommunityCreationTransitionRejection;
    }>;

const TERMINAL_STATUSES = new Set<CommunityCreationStatus>([
  "committed",
  "quota_exceeded",
  "gate_unsupported",
  "expired",
  "cancelled",
]);
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const CANONICAL_ISO_INSTANT =
  /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/u;

function nonEmptyCanonical(value: string): boolean {
  return value.length > 0 && value.trim() === value;
}

function canonicalInstant(value: string): boolean {
  if (!CANONICAL_ISO_INSTANT.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

export function communityCreationIntentInvariant(
  state: CommunityCreationIntentState,
): string | null {
  if (!nonEmptyCanonical(state.intent_id)) return "intent_id";
  if (!Number.isSafeInteger(state.revision) || state.revision < 1) return "revision";
  if (
    !Number.isSafeInteger(state.canonical_policy_revision) ||
    state.canonical_policy_revision < 1
  ) {
    return "canonical_policy_revision";
  }
  if (!SHA256_HEX.test(state.canonical_policy_hash)) return "canonical_policy_hash";
  if (!SHA256_HEX.test(state.verification_requirement_hash)) {
    return "verification_requirement_hash";
  }
  if (!nonEmptyCanonical(state.verification_provider_id)) return "verification_provider_id";
  if (!canonicalInstant(state.expires_at)) return "expires_at";
  if (state.status === "committed") {
    if (
      state.committed_resource === null ||
      !nonEmptyCanonical(state.committed_resource.community_id) ||
      !nonEmptyCanonical(state.committed_resource.href) ||
      !state.committed_resource.href.startsWith("/")
    ) {
      return "committed_resource";
    }
  } else if (state.committed_resource !== null) {
    return "unexpected_committed_resource";
  }
  return null;
}

export function creationNextAction(state: CommunityCreationIntentState): CreationNextAction {
  switch (state.status) {
    case "draft":
      return { kind: "wait", reason_code: "operation_pending" };
    case "verification_required":
      return {
        kind: "start_verification",
        provider_id: state.verification_provider_id,
        intent_id: state.intent_id,
      };
    case "commit_ready":
      return { kind: "commit" };
    case "quota_exceeded":
    case "gate_unsupported":
      return { kind: "blocked", reason: state.status };
    case "committed":
    case "expired":
    case "cancelled":
      return { kind: "none", reason: state.status };
  }
}

function rejected(reason: CommunityCreationTransitionRejection): CommunityCreationTransitionResult {
  return { kind: "rejected", reason };
}

function accepted(state: CommunityCreationIntentState): CommunityCreationTransitionResult {
  return communityCreationIntentInvariant(state) === null
    ? { kind: "accepted", state }
    : rejected("invalid_state");
}

/** Pure authoritative transition function; storage supplies revision serialization. */
export function transitionCommunityCreationIntent(
  state: CommunityCreationIntentState,
  event: CommunityCreationIntentEvent,
): CommunityCreationTransitionResult {
  if (communityCreationIntentInvariant(state) !== null) return rejected("invalid_state");
  if (!Number.isSafeInteger(event.expected_revision) || event.expected_revision < 1) {
    return rejected("invalid_event");
  }
  if (event.expected_revision !== state.revision) return rejected("stale_revision");
  if (TERMINAL_STATUSES.has(state.status)) return rejected("terminal");

  if (event.type === "draft_saved") {
    if (
      !Number.isSafeInteger(event.canonical_policy_revision) ||
      event.canonical_policy_revision !== state.canonical_policy_revision + 1 ||
      !SHA256_HEX.test(event.canonical_policy_hash) ||
      !SHA256_HEX.test(event.verification_requirement_hash)
    ) {
      return rejected("invalid_event");
    }
    return accepted({
      ...state,
      revision: state.revision + 1,
      status: "draft",
      canonical_policy_revision: event.canonical_policy_revision,
      canonical_policy_hash: event.canonical_policy_hash,
      verification_requirement_hash: event.verification_requirement_hash,
    });
  }

  if (event.type === "draft_preflight_completed") {
    if (
      !Number.isSafeInteger(event.canonical_policy_revision) ||
      event.canonical_policy_revision !== state.canonical_policy_revision + 1 ||
      !SHA256_HEX.test(event.canonical_policy_hash) ||
      !SHA256_HEX.test(event.verification_requirement_hash)
    ) {
      return rejected("invalid_event");
    }
    const status: CommunityCreationStatus =
      event.outcome === "evidence_satisfied" ? "commit_ready" : event.outcome;
    return accepted({
      ...state,
      revision: state.revision + 1,
      status,
      canonical_policy_revision: event.canonical_policy_revision,
      canonical_policy_hash: event.canonical_policy_hash,
      verification_requirement_hash: event.verification_requirement_hash,
    });
  }

  if (event.type === "preflight_completed") {
    if (state.status !== "draft") return rejected("invalid_event");
    const status: CommunityCreationStatus =
      event.outcome === "evidence_satisfied" ? "commit_ready" : event.outcome;
    return accepted({ ...state, revision: state.revision + 1, status });
  }

  if (event.type === "verification_completed") {
    return state.status === "verification_required"
      ? accepted({ ...state, revision: state.revision + 1, status: "commit_ready" })
      : rejected("invalid_event");
  }

  if (event.type === "commit_completed") {
    if (state.status !== "commit_ready") return rejected("invalid_event");
    if (
      !nonEmptyCanonical(event.resource.community_id) ||
      !nonEmptyCanonical(event.resource.href) ||
      !event.resource.href.startsWith("/")
    ) {
      return rejected("invalid_event");
    }
    return accepted({
      ...state,
      revision: state.revision + 1,
      status: "committed",
      committed_resource: event.resource,
    });
  }

  if (event.type === "commit_quota_exceeded") {
    return state.status === "commit_ready"
      ? accepted({
          ...state,
          revision: state.revision + 1,
          status: "quota_exceeded",
        })
      : rejected("invalid_event");
  }

  return accepted({
    ...state,
    revision: state.revision + 1,
    status: event.type,
  });
}
