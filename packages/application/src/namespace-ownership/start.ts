import { canonicalJson } from "@pirate/domain";
import { Data, Effect, Option, Schema } from "effect";
import type {
  NamespaceOwnershipProviderFailure,
  NamespaceOwnershipProviderStartInput,
  NamespaceOwnershipProviderStartResult,
} from "./adapter.ts";
import { hnsNamespaceStartHash } from "./hns-evidence.ts";
import type { NamespaceOwnershipProviderRegistryService } from "./registry.ts";

const CanonicalIdentifier = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.trim() === value &&
    new TextEncoder().encode(value).byteLength <= 256 &&
    [...value].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
    })
      ? undefined
      : "Expected a canonical namespace-ownership identifier",
  ),
);

const PositiveInteger = Schema.Int.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value > 0 ? undefined : "Expected a positive safe integer",
  ),
);

/** Application input after authentication and route-path binding. */
export const StartNamespaceOwnershipInput = Schema.Struct({
  actor_id: CanonicalIdentifier,
  creation_intent_id: CanonicalIdentifier,
  ceremony_intent_id: CanonicalIdentifier,
  expected_revision: PositiveInteger,
  idempotency_key: CanonicalIdentifier,
});
export type StartNamespaceOwnershipInput = Schema.Schema.Type<typeof StartNamespaceOwnershipInput>;

/** Authority resolved from the current creation intent, requirement, and ceremony rows. */
export type NamespaceOwnershipStartAuthority = Readonly<{
  readonly actor_id: string;
  readonly creation_intent_id: string;
  readonly ceremony_intent_id: string;
  readonly expected_revision: number;
  readonly requirement_hash: string;
  readonly generation: number;
  readonly provider_id: string;
  readonly provider_binding_hash: string;
  readonly provider_configuration: NamespaceOwnershipProviderStartInput["provider_configuration"];
  readonly route: NamespaceOwnershipProviderStartInput["route"];
}>;

export interface NamespaceOwnershipStartAuthorityResolver {
  readonly resolve: (input: {
    readonly actor_id: string;
    readonly creation_intent_id: string;
    readonly ceremony_intent_id: string;
    readonly expected_revision: number;
  }) => Effect.Effect<
    NamespaceOwnershipStartAuthority | null,
    NamespaceOwnershipStartStorageFailed
  >;
}

export type NamespaceOwnershipStartReservation = Readonly<{
  readonly reservation_id: string;
  readonly namespace_session_id: string;
  readonly expected_revision: number;
  readonly fence_token: number;
  readonly lease_expires_at: string;
}>;

export type NamespaceOwnershipStartReservationOutcome =
  | { readonly kind: "acquired"; readonly reservation: NamespaceOwnershipStartReservation }
  | {
      readonly kind: "replay";
      readonly namespace_session_id: string;
      readonly start: NamespaceOwnershipProviderStartResult;
    }
  | { readonly kind: "in_flight"; readonly retry_after_seconds: number }
  | { readonly kind: "conflict" }
  | {
      readonly kind: "terminal";
      readonly status: "verified" | "failed" | "expired";
      readonly result_hash?: string;
    };

export type NamespaceOwnershipStartReplayInput = Readonly<{
  readonly actor_id: string;
  readonly creation_intent_id: string;
  readonly ceremony_intent_id: string;
  readonly expected_revision: number;
  readonly client_idempotency_key: string;
}>;

export type NamespaceOwnershipStartReplayOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "not_found" }
  | {
      readonly kind: "replay";
      readonly namespace_session_id: string;
      readonly start: NamespaceOwnershipProviderStartResult;
    }
  | {
      readonly kind: "terminal";
      readonly creation_intent_id: string;
      readonly ceremony_intent_id: string;
      readonly generation: number;
      readonly status: "verified" | "failed" | "expired";
      readonly result_hash?: string;
    }
  | { readonly kind: "in_flight"; readonly retry_after_seconds: number }
  | { readonly kind: "conflict" };

export type NamespaceOwnershipStartReservationInput = Readonly<{
  readonly start: NamespaceOwnershipProviderStartInput;
  readonly provider_id: string;
  readonly expected_revision: number;
  readonly client_idempotency_key: string;
  /** Allocated by the application before the provider call. */
  readonly reservation_id: string;
  /** Target-owned id; never the provider's upstream session reference. */
  readonly namespace_session_id: string;
  /** Provider plan plus start deadlines and a small finalization margin. */
  readonly ttl_ms: number;
}>;

export type NamespaceOwnershipStartFinalizeOutcome =
  | {
      readonly kind: "created" | "replay";
      readonly namespace_session_id: string;
      readonly start: NamespaceOwnershipProviderStartResult;
    }
  | { readonly kind: "conflict" }
  | { readonly kind: "stale" };

export interface NamespaceOwnershipStartStore {
  /** Resolve an exact durable replay before any provider registry operation. */
  readonly replay: (
    input: NamespaceOwnershipStartReplayInput,
  ) => Effect.Effect<NamespaceOwnershipStartReplayOutcome, NamespaceOwnershipStartStorageFailed>;
  readonly reserve: (
    input: NamespaceOwnershipStartReservationInput,
  ) => Effect.Effect<
    NamespaceOwnershipStartReservationOutcome,
    NamespaceOwnershipStartStorageFailed
  >;
  readonly finalize: (
    reservation: NamespaceOwnershipStartReservation,
    start: NamespaceOwnershipProviderStartResult,
  ) => Effect.Effect<NamespaceOwnershipStartFinalizeOutcome, NamespaceOwnershipStartStorageFailed>;
  readonly release: (
    reservation: NamespaceOwnershipStartReservation,
  ) => Effect.Effect<void, NamespaceOwnershipStartStorageFailed>;
}

export interface NamespaceOwnershipStartServices {
  readonly intents: NamespaceOwnershipStartAuthorityResolver;
  readonly registry: NamespaceOwnershipProviderRegistryService;
  readonly store: NamespaceOwnershipStartStore;
  /** Trusted deployment environment; never client or provider supplied. */
  readonly environment: string;
  readonly ids?: Readonly<{
    readonly reservation: () => string;
    readonly namespaceSession: () => string;
  }>;
}

export type NamespaceOwnershipStartResponse =
  | Readonly<{
      readonly creation_intent_id: string;
      readonly ceremony_intent_id: string;
      readonly generation: number;
      readonly session_id: string;
      readonly channel: "poll_result";
      readonly status: "pending";
      readonly expires_at: string;
      readonly replayed: boolean;
    }>
  | Readonly<{
      readonly creation_intent_id: string;
      readonly ceremony_intent_id: string;
      readonly generation: number;
      readonly status: "verified";
      readonly result_hash: string;
      readonly replayed: true;
    }>;

export class NamespaceOwnershipStartRejected extends Data.TaggedError(
  "NamespaceOwnershipStartRejected",
)<{
  readonly reason:
    | "invalid"
    | "intent_unavailable"
    | "unsupported"
    | "conflict"
    | "in_flight"
    | "terminal";
  readonly retry_after_seconds?: number;
}> {}

export class NamespaceOwnershipStartStorageFailed extends Data.TaggedError(
  "NamespaceOwnershipStartStorageFailed",
) {}

export type NamespaceOwnershipStartFailure =
  | NamespaceOwnershipStartRejected
  | NamespaceOwnershipStartStorageFailed
  | NamespaceOwnershipProviderFailure;

const START_RESERVATION_MARGIN_MS = 1_000;

const exactParseOptions = { onExcessProperty: "error" } as const;

function decodeInput(
  input: unknown,
): Effect.Effect<StartNamespaceOwnershipInput, NamespaceOwnershipStartRejected> {
  const decoded = Schema.decodeUnknownOption(
    StartNamespaceOwnershipInput,
    exactParseOptions,
  )(input);
  return Option.isSome(decoded)
    ? Effect.succeed(decoded.value)
    : Effect.fail(new NamespaceOwnershipStartRejected({ reason: "invalid" }));
}

function sameAuthority(
  left: NamespaceOwnershipStartAuthority,
  right: NamespaceOwnershipStartAuthority,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function pendingResponse(
  namespaceSessionId: string,
  start: NamespaceOwnershipProviderStartResult,
  replayed: boolean,
): NamespaceOwnershipStartResponse {
  return {
    creation_intent_id: start.session.creation_intent_id,
    ceremony_intent_id: start.session.ceremony_intent_id,
    generation: start.session.generation,
    session_id: namespaceSessionId,
    channel: "poll_result",
    status: "pending",
    expires_at: start.session.expires_at,
    replayed,
  };
}

function verifiedResponse(
  identity: Readonly<{
    readonly creation_intent_id: string;
    readonly ceremony_intent_id: string;
    readonly generation: number;
  }>,
  resultHash: string,
): NamespaceOwnershipStartResponse {
  return {
    creation_intent_id: identity.creation_intent_id,
    ceremony_intent_id: identity.ceremony_intent_id,
    generation: identity.generation,
    status: "verified",
    result_hash: resultHash,
    replayed: true,
  };
}

function generatedId(
  ids: NamespaceOwnershipStartServices["ids"],
  kind: "reservation" | "namespaceSession",
): string {
  const generated = ids?.[kind]();
  if (generated !== undefined) return generated;
  return `namespace-${kind === "reservation" ? "start" : "session"}_${crypto.randomUUID()}`;
}

/**
 * Starts one HNS namespace ceremony. All authority is resolved from Postgres;
 * the provider is called only after the fenced reservation transaction and a
 * second authority read have both succeeded.
 */
export const startNamespaceOwnership = Effect.fn("startNamespaceOwnership")(function* (
  untrustedInput: unknown,
  services: NamespaceOwnershipStartServices,
): Effect.fn.Return<NamespaceOwnershipStartResponse, NamespaceOwnershipStartFailure> {
  const input = yield* decodeInput(untrustedInput);
  const replay = yield* services.store.replay({
    actor_id: input.actor_id,
    creation_intent_id: input.creation_intent_id,
    ceremony_intent_id: input.ceremony_intent_id,
    expected_revision: input.expected_revision,
    client_idempotency_key: input.idempotency_key,
  });
  if (replay.kind === "replay") {
    return pendingResponse(replay.namespace_session_id, replay.start, true);
  }
  if (replay.kind === "terminal") {
    if (replay.status === "verified" && replay.result_hash !== undefined) {
      return verifiedResponse(replay, replay.result_hash);
    }
    return yield* new NamespaceOwnershipStartRejected({ reason: "terminal" });
  }
  if (replay.kind === "conflict") {
    return yield* new NamespaceOwnershipStartRejected({ reason: "conflict" });
  }
  if (replay.kind === "not_found") {
    return yield* new NamespaceOwnershipStartRejected({ reason: "intent_unavailable" });
  }
  if (replay.kind === "in_flight") {
    return yield* new NamespaceOwnershipStartRejected({
      reason: "in_flight",
      retry_after_seconds: replay.retry_after_seconds,
    });
  }
  const resolveInput = {
    actor_id: input.actor_id,
    creation_intent_id: input.creation_intent_id,
    ceremony_intent_id: input.ceremony_intent_id,
    expected_revision: input.expected_revision,
  } as const;
  const authority = yield* services.intents.resolve(resolveInput);
  if (
    authority === null ||
    authority.expected_revision !== input.expected_revision ||
    authority.route.family !== "hns" ||
    authority.route.app_host !== null
  ) {
    return yield* new NamespaceOwnershipStartRejected({ reason: "intent_unavailable" });
  }
  const provider = yield* services.registry
    .resolve("hns")
    .pipe(Effect.mapError(() => new NamespaceOwnershipStartRejected({ reason: "unsupported" })));
  if (provider.manifest.provider_id !== authority.provider_id) {
    return yield* new NamespaceOwnershipStartRejected({ reason: "unsupported" });
  }
  if (
    provider.manifest.protocol_versions.length !== 1 ||
    !provider.manifest.environments.includes(services.environment)
  ) {
    return yield* new NamespaceOwnershipStartRejected({ reason: "unsupported" });
  }
  const protocolVersion = provider.manifest.protocol_versions[0];
  const reservationTtlMs =
    provider.manifest.operation_deadlines.plan_ms +
    provider.manifest.operation_deadlines.start_ms +
    START_RESERVATION_MARGIN_MS;
  if (protocolVersion === undefined || !Number.isSafeInteger(reservationTtlMs)) {
    return yield* new NamespaceOwnershipStartRejected({ reason: "unsupported" });
  }

  const hashInput = {
    actor_id: authority.actor_id,
    creation_intent_id: authority.creation_intent_id,
    ceremony_intent_id: authority.ceremony_intent_id,
    requirement_hash: authority.requirement_hash,
    generation: authority.generation,
    provider_id: authority.provider_id,
    provider_binding_hash: authority.provider_binding_hash,
    provider_configuration: authority.provider_configuration,
    protocol_version: protocolVersion,
    environment: services.environment,
    route: authority.route,
  };
  const request_hash = yield* Effect.tryPromise({
    try: () => hnsNamespaceStartHash(hashInput),
    catch: () => new NamespaceOwnershipStartRejected({ reason: "invalid" }),
  });
  const startInput = {
    actor_id: authority.actor_id,
    creation_intent_id: authority.creation_intent_id,
    ceremony_intent_id: authority.ceremony_intent_id,
    requirement_hash: authority.requirement_hash,
    generation: authority.generation,
    request_hash,
    provider_binding_hash: authority.provider_binding_hash,
    provider_configuration: authority.provider_configuration,
    protocol_version: protocolVersion,
    environment: services.environment,
    route: authority.route,
  } satisfies NamespaceOwnershipProviderStartInput;
  const reservationOutcome = yield* services.store.reserve({
    start: startInput,
    provider_id: authority.provider_id,
    expected_revision: input.expected_revision,
    client_idempotency_key: input.idempotency_key,
    reservation_id: generatedId(services.ids, "reservation"),
    namespace_session_id: generatedId(services.ids, "namespaceSession"),
    ttl_ms: reservationTtlMs,
  });

  if (reservationOutcome.kind === "replay") {
    return pendingResponse(reservationOutcome.namespace_session_id, reservationOutcome.start, true);
  }
  if (reservationOutcome.kind === "in_flight") {
    return yield* new NamespaceOwnershipStartRejected({
      reason: "in_flight",
      retry_after_seconds: reservationOutcome.retry_after_seconds,
    });
  }
  if (reservationOutcome.kind === "conflict") {
    return yield* new NamespaceOwnershipStartRejected({ reason: "conflict" });
  }
  if (reservationOutcome.kind === "terminal") {
    if (reservationOutcome.status === "verified" && reservationOutcome.result_hash !== undefined) {
      return verifiedResponse(authority, reservationOutcome.result_hash);
    }
    return yield* new NamespaceOwnershipStartRejected({ reason: "terminal" });
  }

  const reservation = reservationOutcome.reservation;
  const revalidated = yield* services.intents
    .resolve(resolveInput)
    .pipe(
      Effect.tapError(() =>
        services.store.release(reservation).pipe(Effect.catch(() => Effect.succeed(undefined))),
      ),
    );
  if (
    revalidated === null ||
    revalidated.route.family !== "hns" ||
    revalidated.route.app_host !== null ||
    !sameAuthority(authority, revalidated)
  ) {
    yield* services.store.release(reservation).pipe(Effect.catch(() => Effect.succeed(undefined)));
    return yield* new NamespaceOwnershipStartRejected({ reason: "intent_unavailable" });
  }

  const planned = yield* provider
    .plan({ route: authority.route, environment: services.environment })
    .pipe(
      Effect.tapError(() =>
        services.store.release(reservation).pipe(Effect.catch(() => Effect.succeed(undefined))),
      ),
    );
  if (
    planned.status === "unsupported" ||
    planned.protocol_version !== protocolVersion ||
    planned.provider_configuration.kind !== authority.provider_configuration.kind ||
    planned.provider_configuration.reference !== authority.provider_configuration.reference ||
    planned.provider_configuration.version !== authority.provider_configuration.version
  ) {
    yield* services.store.release(reservation).pipe(Effect.catch(() => Effect.succeed(undefined)));
    return yield* new NamespaceOwnershipStartRejected({ reason: "unsupported" });
  }

  const started = yield* provider
    .start(startInput)
    .pipe(
      Effect.tapError(() =>
        services.store.release(reservation).pipe(Effect.catch(() => Effect.succeed(undefined))),
      ),
    );
  const finalized = yield* services.store.finalize(reservation, started);
  if (finalized.kind === "conflict") {
    return yield* new NamespaceOwnershipStartRejected({ reason: "conflict" });
  }
  if (finalized.kind === "stale") {
    return yield* new NamespaceOwnershipStartRejected({
      reason: "in_flight",
      retry_after_seconds: 1,
    });
  }
  return pendingResponse(
    finalized.namespace_session_id,
    finalized.start,
    finalized.kind === "replay",
  );
});
