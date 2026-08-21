import { Sha256Hex } from "@pirate/domain/verification";
import { Data, Effect, Option, Schema } from "effect";
import {
  type HnsRouteRevalidationEvidenceEnvelopeV1,
  type HnsRouteRevalidationResultHashInput,
  hnsRouteRevalidationChallengeValueSha256,
  hnsRouteRevalidationCompletionHash,
  hnsRouteRevalidationEvidenceHash,
  hnsRouteRevalidationObservationSha256,
  hnsRouteRevalidationProviderIdentityDigest,
  hnsRouteRevalidationResultHash,
} from "./hashes.ts";
import {
  HnsRouteRevalidationProviderFailed,
  type HnsRouteRevalidationSessionV1,
  type HnsRouteRevalidationStartAuthority,
} from "./start.ts";

const exactParseOptions = { onExcessProperty: "error" } as const;

const boundedText = (maxBytes: number, message: string) =>
  Schema.NonEmptyString.check(
    Schema.makeFilter((value) =>
      value.trim() === value &&
      new TextEncoder().encode(value).byteLength <= maxBytes &&
      [...value].every((character) => {
        const point = character.codePointAt(0) ?? 0;
        return point >= 0x20 && !(point >= 0x7f && point <= 0x9f);
      })
        ? undefined
        : message,
    ),
  );

const Identifier = boundedText(256, "Expected a bounded canonical identifier");
const ChallengeName = boundedText(255, "Expected a bounded challenge name");
const ChainNetwork = boundedText(128, "Expected a bounded chain network");
const EvidenceReference = boundedText(512, "Expected a bounded evidence reference");
const ChallengeValue = boundedText(16_448, "Expected a bounded challenge value");
const PositiveInteger = Schema.Int.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value > 0 ? undefined : "Expected a positive safe integer",
  ),
);
const CanonicalInstant = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
      ? undefined
      : "Expected a canonical UTC instant";
  }),
);
const OwnershipSource = Schema.Literals(["hns_parent_chain_txt", "owner_authoritative_dns_txt"]);

/** The only semantic provider response union admitted by route revalidation. */
export const HnsRouteRevalidationProviderResponse = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending") }),
  Schema.Struct({
    status: Schema.Literal("verified"),
    observation: Schema.Struct({
      ownership_source: OwnershipSource,
      challenge_name: ChallengeName,
      challenge_value: ChallengeValue,
      root_exists: Schema.Literal(true),
      root_control_verified: Schema.Literal(true),
      expiry_horizon_sufficient: Schema.Literal(true),
      chain_network: ChainNetwork,
      chain_anchor_height: PositiveInteger,
      chain_anchor_block_hash: Sha256Hex,
      chain_anchor_median_time: PositiveInteger,
      expiry_height: PositiveInteger,
      observed_at: CanonicalInstant,
      expires_at: CanonicalInstant,
      provider_evidence_ref: EvidenceReference,
    }),
  }),
  Schema.Struct({
    status: Schema.Literal("rejected"),
    reason_code: Schema.Literals([
      "missing_root",
      "control_failed",
      "challenge_mismatch",
      "insufficient_expiry",
      "disputed",
      "revoked",
    ]),
  }),
]);
export type HnsRouteRevalidationProviderResponse = Schema.Schema.Type<
  typeof HnsRouteRevalidationProviderResponse
>;
export type HnsRouteRevalidationVerifiedObservation = Extract<
  HnsRouteRevalidationProviderResponse,
  { readonly status: "verified" }
>["observation"];
export type HnsRouteRevalidationProviderRejectionReason = Extract<
  HnsRouteRevalidationProviderResponse,
  { readonly status: "rejected" }
>["reason_code"];

export type HnsRouteRevalidationCompletionProviderResult =
  | { readonly status: "pending" }
  | {
      readonly status: "verified";
      readonly observation: HnsRouteRevalidationVerifiedObservation;
      readonly raw_response_bytes: Uint8Array;
    }
  | {
      readonly status: "rejected";
      readonly reason_code: HnsRouteRevalidationProviderRejectionReason;
    };

export interface HnsRouteRevalidationCompletionProvider {
  readonly complete: (
    input: Readonly<{ readonly session: HnsRouteRevalidationSessionV1 }>,
  ) => Effect.Effect<
    HnsRouteRevalidationCompletionProviderResult,
    HnsRouteRevalidationProviderFailed
  >;
}

/** The public route-revalidation poll request has exactly these five fields. */
export const CompleteHnsRouteRevalidationInput = Schema.Struct({
  route_revalidation_id: Identifier,
  revalidation_session_id: Identifier,
  expected_binding_generation: PositiveInteger,
  idempotency_key: Identifier,
  channel: Schema.Literal("poll_result"),
});
export type CompleteHnsRouteRevalidationInput = Schema.Schema.Type<
  typeof CompleteHnsRouteRevalidationInput
>;

export const HNS_ROUTE_REVALIDATION_COMPLETION_LEASE_MS = 16_000 as const;
export const HNS_ROUTE_REVALIDATION_COMPLETION_MAX_CONSUMED_ATTEMPTS = 3 as const;
export const HNS_ROUTE_REVALIDATION_COMPLETION_RETRY_AFTER_SECONDS = 1 as const;

export type HnsRouteRevalidationTerminalStatus =
  | "verified"
  | "missing_root"
  | "control_failed"
  | "challenge_mismatch"
  | "insufficient_expiry"
  | "disputed"
  | "revoked"
  | "database_time_expired"
  | "session_expired"
  | "stale_cas";

export type HnsRouteRevalidationCompletionStatus =
  | "pending"
  | "unavailable"
  | HnsRouteRevalidationTerminalStatus;

export type HnsRouteRevalidationCompletionResponse = Readonly<{
  readonly route_revalidation_id: string;
  readonly revalidation_session_id: string;
  readonly expected_binding_generation: number;
  readonly status: HnsRouteRevalidationCompletionStatus;
  readonly replayed: boolean;
  readonly result_hash: string | null;
  readonly retry_after_seconds: number | null;
}>;

export type HnsRouteRevalidationCompletionAttempt = Readonly<{
  readonly route_revalidation_attempt_id: string;
  readonly route_revalidation_id: string;
  readonly revalidation_session_id: string;
  readonly route_binding_id: string;
  readonly expected_binding_generation: number;
  readonly expected_verified_evidence_ref: string | null;
  readonly attempt_number: number;
  readonly idempotency_key: string;
  readonly completion_request_hash: string;
  readonly evidence_ref: string;
  readonly state: "leased" | "released" | "consumed";
  readonly fence_token: number;
  readonly lease_expires_at: string;
  readonly consumption_kind: HnsRouteRevalidationTerminalStatus | "semantic_contradiction" | null;
  readonly result_hash: string | null;
}>;

/** Database time is loaded by the store; the application never reads a wall clock. */
export type HnsRouteRevalidationStoredCompletion = Readonly<{
  readonly route_revalidation_id: string;
  readonly revalidation_session_id: string;
  readonly expected_binding_generation: number;
  readonly database_now: string;
  readonly session: HnsRouteRevalidationSessionV1;
  readonly status: "pending" | "completed" | "failed" | "expired";
  readonly terminal: Readonly<{
    readonly status: HnsRouteRevalidationTerminalStatus;
    readonly idempotency_key: string;
    readonly completion_request_hash: string;
    readonly result_hash: string;
  }> | null;
  readonly attempt: HnsRouteRevalidationCompletionAttempt | null;
}>;

export type HnsRouteRevalidationCompletionAttemptReservation = Readonly<{
  readonly route_revalidation_attempt_id: string;
  readonly route_revalidation_id: string;
  readonly revalidation_session_id: string;
  readonly route_binding_id: string;
  readonly expected_binding_generation: number;
  readonly expected_verified_evidence_ref: string | null;
  readonly attempt_number: number;
  readonly idempotency_key: string;
  readonly completion_request_hash: string;
  readonly evidence_ref: string;
  readonly fence_token: number;
  readonly lease_expires_at: string;
}>;

export type HnsRouteRevalidationCompletionReservationOutcome =
  | {
      readonly kind: "acquired";
      readonly reservation: HnsRouteRevalidationCompletionAttemptReservation;
    }
  | { readonly kind: "replay"; readonly stored: HnsRouteRevalidationStoredCompletion }
  | { readonly kind: "expired"; readonly result_hash: string }
  | { readonly kind: "in_flight"; readonly retry_after_seconds: number }
  | { readonly kind: "consumed" }
  | { readonly kind: "budget_exhausted" }
  | { readonly kind: "idempotency_conflict" }
  | { readonly kind: "binding_conflict" }
  | { readonly kind: "not_found" };

export type HnsRouteRevalidationCompletionFinalizeOutcome =
  | {
      readonly kind: "committed";
      readonly status: HnsRouteRevalidationTerminalStatus;
      readonly result_hash: string;
    }
  | {
      readonly kind: "replay";
      readonly status: HnsRouteRevalidationTerminalStatus;
      readonly result_hash: string;
    }
  | { readonly kind: "expired"; readonly result_hash: string }
  | { readonly kind: "consumed" }
  | { readonly kind: "consumed_without_terminal" }
  | { readonly kind: "lease_lost" }
  | { readonly kind: "stale_cas" }
  | { readonly kind: "binding_conflict" };

export type HnsRouteRevalidationCompletionReleaseOutcome =
  | { readonly kind: "released" }
  | { readonly kind: "expired"; readonly result_hash: string }
  | { readonly kind: "replay"; readonly stored: HnsRouteRevalidationStoredCompletion }
  | { readonly kind: "lease_lost" }
  | { readonly kind: "binding_conflict" };

export type HnsRouteRevalidationVerifiedCompletion = Readonly<{
  readonly envelope: HnsRouteRevalidationEvidenceEnvelopeV1;
  readonly observation: HnsRouteRevalidationVerifiedObservation;
  readonly raw_response_bytes: Uint8Array;
}>;

export interface HnsRouteRevalidationCompletionStore {
  readonly load: (
    input: Readonly<{
      readonly route_revalidation_id: string;
      readonly revalidation_session_id: string;
      readonly idempotency_key: string;
    }>,
  ) => Effect.Effect<
    HnsRouteRevalidationStoredCompletion | null,
    HnsRouteRevalidationCompletionStorageFailed
  >;
  /** Reserve in a short transaction. The provider must not run in this operation. */
  readonly reserve: (
    input: Readonly<{
      readonly route_revalidation_id: string;
      readonly revalidation_session_id: string;
      readonly expected_binding_generation: number;
      readonly expected_verified_evidence_ref: string | null;
      readonly idempotency_key: string;
      readonly completion_request_hash: string;
      readonly completion_attempt_id: string;
      readonly evidence_ref: string;
      readonly lease_ms: number;
      readonly max_consumed_attempts: number;
    }>,
  ) => Effect.Effect<
    HnsRouteRevalidationCompletionReservationOutcome,
    HnsRouteRevalidationCompletionStorageFailed
  >;
  /** Release only the matching live fence in its own transaction. */
  readonly release: (
    input: Readonly<{
      readonly expected: HnsRouteRevalidationStoredCompletion;
      readonly idempotency_key: string;
      readonly completion_request_hash: string;
      readonly expired_result_hash: string;
      readonly attempt: HnsRouteRevalidationCompletionAttemptReservation;
    }>,
  ) => Effect.Effect<
    HnsRouteRevalidationCompletionReleaseOutcome,
    HnsRouteRevalidationCompletionStorageFailed
  >;
  readonly reject: (
    input: Readonly<{
      readonly expected: HnsRouteRevalidationStoredCompletion;
      readonly idempotency_key: string;
      readonly completion_request_hash: string;
      readonly result_hash: string;
      readonly expired_result_hash: string;
      readonly attempt: HnsRouteRevalidationCompletionAttemptReservation;
      readonly status: Exclude<HnsRouteRevalidationTerminalStatus, "verified">;
    }>,
  ) => Effect.Effect<
    HnsRouteRevalidationCompletionFinalizeOutcome,
    HnsRouteRevalidationCompletionStorageFailed
  >;
  /** Consumes a strictly decoded but semantically contradictory provider observation. */
  readonly consume: (
    input: Readonly<{
      readonly expected: HnsRouteRevalidationStoredCompletion;
      readonly idempotency_key: string;
      readonly completion_request_hash: string;
      readonly attempt: HnsRouteRevalidationCompletionAttemptReservation;
      readonly consumption_kind: "semantic_contradiction";
    }>,
  ) => Effect.Effect<
    HnsRouteRevalidationCompletionFinalizeOutcome,
    HnsRouteRevalidationCompletionStorageFailed
  >;
  /** Fenced terminal verification; this is the only operation allowed to mutate route authority. */
  readonly verify: (
    input: Readonly<{
      readonly expected: HnsRouteRevalidationStoredCompletion;
      readonly idempotency_key: string;
      readonly completion_request_hash: string;
      readonly result_hash: string;
      readonly expired_result_hash: string;
      readonly attempt: HnsRouteRevalidationCompletionAttemptReservation;
      readonly verified: HnsRouteRevalidationVerifiedCompletion;
    }>,
  ) => Effect.Effect<
    HnsRouteRevalidationCompletionFinalizeOutcome,
    HnsRouteRevalidationCompletionStorageFailed
  >;
}

export type HnsRouteRevalidationCompletionServices = Readonly<{
  readonly store: HnsRouteRevalidationCompletionStore;
  readonly provider: HnsRouteRevalidationCompletionProvider;
  readonly ids?: Readonly<{ readonly attempt: () => string; readonly evidence: () => string }>;
}>;

export class HnsRouteRevalidationCompletionRejected extends Data.TaggedError(
  "HnsRouteRevalidationCompletionRejected",
)<{
  readonly reason:
    | "invalid"
    | "not_found"
    | "binding_conflict"
    | "idempotency_conflict"
    | "completion_in_progress"
    | "attempt_consumed"
    | "attempt_budget_exhausted"
    | "stale_cas";
  readonly retry_after_seconds?: number;
}> {}

export class HnsRouteRevalidationCompletionStorageFailed extends Data.TaggedError(
  "HnsRouteRevalidationCompletionStorageFailed",
)<Record<string, never>> {}

export type HnsRouteRevalidationCompletionFailure =
  | HnsRouteRevalidationCompletionRejected
  | HnsRouteRevalidationCompletionStorageFailed
  | HnsRouteRevalidationProviderFailed;

const generatedId = (
  ids: HnsRouteRevalidationCompletionServices["ids"],
  kind: "attempt" | "evidence",
) => ids?.[kind]() ?? `route-revalidation-${kind}_${crypto.randomUUID()}`;

function decodeInput(
  input: unknown,
): Effect.Effect<CompleteHnsRouteRevalidationInput, HnsRouteRevalidationCompletionRejected> {
  const decoded = Schema.decodeUnknownOption(
    CompleteHnsRouteRevalidationInput,
    exactParseOptions,
  )(input);
  return Option.isSome(decoded)
    ? Effect.succeed(decoded.value)
    : Effect.fail(new HnsRouteRevalidationCompletionRejected({ reason: "invalid" }));
}

function response(
  stored: HnsRouteRevalidationStoredCompletion,
  status: HnsRouteRevalidationCompletionStatus,
  replayed: boolean,
  resultHash: string | null,
  retryAfterSeconds: number | null,
): HnsRouteRevalidationCompletionResponse {
  return {
    route_revalidation_id: stored.route_revalidation_id,
    revalidation_session_id: stored.revalidation_session_id,
    expected_binding_generation: stored.expected_binding_generation,
    status,
    replayed,
    result_hash: resultHash,
    retry_after_seconds: retryAfterSeconds,
  };
}

function terminalHashInput(
  input: CompleteHnsRouteRevalidationInput,
  attempt: HnsRouteRevalidationCompletionAttemptReservation,
  status: HnsRouteRevalidationTerminalStatus,
  evidence: HnsRouteRevalidationEvidenceEnvelopeV1 | null,
): HnsRouteRevalidationResultHashInput {
  return {
    route_revalidation_id: input.route_revalidation_id,
    revalidation_session_id: input.revalidation_session_id,
    route_revalidation_attempt_id: attempt.route_revalidation_attempt_id,
    route_binding_id: attempt.route_binding_id,
    expected_binding_generation: input.expected_binding_generation,
    idempotency_key: input.idempotency_key,
    completion_request_hash: attempt.completion_request_hash,
    outcome_status: status,
    evidence_ref_or_null: evidence?.evidence_ref ?? null,
    evidence_digest_or_null: evidence?.evidence_digest ?? null,
    provider_identity_digest_or_null: evidence?.provider_identity_digest ?? null,
    ownership_status_or_null: status === "verified" ? "verified" : null,
    route_lifecycle_status_or_null: status === "verified" ? "active" : null,
  };
}

function terminalReplay(
  input: CompleteHnsRouteRevalidationInput,
  requestHash: string,
  stored: HnsRouteRevalidationStoredCompletion,
): Effect.Effect<
  HnsRouteRevalidationCompletionResponse | null,
  HnsRouteRevalidationCompletionRejected
> {
  if (
    stored.route_revalidation_id !== input.route_revalidation_id ||
    stored.revalidation_session_id !== input.revalidation_session_id
  )
    return Effect.fail(new HnsRouteRevalidationCompletionRejected({ reason: "not_found" }));
  if (stored.expected_binding_generation !== input.expected_binding_generation) {
    return Effect.fail(new HnsRouteRevalidationCompletionRejected({ reason: "binding_conflict" }));
  }
  if (stored.terminal === null) {
    return stored.status === "pending"
      ? Effect.succeed(null)
      : Effect.fail(new HnsRouteRevalidationCompletionRejected({ reason: "binding_conflict" }));
  }
  if (
    stored.terminal.idempotency_key !== input.idempotency_key ||
    stored.terminal.completion_request_hash !== requestHash
  ) {
    return Effect.fail(
      new HnsRouteRevalidationCompletionRejected({ reason: "idempotency_conflict" }),
    );
  }
  return Effect.succeed(
    response(stored, stored.terminal.status, true, stored.terminal.result_hash, null),
  );
}

function routeMatchesSession(
  authority: HnsRouteRevalidationStartAuthority,
  stored: HnsRouteRevalidationStoredCompletion,
): boolean {
  const sessionAuthority = stored.session.authority;
  return (
    authority.route_revalidation_id === stored.route_revalidation_id &&
    authority.route_revalidation_id === sessionAuthority.route_revalidation_id &&
    authority.community_id === sessionAuthority.community_id &&
    authority.route_binding_id === sessionAuthority.route_binding_id &&
    authority.expected_binding_generation === stored.expected_binding_generation &&
    authority.expected_binding_generation === sessionAuthority.expected_binding_generation &&
    authority.expected_verified_evidence_ref === sessionAuthority.expected_verified_evidence_ref &&
    stored.session.revalidation_session_id === stored.revalidation_session_id
  );
}

function buildVerifiedEnvelope(
  stored: HnsRouteRevalidationStoredCompletion,
  attempt: HnsRouteRevalidationCompletionAttemptReservation,
  provider: Extract<HnsRouteRevalidationCompletionProviderResult, { readonly status: "verified" }>,
): Effect.Effect<HnsRouteRevalidationVerifiedCompletion, HnsRouteRevalidationProviderFailed> {
  return Effect.tryPromise({
    try: async () => {
      const observation = provider.observation;
      const authority = stored.session.authority;
      const sourceName =
        observation.ownership_source === "hns_parent_chain_txt"
          ? authority.root_label
          : `_pirate.${authority.root_label}`;
      const databaseNow = Date.parse(stored.database_now);
      const observedAt = Date.parse(observation.observed_at);
      const expiresAt = Date.parse(observation.expires_at);
      if (
        provider.raw_response_bytes.byteLength === 0 ||
        provider.raw_response_bytes.byteLength > 1_048_576 ||
        !routeMatchesSession(authority, stored) ||
        observation.challenge_name !== sourceName ||
        observation.challenge_value !==
          `pirate-verification=${stored.session.upstream_session_ref}` ||
        observation.root_exists !== true ||
        observation.root_control_verified !== true ||
        observation.expiry_horizon_sufficient !== true ||
        !Number.isFinite(databaseNow) ||
        !Number.isFinite(observedAt) ||
        !Number.isFinite(expiresAt) ||
        observedAt > databaseNow ||
        expiresAt <= observedAt ||
        databaseNow >= expiresAt ||
        !Number.isSafeInteger(authority.expected_binding_generation + 1)
      )
        throw new TypeError("route-revalidation observation is not bound to its session");
      const challengeValueSha256 = await hnsRouteRevalidationChallengeValueSha256(
        observation.challenge_value,
      );
      const observationSha256 = await hnsRouteRevalidationObservationSha256(
        provider.raw_response_bytes,
      );
      const providerIdentityDigest = await hnsRouteRevalidationProviderIdentityDigest({
        provider_id: authority.provider_id,
        provider_configuration_kind: authority.provider_configuration_kind,
        provider_configuration_reference: authority.provider_configuration_reference,
        provider_configuration_version: authority.provider_configuration_version,
        protocol_version: authority.protocol_version,
        root_label: authority.root_label,
      });
      const base: HnsRouteRevalidationEvidenceEnvelopeV1 = {
        version: "pirate-hns-route-revalidation-evidence-v1",
        route_revalidation_id: stored.route_revalidation_id,
        revalidation_session_id: stored.revalidation_session_id,
        route_revalidation_attempt_id: attempt.route_revalidation_attempt_id,
        community_id: authority.community_id,
        route_binding_id: authority.route_binding_id,
        principal_kind: authority.principal_kind,
        principal_id: authority.principal_id,
        requirement_hash: authority.requirement_hash,
        expected_binding_generation: stored.expected_binding_generation,
        binding_generation: stored.expected_binding_generation + 1,
        expected_verified_evidence_ref: authority.expected_verified_evidence_ref,
        start_request_hash: stored.session.start_request_hash,
        provider_id: authority.provider_id,
        provider_binding_hash: authority.provider_binding_hash,
        provider_configuration_kind: authority.provider_configuration_kind,
        provider_configuration_reference: authority.provider_configuration_reference,
        provider_configuration_version: authority.provider_configuration_version,
        protocol_version: authority.protocol_version,
        environment: authority.environment,
        family: "hns",
        root_label: authority.root_label,
        root_label_display: authority.root_label_display,
        path_segment: authority.path_segment,
        upstream_session_ref: stored.session.upstream_session_ref,
        ownership_source: observation.ownership_source,
        challenge_name: observation.challenge_name,
        challenge_value_sha256: challengeValueSha256,
        root_exists: true,
        root_control_verified: true,
        expiry_horizon_sufficient: true,
        chain_network: observation.chain_network,
        chain_anchor_height: observation.chain_anchor_height,
        chain_anchor_block_hash: observation.chain_anchor_block_hash,
        chain_anchor_median_time: observation.chain_anchor_median_time,
        expiry_height: observation.expiry_height,
        observed_at: observation.observed_at,
        expires_at: observation.expires_at,
        evidence_ref: attempt.evidence_ref,
        provider_evidence_ref: observation.provider_evidence_ref,
        observation_sha256: observationSha256,
        provider_identity_digest: providerIdentityDigest,
        evidence_digest: "0".repeat(64),
      };
      const evidenceDigest = await hnsRouteRevalidationEvidenceHash(base);
      return {
        envelope: { ...base, evidence_digest: evidenceDigest },
        observation,
        raw_response_bytes: new Uint8Array(provider.raw_response_bytes),
      };
    },
    catch: () => new HnsRouteRevalidationProviderFailed({ reason: "observation_rejected" }),
  });
}

const retryAfter = HNS_ROUTE_REVALIDATION_COMPLETION_RETRY_AFTER_SECONDS;

function settleRelease(
  input: CompleteHnsRouteRevalidationInput,
  stored: HnsRouteRevalidationStoredCompletion,
  requestHash: string,
  outcome: HnsRouteRevalidationCompletionReleaseOutcome,
): Effect.Effect<
  HnsRouteRevalidationCompletionResponse | null,
  HnsRouteRevalidationCompletionRejected
> {
  if (outcome.kind === "released") return Effect.succeed(null);
  if (outcome.kind === "expired") {
    return Effect.succeed(response(stored, "session_expired", false, outcome.result_hash, null));
  }
  if (outcome.kind === "lease_lost") {
    return Effect.succeed(response(stored, "unavailable", false, null, retryAfter));
  }
  if (outcome.kind === "binding_conflict") {
    return Effect.fail(new HnsRouteRevalidationCompletionRejected({ reason: "binding_conflict" }));
  }
  return terminalReplay(input, requestHash, outcome.stored).pipe(
    Effect.flatMap((replayed) =>
      replayed === null
        ? Effect.fail(new HnsRouteRevalidationCompletionRejected({ reason: "binding_conflict" }))
        : Effect.succeed(replayed),
    ),
  );
}

function settleFinalize(
  stored: HnsRouteRevalidationStoredCompletion,
  outcome: HnsRouteRevalidationCompletionFinalizeOutcome,
  requestedStatus: HnsRouteRevalidationTerminalStatus,
  resultHash: string,
): Effect.Effect<HnsRouteRevalidationCompletionResponse, HnsRouteRevalidationCompletionRejected> {
  if (outcome.kind === "binding_conflict") {
    return Effect.fail(new HnsRouteRevalidationCompletionRejected({ reason: "binding_conflict" }));
  }
  if (outcome.kind === "stale_cas") {
    return Effect.succeed(response(stored, "stale_cas", false, resultHash, null));
  }
  if (outcome.kind === "lease_lost") {
    return Effect.succeed(response(stored, "unavailable", false, null, retryAfter));
  }
  if (outcome.kind === "consumed" || outcome.kind === "consumed_without_terminal") {
    return Effect.fail(new HnsRouteRevalidationCompletionRejected({ reason: "attempt_consumed" }));
  }
  const status =
    outcome.kind === "expired"
      ? "session_expired"
      : outcome.kind === "replay"
        ? outcome.status
        : requestedStatus;
  const hash =
    outcome.kind === "expired" || outcome.kind === "replay" ? outcome.result_hash : resultHash;
  return Effect.succeed(response(stored, status, outcome.kind === "replay", hash, null));
}

function consumeSemanticContradiction(
  services: HnsRouteRevalidationCompletionServices,
  stored: HnsRouteRevalidationStoredCompletion,
  input: CompleteHnsRouteRevalidationInput,
  attempt: HnsRouteRevalidationCompletionAttemptReservation,
  failure: HnsRouteRevalidationProviderFailed,
): Effect.Effect<never, HnsRouteRevalidationCompletionFailure> {
  return Effect.gen(function* () {
    const outcome = yield* services.store.consume({
      expected: stored,
      idempotency_key: input.idempotency_key,
      completion_request_hash: attempt.completion_request_hash,
      attempt,
      consumption_kind: "semantic_contradiction",
    });
    if (
      outcome.kind === "lease_lost" ||
      outcome.kind === "expired" ||
      outcome.kind === "stale_cas"
    ) {
      return yield* new HnsRouteRevalidationCompletionRejected({ reason: "stale_cas" });
    }
    if (outcome.kind === "binding_conflict") {
      return yield* new HnsRouteRevalidationCompletionRejected({ reason: "binding_conflict" });
    }
    return yield* failure;
  });
}

/** Replay first, reserve, await provider outside transaction, then fenced finalize. */
export const completeHnsRouteRevalidation = Effect.fn("completeHnsRouteRevalidation")(function* (
  untrustedInput: unknown,
  services: HnsRouteRevalidationCompletionServices,
): Effect.fn.Return<HnsRouteRevalidationCompletionResponse, HnsRouteRevalidationCompletionFailure> {
  const input = yield* decodeInput(untrustedInput);
  const stored = yield* services.store.load({
    route_revalidation_id: input.route_revalidation_id,
    revalidation_session_id: input.revalidation_session_id,
    idempotency_key: input.idempotency_key,
  });
  if (stored === null)
    return yield* new HnsRouteRevalidationCompletionRejected({ reason: "not_found" });

  const attemptId =
    stored.attempt?.route_revalidation_attempt_id ?? generatedId(services.ids, "attempt");
  const evidenceRef = stored.attempt?.evidence_ref ?? generatedId(services.ids, "evidence");
  const completionRequestHash = yield* Effect.promise(() =>
    hnsRouteRevalidationCompletionHash({
      route_revalidation_id: input.route_revalidation_id,
      revalidation_session_id: input.revalidation_session_id,
      route_revalidation_attempt_id: attemptId,
      route_binding_id: stored.session.authority.route_binding_id,
      expected_binding_generation: input.expected_binding_generation,
      expected_verified_evidence_ref: stored.session.authority.expected_verified_evidence_ref,
      attempt_number: stored.attempt?.attempt_number ?? 1,
      idempotency_key: input.idempotency_key,
      evidence_ref: evidenceRef,
    }),
  );
  const replay = yield* terminalReplay(input, completionRequestHash, stored);
  if (replay !== null) return replay;

  const reservation = yield* services.store.reserve({
    route_revalidation_id: input.route_revalidation_id,
    revalidation_session_id: input.revalidation_session_id,
    expected_binding_generation: input.expected_binding_generation,
    expected_verified_evidence_ref: stored.session.authority.expected_verified_evidence_ref,
    idempotency_key: input.idempotency_key,
    completion_request_hash: completionRequestHash,
    completion_attempt_id: attemptId,
    evidence_ref: evidenceRef,
    lease_ms: HNS_ROUTE_REVALIDATION_COMPLETION_LEASE_MS,
    max_consumed_attempts: HNS_ROUTE_REVALIDATION_COMPLETION_MAX_CONSUMED_ATTEMPTS,
  });
  if (reservation.kind === "replay") {
    const replayed = yield* terminalReplay(input, completionRequestHash, reservation.stored);
    return (
      replayed ??
      (yield* new HnsRouteRevalidationCompletionRejected({ reason: "binding_conflict" }))
    );
  }
  if (reservation.kind === "expired")
    return response(stored, "session_expired", false, reservation.result_hash, null);
  if (reservation.kind === "in_flight") {
    return yield* new HnsRouteRevalidationCompletionRejected({
      reason: "completion_in_progress",
      retry_after_seconds: reservation.retry_after_seconds,
    });
  }
  if (reservation.kind === "consumed")
    return yield* new HnsRouteRevalidationCompletionRejected({ reason: "attempt_consumed" });
  if (reservation.kind === "budget_exhausted") {
    return yield* new HnsRouteRevalidationCompletionRejected({
      reason: "attempt_budget_exhausted",
    });
  }
  if (reservation.kind === "idempotency_conflict" || reservation.kind === "binding_conflict") {
    return yield* new HnsRouteRevalidationCompletionRejected({ reason: reservation.kind });
  }
  if (reservation.kind === "not_found")
    return yield* new HnsRouteRevalidationCompletionRejected({ reason: "not_found" });

  const attempt = reservation.reservation;
  const expiredResultHash = yield* Effect.promise(() =>
    hnsRouteRevalidationResultHash(terminalHashInput(input, attempt, "session_expired", null)),
  );
  // Deliberately awaited after reserve has committed; no store transaction spans this call.
  const providerResult = yield* services.provider.complete({ session: stored.session }).pipe(
    Effect.matchEffect({
      onSuccess: (value) => Effect.succeed({ kind: "success" as const, value }),
      onFailure: (error) => Effect.succeed({ kind: "failure" as const, error }),
    }),
  );

  if (providerResult.kind === "failure") {
    if (providerResult.error.reason === "observation_rejected") {
      return yield* consumeSemanticContradiction(
        services,
        stored,
        input,
        attempt,
        providerResult.error,
      );
    }
    const released = yield* services.store.release({
      expected: stored,
      idempotency_key: input.idempotency_key,
      completion_request_hash: completionRequestHash,
      expired_result_hash: expiredResultHash,
      attempt,
    });
    const settled = yield* settleRelease(input, stored, completionRequestHash, released);
    if (settled !== null) return settled;
    if (providerResult.error.reason === "unavailable")
      return response(stored, "unavailable", false, null, retryAfter);
    return yield* providerResult.error;
  }

  if (providerResult.value.status === "pending") {
    const released = yield* services.store.release({
      expected: stored,
      idempotency_key: input.idempotency_key,
      completion_request_hash: completionRequestHash,
      expired_result_hash: expiredResultHash,
      attempt,
    });
    const settled = yield* settleRelease(input, stored, completionRequestHash, released);
    return settled ?? response(stored, "pending", false, null, retryAfter);
  }

  if (providerResult.value.status === "rejected") {
    const status = providerResult.value.reason_code;
    const resultHash = yield* Effect.promise(() =>
      hnsRouteRevalidationResultHash(terminalHashInput(input, attempt, status, null)),
    );
    const outcome = yield* services.store.reject({
      expected: stored,
      idempotency_key: input.idempotency_key,
      completion_request_hash: completionRequestHash,
      result_hash: resultHash,
      expired_result_hash: expiredResultHash,
      attempt,
      status,
    });
    return yield* settleFinalize(stored, outcome, status, resultHash);
  }

  // Database-time expiry is a terminal, evidence-free outcome. It is
  // distinct from a semantically contradictory observation, which consumes
  // the attempt without inventing a terminal result.
  const providerExpiresAt = Date.parse(providerResult.value.observation.expires_at);
  const databaseNow = Date.parse(stored.database_now);
  if (
    Number.isFinite(providerExpiresAt) &&
    Number.isFinite(databaseNow) &&
    providerExpiresAt <= databaseNow
  ) {
    const resultHash = yield* Effect.promise(() =>
      hnsRouteRevalidationResultHash(
        terminalHashInput(input, attempt, "database_time_expired", null),
      ),
    );
    const outcome = yield* services.store.reject({
      expected: stored,
      idempotency_key: input.idempotency_key,
      completion_request_hash: completionRequestHash,
      result_hash: resultHash,
      expired_result_hash: expiredResultHash,
      attempt,
      status: "database_time_expired",
    });
    return yield* settleFinalize(stored, outcome, "database_time_expired", resultHash);
  }

  const verified = yield* buildVerifiedEnvelope(stored, attempt, providerResult.value).pipe(
    Effect.matchEffect({
      onSuccess: (value) => Effect.succeed({ kind: "success" as const, value }),
      onFailure: (error) => Effect.succeed({ kind: "failure" as const, error }),
    }),
  );
  if (verified.kind === "failure") {
    return yield* consumeSemanticContradiction(services, stored, input, attempt, verified.error);
  }
  const resultHash = yield* Effect.promise(() =>
    hnsRouteRevalidationResultHash(
      terminalHashInput(input, attempt, "verified", verified.value.envelope),
    ),
  );
  const outcome = yield* services.store.verify({
    expected: stored,
    idempotency_key: input.idempotency_key,
    completion_request_hash: completionRequestHash,
    result_hash: resultHash,
    expired_result_hash: expiredResultHash,
    attempt,
    verified: verified.value,
  });
  return yield* settleFinalize(stored, outcome, "verified", resultHash);
});

export const completeRouteRevalidation = completeHnsRouteRevalidation;
