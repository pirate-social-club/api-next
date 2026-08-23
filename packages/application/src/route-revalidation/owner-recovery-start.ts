import { canonicalJson } from "@pirate/domain";
import { Data, DateTime, Effect, Option, Schema } from "effect";
import {
  buildHnsOwnerRecoveryProviderStart,
  finalizeHnsOwnerRecoveryProviderStart,
  HNS_OWNER_RECOVERY_PROTOCOL_VERSION,
  HNS_OWNER_RECOVERY_PROVIDER_ID,
  type HnsOwnerRecoveryAuthorityV1,
  type HnsOwnerRecoveryPersistedSessionAuthority,
  type HnsOwnerRecoveryPersistedSessionV1,
  type HnsOwnerRecoveryProviderStartResponseV1,
  type HnsOwnerRecoveryStartRequestV1,
  type HnsOwnerSameRootRecoveryProviderStartV1,
  hnsOwnerRecoveryPublicStartHash,
  hnsOwnerRecoveryRequirementHash,
  hnsOwnerRecoveryStartResponse,
} from "./owner-recovery.ts";

const CanonicalIdentifier = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.trim() === value &&
    new TextEncoder().encode(value).byteLength <= 256 &&
    [...value].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
    })
      ? undefined
      : "Expected a canonical owner-recovery identifier",
  ),
);
const PositiveSafeInteger = Schema.Int.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value > 0 ? undefined : "Expected a positive safe integer",
  ),
);

export const HNS_OWNER_RECOVERY_START_PROVIDER_DEADLINE_MS = 5_000;
export const HNS_OWNER_RECOVERY_START_LEASE_MS =
  HNS_OWNER_RECOVERY_START_PROVIDER_DEADLINE_MS + 3_000;

export const StartHnsOwnerRecoveryInput = Schema.Struct({
  actor_id: CanonicalIdentifier,
  community_id: CanonicalIdentifier,
  expected_generation: PositiveSafeInteger,
  idempotency_key: CanonicalIdentifier,
});
export type StartHnsOwnerRecoveryInput = Schema.Schema.Type<typeof StartHnsOwnerRecoveryInput>;

export type HnsOwnerRecoveryStoredStart = Readonly<{
  readonly session: HnsOwnerRecoveryPersistedSessionV1;
  readonly session_authority: HnsOwnerRecoveryPersistedSessionAuthority;
}>;

export type HnsOwnerRecoveryStartReplayOutcome =
  | Readonly<{ readonly kind: "none" }>
  | Readonly<{ readonly kind: "not_found" }>
  | Readonly<{ readonly kind: "replay"; readonly stored: HnsOwnerRecoveryStoredStart }>
  | Readonly<{ readonly kind: "in_flight"; readonly retry_after_seconds: number }>
  | Readonly<{ readonly kind: "conflict" }>;

export type HnsOwnerRecoveryStartReservation = Readonly<{
  readonly reservation_id: string;
  readonly route_recovery_id: string;
  readonly session_id: string;
  readonly fence_token: number;
  readonly database_started_at: string;
  readonly lease_expires_at: string;
  /** Authority re-read under the durable reservation lock. */
  readonly authority: HnsOwnerRecoveryAuthorityV1;
}>;

export type HnsOwnerRecoveryStartReservationOutcome =
  | Readonly<{
      readonly kind: "acquired";
      readonly reservation: HnsOwnerRecoveryStartReservation;
    }>
  | Readonly<{ readonly kind: "replay"; readonly stored: HnsOwnerRecoveryStoredStart }>
  | Readonly<{ readonly kind: "in_flight"; readonly retry_after_seconds: number }>
  | Readonly<{ readonly kind: "conflict" }>
  | Readonly<{ readonly kind: "not_found" }>;

export type HnsOwnerRecoveryStartFinalizeOutcome =
  | Readonly<{ readonly kind: "created" }>
  | Readonly<{ readonly kind: "replay"; readonly stored: HnsOwnerRecoveryStoredStart }>
  | Readonly<{ readonly kind: "stale" }>
  | Readonly<{ readonly kind: "conflict" }>;

export interface HnsOwnerRecoveryAuthorityResolver {
  /**
   * Returns authority only after proving the browser-session actor is exactly
   * `communities.created_by_user_id`. A different actor, missing community, or
   * ineligible binding is enumeration-safe absence.
   */
  readonly resolve: (
    input: Readonly<{
      readonly actor_id: string;
      readonly community_id: string;
      readonly expected_generation: number;
    }>,
  ) => Effect.Effect<HnsOwnerRecoveryAuthorityV1 | null, HnsOwnerRecoveryStartStorageFailed>;
}

export interface HnsOwnerRecoveryStartStore {
  /**
   * Replays only a session owned by the exact creator actor, community,
   * generation, idempotency key, and public-start hash authority.
   */
  readonly replay: (
    input: StartHnsOwnerRecoveryInput,
  ) => Effect.Effect<HnsOwnerRecoveryStartReplayOutcome, HnsOwnerRecoveryStartStorageFailed>;
  /**
   * Under community-then-binding lock, re-proves exact creator ownership and
   * all expected authority, captures database time, and returns a lease at
   * least `lease_ms` long. No transaction may span the provider call.
   */
  readonly reserve: (
    input: Readonly<{
      readonly request: StartHnsOwnerRecoveryInput;
      readonly expected_authority: HnsOwnerRecoveryAuthorityV1;
      readonly requirement_hash: string;
      readonly public_start_hash: string;
      readonly reservation_id: string;
      readonly route_recovery_id: string;
      readonly session_id: string;
      /** Required database lease covering the provider boundary plus margin. */
      readonly lease_ms: number;
    }>,
  ) => Effect.Effect<HnsOwnerRecoveryStartReservationOutcome, HnsOwnerRecoveryStartStorageFailed>;
  /**
   * Under the same lock order and reservation fence, atomically persists the
   * immutable owner session and its exact start hashes or returns replay/stale.
   */
  readonly finalize: (
    input: Readonly<{
      readonly reservation: HnsOwnerRecoveryStartReservation;
      readonly start_idempotency_key: string;
      readonly public_start_hash: string;
      readonly session: HnsOwnerRecoveryPersistedSessionV1;
      readonly session_authority: HnsOwnerRecoveryPersistedSessionAuthority;
    }>,
  ) => Effect.Effect<HnsOwnerRecoveryStartFinalizeOutcome, HnsOwnerRecoveryStartStorageFailed>;
  readonly release: (
    reservation: HnsOwnerRecoveryStartReservation,
  ) => Effect.Effect<void, HnsOwnerRecoveryStartStorageFailed>;
}

export interface HnsOwnerRecoveryProvider {
  /**
   * Bound-only provider call. The adapter enforces the supplied deadline and
   * strictly decodes the frozen, bounded HNS start response with its complete
   * embedded presentation; it never returns a simplified challenge clone.
   */
  readonly start: (
    request: HnsOwnerSameRootRecoveryProviderStartV1,
    options: Readonly<{ readonly deadline_ms: number }>,
  ) => Effect.Effect<HnsOwnerRecoveryProviderStartResponseV1, HnsOwnerRecoveryProviderFailed>;
}

export interface HnsOwnerRecoveryStartServices {
  readonly authority: HnsOwnerRecoveryAuthorityResolver;
  readonly store: HnsOwnerRecoveryStartStore;
  readonly provider: HnsOwnerRecoveryProvider;
  readonly ids?: Readonly<{
    readonly reservation: () => string;
    readonly recovery: () => string;
    readonly session: () => string;
  }>;
}

export class HnsOwnerRecoveryStartRejected extends Data.TaggedError(
  "HnsOwnerRecoveryStartRejected",
)<{
  readonly reason: "invalid" | "not_found" | "ineligible" | "conflict" | "in_flight";
  readonly retry_after_seconds?: number;
}> {}

export class HnsOwnerRecoveryStartStorageFailed extends Data.TaggedError(
  "HnsOwnerRecoveryStartStorageFailed",
) {}

export class HnsOwnerRecoveryProviderFailed extends Data.TaggedError(
  "HnsOwnerRecoveryProviderFailed",
)<{
  readonly reason: "unavailable" | "misconfigured" | "invalid_response";
}> {}

export type HnsOwnerRecoveryStartFailure =
  | HnsOwnerRecoveryStartRejected
  | HnsOwnerRecoveryStartStorageFailed
  | HnsOwnerRecoveryProviderFailed;

const exactParseOptions = { onExcessProperty: "error" } as const;

function decodeInput(
  input: unknown,
): Effect.Effect<StartHnsOwnerRecoveryInput, HnsOwnerRecoveryStartRejected> {
  const decoded = Schema.decodeUnknownOption(StartHnsOwnerRecoveryInput, exactParseOptions)(input);
  return Option.isSome(decoded)
    ? Effect.succeed(decoded.value)
    : Effect.fail(new HnsOwnerRecoveryStartRejected({ reason: "invalid" }));
}

function generatedId(
  services: HnsOwnerRecoveryStartServices,
  kind: "reservation" | "recovery" | "session",
): string {
  return services.ids?.[kind]() ?? `hns-owner-${kind}_${crypto.randomUUID()}`;
}

function validAuthority(
  input: StartHnsOwnerRecoveryInput,
  authority: HnsOwnerRecoveryAuthorityV1,
): boolean {
  return (
    authority.actor_id === input.actor_id &&
    authority.community_id === input.community_id &&
    authority.expected_binding_generation === input.expected_generation &&
    authority.provider_id === HNS_OWNER_RECOVERY_PROVIDER_ID &&
    authority.protocol_version === HNS_OWNER_RECOVERY_PROTOCOL_VERSION &&
    authority.route.family === "hns" &&
    authority.route.app_host === null
  );
}

function sameAuthority(
  left: HnsOwnerRecoveryAuthorityV1,
  right: HnsOwnerRecoveryAuthorityV1,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function replayResponse(input: StartHnsOwnerRecoveryInput, stored: HnsOwnerRecoveryStoredStart) {
  if (
    stored.session.actor_id !== input.actor_id ||
    stored.session.community_id !== input.community_id ||
    stored.session.expected_binding_generation !== input.expected_generation ||
    stored.session_authority.start_idempotency_key !== input.idempotency_key
  ) {
    return Effect.fail(new HnsOwnerRecoveryStartRejected({ reason: "not_found" }));
  }
  return Effect.tryPromise({
    try: () =>
      hnsOwnerRecoveryStartResponse({
        session: stored.session,
        session_authority: stored.session_authority,
        replayed: true,
      }),
    catch: () => new HnsOwnerRecoveryStartRejected({ reason: "conflict" }),
  });
}

function releaseBestEffort(
  store: HnsOwnerRecoveryStartStore,
  reservation: HnsOwnerRecoveryStartReservation,
): Effect.Effect<void> {
  return Effect.try({
    try: () => store.release(reservation),
    catch: () => new HnsOwnerRecoveryStartStorageFailed(),
  }).pipe(Effect.flatten, Effect.ignoreCause);
}

function leaseCoversProviderBoundary(reservation: HnsOwnerRecoveryStartReservation): boolean {
  const started = DateTime.make(reservation.database_started_at);
  const expires = DateTime.make(reservation.lease_expires_at);
  return (
    Option.isSome(started) &&
    Option.isSome(expires) &&
    DateTime.toEpochMillis(expires.value) - DateTime.toEpochMillis(started.value) >=
      HNS_OWNER_RECOVERY_START_LEASE_MS
  );
}

/**
 * Orchestrates owner-present recovery without providing persistence itself.
 * The provider call happens only after a store-owned database-time reservation
 * has re-read and returned the exact authority being fenced. This use case is
 * browser-session intake only and must never be registered in the scheduler.
 */
export const startHnsOwnerRecovery = Effect.fn("startHnsOwnerRecovery")(function* (
  untrustedInput: unknown,
  services: HnsOwnerRecoveryStartServices,
) {
  const input = yield* decodeInput(untrustedInput);
  const replay = yield* services.store.replay(input);
  if (replay.kind === "replay") return yield* replayResponse(input, replay.stored);
  if (replay.kind === "not_found") {
    return yield* new HnsOwnerRecoveryStartRejected({ reason: "not_found" });
  }
  if (replay.kind === "conflict") {
    return yield* new HnsOwnerRecoveryStartRejected({ reason: "conflict" });
  }
  if (replay.kind === "in_flight") {
    return yield* new HnsOwnerRecoveryStartRejected({
      reason: "in_flight",
      retry_after_seconds: replay.retry_after_seconds,
    });
  }

  const authority = yield* services.authority.resolve({
    actor_id: input.actor_id,
    community_id: input.community_id,
    expected_generation: input.expected_generation,
  });
  if (authority === null) {
    return yield* new HnsOwnerRecoveryStartRejected({ reason: "not_found" });
  }
  if (!validAuthority(input, authority)) {
    return yield* new HnsOwnerRecoveryStartRejected({ reason: "ineligible" });
  }
  const requirementHash = yield* Effect.tryPromise({
    try: () => hnsOwnerRecoveryRequirementHash(authority),
    catch: () => new HnsOwnerRecoveryStartRejected({ reason: "ineligible" }),
  });
  const startRequest: HnsOwnerRecoveryStartRequestV1 = {
    expected_generation: input.expected_generation,
    idempotency_key: input.idempotency_key,
  };
  const publicStartHash = yield* Effect.tryPromise({
    try: () =>
      hnsOwnerRecoveryPublicStartHash({
        actor_id: authority.actor_id,
        community_id: authority.community_id,
        route_binding_id: authority.route_binding_id,
        expected_binding_generation: authority.expected_binding_generation,
        idempotency_key: input.idempotency_key,
        requirement_hash: requirementHash,
      }),
    catch: () => new HnsOwnerRecoveryStartRejected({ reason: "ineligible" }),
  });
  const reservationOutcome = yield* services.store.reserve({
    request: input,
    expected_authority: authority,
    requirement_hash: requirementHash,
    public_start_hash: publicStartHash,
    reservation_id: generatedId(services, "reservation"),
    route_recovery_id: generatedId(services, "recovery"),
    session_id: generatedId(services, "session"),
    lease_ms: HNS_OWNER_RECOVERY_START_LEASE_MS,
  });
  if (reservationOutcome.kind === "replay") {
    return yield* replayResponse(input, reservationOutcome.stored);
  }
  if (reservationOutcome.kind === "not_found") {
    return yield* new HnsOwnerRecoveryStartRejected({ reason: "not_found" });
  }
  if (reservationOutcome.kind === "conflict") {
    return yield* new HnsOwnerRecoveryStartRejected({ reason: "conflict" });
  }
  if (reservationOutcome.kind === "in_flight") {
    return yield* new HnsOwnerRecoveryStartRejected({
      reason: "in_flight",
      retry_after_seconds: reservationOutcome.retry_after_seconds,
    });
  }

  const reservation = reservationOutcome.reservation;
  const leaseCoversBoundary = leaseCoversProviderBoundary(reservation);
  if (
    !validAuthority(input, reservation.authority) ||
    !sameAuthority(authority, reservation.authority)
  ) {
    yield* releaseBestEffort(services.store, reservation);
    return yield* new HnsOwnerRecoveryStartRejected({ reason: "ineligible" });
  }
  if (!leaseCoversBoundary) {
    yield* releaseBestEffort(services.store, reservation);
    return yield* new HnsOwnerRecoveryStartStorageFailed();
  }
  const providerStart = yield* Effect.tryPromise({
    try: () =>
      buildHnsOwnerRecoveryProviderStart({
        route_recovery_id: reservation.route_recovery_id,
        session_id: reservation.session_id,
        authority: reservation.authority,
        database_started_at: reservation.database_started_at,
      }),
    catch: () => new HnsOwnerRecoveryProviderFailed({ reason: "invalid_response" }),
  }).pipe(Effect.tapError(() => releaseBestEffort(services.store, reservation)));
  const providerEffect = Effect.try({
    try: () =>
      services.provider.start(providerStart, {
        deadline_ms: HNS_OWNER_RECOVERY_START_PROVIDER_DEADLINE_MS,
      }),
    catch: () => new HnsOwnerRecoveryProviderFailed({ reason: "invalid_response" }),
  });
  const providerResult = yield* providerEffect.pipe(
    Effect.flatten,
    Effect.catchDefect(() =>
      Effect.fail(new HnsOwnerRecoveryProviderFailed({ reason: "invalid_response" })),
    ),
    Effect.matchEffect({
      onSuccess: (response) => Effect.succeed({ kind: "success" as const, response }),
      onFailure: (error) => Effect.succeed({ kind: "failure" as const, error }),
    }),
  );
  if (providerResult.kind === "failure") {
    yield* releaseBestEffort(services.store, reservation);
    return yield* providerResult.error;
  }
  const finalizedKernel = yield* Effect.tryPromise({
    try: () =>
      finalizeHnsOwnerRecoveryProviderStart({
        provider_start: providerStart,
        public_start_hash: publicStartHash,
        start_request: startRequest,
        started_at: reservation.database_started_at,
        provider_response: providerResult.response,
      }),
    catch: () => new HnsOwnerRecoveryProviderFailed({ reason: "invalid_response" }),
  }).pipe(Effect.tapError(() => releaseBestEffort(services.store, reservation)));
  const sessionAuthority: HnsOwnerRecoveryPersistedSessionAuthority = {
    expected_route_recovery_id: reservation.route_recovery_id,
    expected_session_id: reservation.session_id,
    start_idempotency_key: input.idempotency_key,
    expected_public_start_hash: publicStartHash,
    expected_upstream_session_ref: finalizedKernel.session.upstream_session_ref,
    expected_ownership_source: finalizedKernel.session.ownership_source,
    expected_challenge_expires_at: finalizedKernel.session.challenge_expires_at,
  };
  const finalizeEffect = Effect.try({
    try: () =>
      services.store.finalize({
        reservation,
        start_idempotency_key: input.idempotency_key,
        public_start_hash: publicStartHash,
        session: finalizedKernel.session,
        session_authority: sessionAuthority,
      }),
    catch: () => new HnsOwnerRecoveryStartStorageFailed(),
  });
  const finalized = yield* finalizeEffect.pipe(
    Effect.flatten,
    Effect.catchDefect(() => Effect.fail(new HnsOwnerRecoveryStartStorageFailed())),
    Effect.tapError(() => releaseBestEffort(services.store, reservation)),
  );
  if (finalized.kind === "replay") return yield* replayResponse(input, finalized.stored);
  if (finalized.kind === "conflict") {
    return yield* new HnsOwnerRecoveryStartRejected({ reason: "conflict" });
  }
  if (finalized.kind === "stale") {
    return yield* new HnsOwnerRecoveryStartRejected({
      reason: "in_flight",
      retry_after_seconds: 1,
    });
  }
  return finalizedKernel.response;
});
