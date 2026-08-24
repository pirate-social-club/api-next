import { HnsTxtChallengeV1 } from "@pirate/contracts";
import { ProviderConfigurationRef, Sha256Hex } from "@pirate/domain/verification";
import { Data, Effect, Option, Schema } from "effect";
import {
  HNS_ROUTE_REVALIDATION_AUTHORITY_VERSION,
  HNS_ROUTE_REVALIDATION_PROTOCOL_VERSION,
  HNS_ROUTE_REVALIDATION_PROVIDER_ID,
  type HnsOwnerRouteRevalidationStartWireV1,
  type HnsRouteRevalidationAuthorityV1,
  type HnsRouteRevalidationRoute,
  hnsRouteRevalidationRequirementHash,
  hnsRouteRevalidationStartHash,
} from "./hashes.ts";

const exactParseOptions = { onExcessProperty: "error" } as const;

const Identifier = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.trim() === value &&
    new TextEncoder().encode(value).byteLength <= 256 &&
    [...value].every((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point >= 0x20 && !(point >= 0x7f && point <= 0x9f);
    })
      ? undefined
      : "Expected a bounded canonical identifier",
  ),
);

const PositiveInteger = Schema.Int.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value > 0 ? undefined : "Expected a positive safe integer",
  ),
);

const UpstreamReference = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.trim() === value &&
    new TextEncoder().encode(value).byteLength <= 16_384 &&
    [...value].every((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point >= 0x20 && !(point >= 0x7f && point <= 0x9f);
    })
      ? undefined
      : "Expected a bounded upstream session reference",
  ),
);

const EvidenceReference = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.trim() === value &&
    new TextEncoder().encode(value).byteLength <= 512 &&
    [...value].every((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point >= 0x20 && !(point >= 0x7f && point <= 0x9f);
    })
      ? undefined
      : "Expected a bounded evidence reference",
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

const StartPresentation = Schema.Struct({
  kind: Schema.Literal("embedded_sdk"),
  session_id: UpstreamReference,
  protocol: Schema.Literal("hns-txt-challenge"),
  version: Schema.Literal("1"),
  payload: HnsTxtChallengeV1,
});

export type HnsRouteRevalidationStartPresentation = Schema.Schema.Type<typeof StartPresentation>;

/** The durable, creation-free revalidation session produced by START. */
export type HnsRouteRevalidationSessionV1 = Readonly<{
  readonly authority: HnsRouteRevalidationAuthorityV1;
  readonly revalidation_session_id: string;
  readonly start_request_hash: string;
  readonly upstream_session_ref: string;
  readonly start_presentation: HnsRouteRevalidationStartPresentation;
  readonly status: "pending" | "completed" | "failed" | "expired";
  readonly started_at: string;
  readonly expires_at: string;
  readonly terminal_at: string | null;
}>;

/**
 * Trusted scheduler command. The scheduler allocates both opaque target ids
 * before calling this use case; browser and provider input never supplies them.
 * Stable caller allocation is required so an exact retry can replay before any
 * provider work.
 */
export const HnsRouteRevalidationStartInput = Schema.Struct({
  route_revalidation_id: Identifier,
  revalidation_session_id: Identifier,
  community_id: Identifier,
  route_binding_id: Identifier,
  expected_binding_generation: PositiveInteger,
  expected_verified_evidence_ref: Schema.NullOr(EvidenceReference),
  provider_binding_hash: Sha256Hex,
  provider_configuration: ProviderConfigurationRef,
  root_label: Identifier,
  root_label_display: Identifier,
  path_segment: Identifier,
});
export type HnsRouteRevalidationStartInput = Schema.Schema.Type<
  typeof HnsRouteRevalidationStartInput
>;

export type HnsRouteRevalidationStartAuthority = HnsRouteRevalidationAuthorityV1;

/** Strict result returned by the low-level HNS start transport. */
export const HnsRouteRevalidationProviderStartResult = Schema.Struct({
  upstream_session_ref: UpstreamReference,
  expires_at: CanonicalInstant,
  presentation: StartPresentation,
});
export type HnsRouteRevalidationProviderStartResult = Schema.Schema.Type<
  typeof HnsRouteRevalidationProviderStartResult
>;

export type HnsRouteRevalidationProviderFailureReason =
  | "unavailable"
  | "rejected"
  | "invalid_response"
  | "misconfigured"
  | "observation_rejected";

export class HnsRouteRevalidationProviderFailed extends Data.TaggedError(
  "HnsRouteRevalidationProviderFailed",
)<{
  readonly reason: HnsRouteRevalidationProviderFailureReason;
}> {}

export class HnsRouteRevalidationStartStorageFailed extends Data.TaggedError(
  "HnsRouteRevalidationStartStorageFailed",
) {}

export type HnsRouteRevalidationStartFailure =
  | HnsRouteRevalidationStartRejected
  | HnsRouteRevalidationStartStorageFailed
  | HnsRouteRevalidationProviderFailed;

export type HnsRouteRevalidationStartReservation = Readonly<{
  readonly route_revalidation_id: string;
  readonly revalidation_session_id: string;
  readonly fence_token: number;
  readonly lease_expires_at: string;
}>;

export type HnsRouteRevalidationStartReplayOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "not_found" }
  | { readonly kind: "replay"; readonly session: HnsRouteRevalidationSessionV1 }
  | { readonly kind: "in_flight"; readonly retry_after_seconds: number }
  | { readonly kind: "conflict" };

export type HnsRouteRevalidationStartReservationOutcome =
  | { readonly kind: "acquired"; readonly reservation: HnsRouteRevalidationStartReservation }
  | { readonly kind: "replay"; readonly session: HnsRouteRevalidationSessionV1 }
  | { readonly kind: "not_found" }
  | { readonly kind: "in_flight"; readonly retry_after_seconds: number }
  | { readonly kind: "conflict" };

export type HnsRouteRevalidationStartFinalizeOutcome =
  | { readonly kind: "created"; readonly session: HnsRouteRevalidationSessionV1 }
  | { readonly kind: "replay"; readonly session: HnsRouteRevalidationSessionV1 }
  | { readonly kind: "conflict" }
  | { readonly kind: "stale" };

export type HnsRouteRevalidationStartReservationInput = Readonly<{
  readonly authority: HnsRouteRevalidationStartAuthority;
  readonly revalidation_session_id: string;
  readonly start_request_hash: string;
  readonly start_presentation?: HnsRouteRevalidationStartPresentation;
  readonly ttl_ms: number;
}>;

export interface HnsRouteRevalidationStartStore {
  /** Exact replay lookup. It runs before provider resolution or invocation. */
  readonly replay: (
    input: Readonly<{
      readonly route_revalidation_id: string;
      readonly revalidation_session_id: string;
      readonly start_request_hash: string;
    }>,
  ) => Effect.Effect<
    HnsRouteRevalidationStartReplayOutcome,
    HnsRouteRevalidationStartStorageFailed
  >;
  readonly reserve: (
    input: HnsRouteRevalidationStartReservationInput,
  ) => Effect.Effect<
    HnsRouteRevalidationStartReservationOutcome,
    HnsRouteRevalidationStartStorageFailed
  >;
  readonly finalize: (
    reservation: HnsRouteRevalidationStartReservation,
    result: HnsRouteRevalidationProviderStartResult,
  ) => Effect.Effect<
    HnsRouteRevalidationStartFinalizeOutcome,
    HnsRouteRevalidationStartStorageFailed
  >;
  readonly release: (
    reservation: HnsRouteRevalidationStartReservation,
  ) => Effect.Effect<void, HnsRouteRevalidationStartStorageFailed>;
}

export interface HnsRouteRevalidationStartProvider {
  readonly start: (
    input: HnsOwnerRouteRevalidationStartWireV1,
  ) => Effect.Effect<HnsRouteRevalidationProviderStartResult, HnsRouteRevalidationProviderFailed>;
}

export type HnsRouteRevalidationStartServices = Readonly<{
  readonly store: HnsRouteRevalidationStartStore;
  readonly provider: HnsRouteRevalidationStartProvider;
  /** Registered target service identity; never accepted from a request. */
  readonly principal_id: string;
  /** Trusted deployment environment; never accepted from a request. */
  readonly environment: string;
}>;

export type HnsRouteRevalidationStartResult = Readonly<{
  readonly session: HnsRouteRevalidationSessionV1;
  readonly replayed: boolean;
}>;

export class HnsRouteRevalidationStartRejected extends Data.TaggedError(
  "HnsRouteRevalidationStartRejected",
)<{
  readonly reason: "invalid" | "not_found" | "in_flight" | "conflict" | "stale";
  readonly retry_after_seconds?: number;
}> {}

const START_LEASE_MS = 6_000;

function decodeInput(
  input: unknown,
): Effect.Effect<HnsRouteRevalidationStartInput, HnsRouteRevalidationStartRejected> {
  const decoded = Schema.decodeUnknownOption(
    HnsRouteRevalidationStartInput,
    exactParseOptions,
  )(input);
  return Option.isSome(decoded)
    ? Effect.succeed(decoded.value)
    : Effect.fail(new HnsRouteRevalidationStartRejected({ reason: "invalid" }));
}

function authorityFromInput(
  input: HnsRouteRevalidationStartInput,
  principalId: string,
  environment: string,
): HnsRouteRevalidationStartAuthority {
  return {
    version: HNS_ROUTE_REVALIDATION_AUTHORITY_VERSION,
    route_revalidation_id: input.route_revalidation_id,
    community_id: input.community_id,
    route_binding_id: input.route_binding_id,
    principal_kind: "system",
    principal_id: principalId,
    expected_binding_generation: input.expected_binding_generation,
    expected_verified_evidence_ref: input.expected_verified_evidence_ref,
    requirement_hash: "0".repeat(64),
    provider_id: HNS_ROUTE_REVALIDATION_PROVIDER_ID,
    provider_binding_hash: input.provider_binding_hash,
    provider_configuration_kind: input.provider_configuration.kind,
    provider_configuration_reference: input.provider_configuration.reference,
    provider_configuration_version: input.provider_configuration.version,
    protocol_version: HNS_ROUTE_REVALIDATION_PROTOCOL_VERSION,
    environment,
    family: "hns",
    root_label: input.root_label,
    root_label_display: input.root_label_display,
    path_segment: input.path_segment,
  };
}

function validatePresentation(
  authority: HnsRouteRevalidationStartAuthority,
  result: HnsRouteRevalidationProviderStartResult,
): boolean {
  const decoded = Schema.decodeUnknownOption(
    HnsRouteRevalidationProviderStartResult,
    exactParseOptions,
  )(result);
  if (Option.isNone(decoded)) return false;
  const value = decoded.value;
  const challenge = value.presentation.payload;
  return (
    value.presentation.session_id === value.upstream_session_ref &&
    value.presentation.protocol === "hns-txt-challenge" &&
    challenge.expires_at === value.expires_at &&
    challenge.challenge_name ===
      (challenge.ownership_source === "hns_parent_chain_txt"
        ? authority.root_label
        : `_pirate.${authority.root_label}`) &&
    challenge.challenge_value === `pirate-verification=${value.upstream_session_ref}`
  );
}

function providerFailure(): HnsRouteRevalidationProviderFailed {
  return new HnsRouteRevalidationProviderFailed({ reason: "invalid_response" });
}

/**
 * Starts one scheduler-owned HNS route revalidation. The reservation is the
 * only transaction before provider work; provider I/O is deliberately outside
 * it, and finalization is a separate fenced transaction in the store.
 */
export const startHnsRouteRevalidation = Effect.fn("startHnsRouteRevalidation")(function* (
  schedulerCommand: unknown,
  services: HnsRouteRevalidationStartServices,
): Effect.fn.Return<HnsRouteRevalidationStartResult, HnsRouteRevalidationStartFailure> {
  const input = yield* decodeInput(schedulerCommand);
  const authorityWithoutHash = authorityFromInput(
    input,
    services.principal_id,
    services.environment,
  );
  const requirementHash = yield* Effect.tryPromise({
    try: () => hnsRouteRevalidationRequirementHash(authorityWithoutHash),
    catch: () => new HnsRouteRevalidationStartRejected({ reason: "invalid" }),
  });
  const authority = { ...authorityWithoutHash, requirement_hash: requirementHash };
  const route: HnsRouteRevalidationRoute = {
    family: "hns",
    root_label: authority.root_label,
    root_label_display: authority.root_label_display,
    path_segment: authority.path_segment,
    href: `/c/${authority.path_segment}`,
    app_host: null,
  };
  const provisionalWire: HnsOwnerRouteRevalidationStartWireV1 = {
    operation_kind: "route_revalidation",
    route_revalidation_id: authority.route_revalidation_id,
    revalidation_session_id: input.revalidation_session_id,
    community_id: authority.community_id,
    route_binding_id: authority.route_binding_id,
    expected_binding_generation: authority.expected_binding_generation,
    expected_verified_evidence_ref: authority.expected_verified_evidence_ref,
    principal_kind: "system",
    principal_id: authority.principal_id,
    requirement_hash: authority.requirement_hash,
    start_request_hash: "0".repeat(64),
    provider_binding_hash: authority.provider_binding_hash,
    provider_configuration: {
      kind: authority.provider_configuration_kind,
      reference: authority.provider_configuration_reference,
      version: authority.provider_configuration_version,
    },
    protocol_version: authority.protocol_version,
    environment: authority.environment,
    route,
  };
  const startRequestHash = yield* Effect.tryPromise({
    try: () => hnsRouteRevalidationStartHash(provisionalWire),
    catch: () => new HnsRouteRevalidationStartRejected({ reason: "invalid" }),
  });
  const wire = { ...provisionalWire, start_request_hash: startRequestHash };

  const replay = yield* services.store.replay({
    route_revalidation_id: authority.route_revalidation_id,
    revalidation_session_id: input.revalidation_session_id,
    start_request_hash: startRequestHash,
  });
  if (replay.kind === "replay") return { session: replay.session, replayed: true };
  if (replay.kind === "not_found") {
    return yield* new HnsRouteRevalidationStartRejected({ reason: "not_found" });
  }
  if (replay.kind === "in_flight") {
    return yield* new HnsRouteRevalidationStartRejected({
      reason: "in_flight",
      retry_after_seconds: replay.retry_after_seconds,
    });
  }
  if (replay.kind === "conflict") {
    return yield* new HnsRouteRevalidationStartRejected({ reason: "conflict" });
  }

  const reserved = yield* services.store.reserve({
    authority,
    revalidation_session_id: input.revalidation_session_id,
    start_request_hash: startRequestHash,
    ttl_ms: START_LEASE_MS,
  });
  if (reserved.kind === "replay") return { session: reserved.session, replayed: true };
  if (reserved.kind === "not_found") {
    return yield* new HnsRouteRevalidationStartRejected({ reason: "not_found" });
  }
  if (reserved.kind === "in_flight") {
    return yield* new HnsRouteRevalidationStartRejected({
      reason: "in_flight",
      retry_after_seconds: reserved.retry_after_seconds,
    });
  }
  if (reserved.kind === "conflict") {
    return yield* new HnsRouteRevalidationStartRejected({ reason: "conflict" });
  }

  const reservation = reserved.reservation;
  const started = yield* services.provider.start(wire).pipe(
    Effect.catchDefect(() => Effect.fail(providerFailure())),
    Effect.tapError(() =>
      services.store.release(reservation).pipe(Effect.catch(() => Effect.succeed(undefined))),
    ),
  );
  if (!validatePresentation(authority, started)) {
    yield* services.store.release(reservation).pipe(Effect.catch(() => Effect.succeed(undefined)));
    return yield* providerFailure();
  }
  const finalized = yield* services.store.finalize(reservation, started);
  if (finalized.kind === "created") return { session: finalized.session, replayed: false };
  if (finalized.kind === "replay") return { session: finalized.session, replayed: true };
  if (finalized.kind === "stale") {
    return yield* new HnsRouteRevalidationStartRejected({
      reason: "stale",
      retry_after_seconds: 1,
    });
  }
  return yield* new HnsRouteRevalidationStartRejected({ reason: "conflict" });
});

/** Short alias used by scheduler integrations. */
export {
  HNS_ROUTE_REVALIDATION_PROTOCOL_VERSION,
  HNS_ROUTE_REVALIDATION_PROVIDER_ID,
  hnsRouteRevalidationRequirementHash,
  hnsRouteRevalidationStartHash,
};
