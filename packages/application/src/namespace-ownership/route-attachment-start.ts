import { type HnsTxtChallengeV1 as HnsTxtChallenge, HnsTxtChallengeV1 } from "@pirate/contracts";
import { canonicalJson } from "@pirate/domain";
import { Data, Effect, Option, Schema } from "effect";
import type {
  NamespaceOwnershipProviderFailure,
  RouteAttachmentOwnershipProviderStartInput,
  RouteAttachmentOwnershipProviderStartResult,
} from "./adapter.ts";
import {
  HNS_OWNER_PROTOCOL_VERSION,
  HNS_OWNER_PROVIDER_ID,
  hnsOwnerChallengeName,
  hnsOwnerChallengeValue,
  hnsRouteAttachmentStartHash,
} from "./hns-evidence.ts";
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
      : "Expected a canonical route-attachment identifier",
  ),
);

const PositiveInteger = Schema.Int.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value > 0 ? undefined : "Expected a positive safe integer",
  ),
);

export const StartRouteAttachmentOwnershipInput = Schema.Struct({
  actor_id: CanonicalIdentifier,
  community_id: CanonicalIdentifier,
  attachment_intent_id: CanonicalIdentifier,
  ceremony_intent_id: CanonicalIdentifier,
  expected_revision: PositiveInteger,
  idempotency_key: CanonicalIdentifier,
});
export type StartRouteAttachmentOwnershipInput = Schema.Schema.Type<
  typeof StartRouteAttachmentOwnershipInput
>;

export type RouteAttachmentOwnershipStartAuthority = Readonly<{
  readonly actor_id: string;
  readonly community_id: string;
  readonly attachment_intent_id: string;
  readonly ceremony_intent_id: string;
  readonly expected_revision: number;
  readonly requirement_hash: string;
  readonly generation: number;
  readonly provider_id: string;
  readonly provider_binding_hash: string;
  readonly provider_configuration: RouteAttachmentOwnershipProviderStartInput["provider_configuration"];
  readonly route: RouteAttachmentOwnershipProviderStartInput["route"];
}>;

export interface RouteAttachmentOwnershipStartAuthorityResolver {
  readonly resolve: (input: {
    readonly actor_id: string;
    readonly community_id: string;
    readonly attachment_intent_id: string;
    readonly ceremony_intent_id: string;
    readonly expected_revision: number;
  }) => Effect.Effect<
    RouteAttachmentOwnershipStartAuthority | null,
    RouteAttachmentOwnershipStartStorageFailed
  >;
}

export type RouteAttachmentOwnershipStartReservation = Readonly<{
  readonly reservation_id: string;
  readonly namespace_session_id: string;
  readonly expected_revision: number;
  readonly fence_token: number;
  readonly lease_expires_at: string;
}>;

export type RouteAttachmentOwnershipStartReservationOutcome =
  | {
      readonly kind: "acquired";
      readonly reservation: RouteAttachmentOwnershipStartReservation;
    }
  | {
      readonly kind: "replay";
      readonly namespace_session_id: string;
      readonly start: RouteAttachmentOwnershipProviderStartResult;
    }
  | { readonly kind: "in_flight"; readonly retry_after_seconds: number }
  | { readonly kind: "conflict" }
  | {
      readonly kind: "terminal";
      readonly status: "verified" | "failed" | "expired";
      readonly result_hash?: string;
    };

export type RouteAttachmentOwnershipStartReplayInput = Readonly<{
  readonly actor_id: string;
  readonly community_id: string;
  readonly attachment_intent_id: string;
  readonly ceremony_intent_id: string;
  readonly expected_revision: number;
  readonly client_idempotency_key: string;
}>;

export type RouteAttachmentOwnershipStartReplayOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "not_found" }
  | {
      readonly kind: "replay";
      readonly namespace_session_id: string;
      readonly start: RouteAttachmentOwnershipProviderStartResult;
    }
  | {
      readonly kind: "terminal";
      readonly community_id: string;
      readonly attachment_intent_id: string;
      readonly ceremony_intent_id: string;
      readonly generation: number;
      readonly status: "verified" | "failed" | "expired";
      readonly result_hash?: string;
    }
  | { readonly kind: "in_flight"; readonly retry_after_seconds: number }
  | { readonly kind: "conflict" };

export type RouteAttachmentOwnershipStartReservationInput = Readonly<{
  readonly start: RouteAttachmentOwnershipProviderStartInput;
  readonly provider_id: string;
  readonly expected_revision: number;
  readonly client_idempotency_key: string;
  readonly reservation_id: string;
  readonly namespace_session_id: string;
  readonly ttl_ms: number;
}>;

export type RouteAttachmentOwnershipStartFinalizeOutcome =
  | {
      readonly kind: "created" | "replay";
      readonly namespace_session_id: string;
      readonly start: RouteAttachmentOwnershipProviderStartResult;
    }
  | { readonly kind: "conflict" }
  | { readonly kind: "stale" };

export interface RouteAttachmentOwnershipStartStore {
  readonly replay: (
    input: RouteAttachmentOwnershipStartReplayInput,
  ) => Effect.Effect<
    RouteAttachmentOwnershipStartReplayOutcome,
    RouteAttachmentOwnershipStartStorageFailed
  >;
  readonly reserve: (
    input: RouteAttachmentOwnershipStartReservationInput,
  ) => Effect.Effect<
    RouteAttachmentOwnershipStartReservationOutcome,
    RouteAttachmentOwnershipStartStorageFailed
  >;
  readonly finalize: (
    reservation: RouteAttachmentOwnershipStartReservation,
    start: RouteAttachmentOwnershipProviderStartResult,
  ) => Effect.Effect<
    RouteAttachmentOwnershipStartFinalizeOutcome,
    RouteAttachmentOwnershipStartStorageFailed
  >;
  readonly release: (
    reservation: RouteAttachmentOwnershipStartReservation,
  ) => Effect.Effect<void, RouteAttachmentOwnershipStartStorageFailed>;
}

export interface RouteAttachmentOwnershipStartServices {
  readonly intents: RouteAttachmentOwnershipStartAuthorityResolver;
  readonly registry: NamespaceOwnershipProviderRegistryService;
  readonly store: RouteAttachmentOwnershipStartStore;
  readonly environment: string;
  readonly ids?: Readonly<{
    readonly reservation: () => string;
    readonly namespaceSession: () => string;
  }>;
}

export type RouteAttachmentOwnershipStartResponse =
  | Readonly<{
      readonly operation_kind: "route_attachment";
      readonly community_id: string;
      readonly attachment_intent_id: string;
      readonly ceremony_intent_id: string;
      readonly generation: number;
      readonly session_id: string;
      readonly channel: "poll_result";
      readonly status: "pending";
      readonly expires_at: string;
      readonly challenge: HnsTxtChallenge;
      readonly replayed: boolean;
    }>
  | Readonly<{
      readonly operation_kind: "route_attachment";
      readonly community_id: string;
      readonly attachment_intent_id: string;
      readonly ceremony_intent_id: string;
      readonly generation: number;
      readonly status: "verified";
      readonly result_hash: string;
      readonly replayed: true;
    }>;

export class RouteAttachmentOwnershipStartRejected extends Data.TaggedError(
  "RouteAttachmentOwnershipStartRejected",
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

export class RouteAttachmentOwnershipStartStorageFailed extends Data.TaggedError(
  "RouteAttachmentOwnershipStartStorageFailed",
) {}

export type RouteAttachmentOwnershipStartFailure =
  | RouteAttachmentOwnershipStartRejected
  | RouteAttachmentOwnershipStartStorageFailed
  | NamespaceOwnershipProviderFailure;

const START_RESERVATION_MARGIN_MS = 1_000;
const exactParseOptions = { onExcessProperty: "error" } as const;

function decodeInput(
  input: unknown,
): Effect.Effect<StartRouteAttachmentOwnershipInput, RouteAttachmentOwnershipStartRejected> {
  const decoded = Schema.decodeUnknownOption(
    StartRouteAttachmentOwnershipInput,
    exactParseOptions,
  )(input);
  return Option.isSome(decoded)
    ? Effect.succeed(decoded.value)
    : Effect.fail(new RouteAttachmentOwnershipStartRejected({ reason: "invalid" }));
}

function sameAuthority(
  left: RouteAttachmentOwnershipStartAuthority,
  right: RouteAttachmentOwnershipStartAuthority,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function pendingResponse(
  namespaceSessionId: string,
  start: RouteAttachmentOwnershipProviderStartResult,
  replayed: boolean,
): RouteAttachmentOwnershipStartResponse | null {
  if (
    start.presentation.kind !== "embedded_sdk" ||
    start.presentation.protocol !== "hns-txt-challenge" ||
    start.presentation.version !== "1"
  ) {
    return null;
  }
  const challenge = Schema.decodeUnknownOption(
    HnsTxtChallengeV1,
    exactParseOptions,
  )(start.presentation.payload);
  if (
    Option.isNone(challenge) ||
    start.session.operation_kind !== "route_attachment" ||
    start.session.provider_id !== HNS_OWNER_PROVIDER_ID ||
    start.session.protocol_version !== HNS_OWNER_PROTOCOL_VERSION ||
    start.session.route.family !== "hns" ||
    start.presentation.session_id !== start.session.upstream_session_ref ||
    challenge.value.expires_at !== start.session.expires_at ||
    challenge.value.challenge_name !==
      hnsOwnerChallengeName(challenge.value.ownership_source, start.session.route.root_label) ||
    challenge.value.challenge_value !== hnsOwnerChallengeValue(start.session.upstream_session_ref)
  ) {
    return null;
  }
  return {
    operation_kind: "route_attachment",
    community_id: start.session.community_id,
    attachment_intent_id: start.session.attachment_intent_id,
    ceremony_intent_id: start.session.ceremony_intent_id,
    generation: start.session.generation,
    session_id: namespaceSessionId,
    channel: "poll_result",
    status: "pending",
    expires_at: start.session.expires_at,
    challenge: challenge.value,
    replayed,
  };
}

function verifiedResponse(
  identity: Readonly<{
    readonly community_id: string;
    readonly attachment_intent_id: string;
    readonly ceremony_intent_id: string;
    readonly generation: number;
  }>,
  resultHash: string,
): RouteAttachmentOwnershipStartResponse {
  return {
    operation_kind: "route_attachment",
    community_id: identity.community_id,
    attachment_intent_id: identity.attachment_intent_id,
    ceremony_intent_id: identity.ceremony_intent_id,
    generation: identity.generation,
    status: "verified",
    result_hash: resultHash,
    replayed: true,
  };
}

function generatedId(
  ids: RouteAttachmentOwnershipStartServices["ids"],
  kind: "reservation" | "namespaceSession",
): string {
  const generated = ids?.[kind]();
  if (generated !== undefined) return generated;
  return `route-attachment-namespace-${kind === "reservation" ? "start" : "session"}_${crypto.randomUUID()}`;
}

export const startRouteAttachmentOwnership = Effect.fn("startRouteAttachmentOwnership")(function* (
  untrustedInput: unknown,
  services: RouteAttachmentOwnershipStartServices,
): Effect.fn.Return<RouteAttachmentOwnershipStartResponse, RouteAttachmentOwnershipStartFailure> {
  const input = yield* decodeInput(untrustedInput);
  const replay = yield* services.store.replay({
    actor_id: input.actor_id,
    community_id: input.community_id,
    attachment_intent_id: input.attachment_intent_id,
    ceremony_intent_id: input.ceremony_intent_id,
    expected_revision: input.expected_revision,
    client_idempotency_key: input.idempotency_key,
  });
  if (replay.kind === "replay") {
    const response = pendingResponse(replay.namespace_session_id, replay.start, true);
    return response === null
      ? yield* new RouteAttachmentOwnershipStartRejected({ reason: "invalid" })
      : response;
  }
  if (replay.kind === "terminal") {
    if (replay.status === "verified" && replay.result_hash !== undefined) {
      return verifiedResponse(replay, replay.result_hash);
    }
    return yield* new RouteAttachmentOwnershipStartRejected({ reason: "terminal" });
  }
  if (replay.kind === "conflict") {
    return yield* new RouteAttachmentOwnershipStartRejected({ reason: "conflict" });
  }
  if (replay.kind === "not_found") {
    return yield* new RouteAttachmentOwnershipStartRejected({ reason: "intent_unavailable" });
  }
  if (replay.kind === "in_flight") {
    return yield* new RouteAttachmentOwnershipStartRejected({
      reason: "in_flight",
      retry_after_seconds: replay.retry_after_seconds,
    });
  }

  const resolveInput = {
    actor_id: input.actor_id,
    community_id: input.community_id,
    attachment_intent_id: input.attachment_intent_id,
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
    return yield* new RouteAttachmentOwnershipStartRejected({ reason: "intent_unavailable" });
  }
  const provider = yield* services.registry
    .resolve("hns")
    .pipe(
      Effect.mapError(() => new RouteAttachmentOwnershipStartRejected({ reason: "unsupported" })),
    );
  if (
    provider.manifest.provider_id !== authority.provider_id ||
    provider.startRouteAttachment === undefined ||
    provider.manifest.protocol_versions.length !== 1 ||
    !provider.manifest.environments.includes(services.environment)
  ) {
    return yield* new RouteAttachmentOwnershipStartRejected({ reason: "unsupported" });
  }
  const protocolVersion = provider.manifest.protocol_versions[0];
  const reservationTtlMs =
    provider.manifest.operation_deadlines.plan_ms +
    provider.manifest.operation_deadlines.start_ms +
    START_RESERVATION_MARGIN_MS;
  if (protocolVersion === undefined || !Number.isSafeInteger(reservationTtlMs)) {
    return yield* new RouteAttachmentOwnershipStartRejected({ reason: "unsupported" });
  }

  const hashInput = {
    operation_kind: "route_attachment" as const,
    actor_id: authority.actor_id,
    community_id: authority.community_id,
    attachment_intent_id: authority.attachment_intent_id,
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
    try: () => hnsRouteAttachmentStartHash(hashInput),
    catch: () => new RouteAttachmentOwnershipStartRejected({ reason: "invalid" }),
  });
  const startInput = {
    operation_kind: hashInput.operation_kind,
    actor_id: hashInput.actor_id,
    community_id: hashInput.community_id,
    attachment_intent_id: hashInput.attachment_intent_id,
    ceremony_intent_id: hashInput.ceremony_intent_id,
    requirement_hash: hashInput.requirement_hash,
    generation: hashInput.generation,
    request_hash,
    provider_binding_hash: hashInput.provider_binding_hash,
    provider_configuration: hashInput.provider_configuration,
    protocol_version: hashInput.protocol_version,
    environment: hashInput.environment,
    route: hashInput.route,
  } satisfies RouteAttachmentOwnershipProviderStartInput;
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
    const response = pendingResponse(
      reservationOutcome.namespace_session_id,
      reservationOutcome.start,
      true,
    );
    return response === null
      ? yield* new RouteAttachmentOwnershipStartRejected({ reason: "invalid" })
      : response;
  }
  if (reservationOutcome.kind === "in_flight") {
    return yield* new RouteAttachmentOwnershipStartRejected({
      reason: "in_flight",
      retry_after_seconds: reservationOutcome.retry_after_seconds,
    });
  }
  if (reservationOutcome.kind === "conflict") {
    return yield* new RouteAttachmentOwnershipStartRejected({ reason: "conflict" });
  }
  if (reservationOutcome.kind === "terminal") {
    if (reservationOutcome.status === "verified" && reservationOutcome.result_hash !== undefined) {
      return verifiedResponse(authority, reservationOutcome.result_hash);
    }
    return yield* new RouteAttachmentOwnershipStartRejected({ reason: "terminal" });
  }

  const reservation = reservationOutcome.reservation;
  const release = () =>
    services.store.release(reservation).pipe(Effect.catch(() => Effect.succeed(undefined)));
  const revalidated = yield* services.intents.resolve(resolveInput).pipe(Effect.tapError(release));
  if (
    revalidated === null ||
    revalidated.route.family !== "hns" ||
    revalidated.route.app_host !== null ||
    !sameAuthority(authority, revalidated)
  ) {
    yield* release();
    return yield* new RouteAttachmentOwnershipStartRejected({ reason: "intent_unavailable" });
  }

  const planned = yield* provider
    .plan({ route: authority.route, environment: services.environment })
    .pipe(Effect.tapError(release));
  if (
    planned.status === "unsupported" ||
    planned.protocol_version !== protocolVersion ||
    planned.provider_configuration.kind !== authority.provider_configuration.kind ||
    planned.provider_configuration.reference !== authority.provider_configuration.reference ||
    planned.provider_configuration.version !== authority.provider_configuration.version
  ) {
    yield* release();
    return yield* new RouteAttachmentOwnershipStartRejected({ reason: "unsupported" });
  }

  const started = yield* provider
    .startRouteAttachment(startInput, {
      namespace_session_id: reservation.namespace_session_id,
    })
    .pipe(Effect.tapError(release));
  const finalized = yield* services.store.finalize(reservation, started);
  if (finalized.kind === "conflict") {
    return yield* new RouteAttachmentOwnershipStartRejected({ reason: "conflict" });
  }
  if (finalized.kind === "stale") {
    return yield* new RouteAttachmentOwnershipStartRejected({
      reason: "in_flight",
      retry_after_seconds: 1,
    });
  }
  const response = pendingResponse(
    finalized.namespace_session_id,
    finalized.start,
    finalized.kind === "replay",
  );
  return response === null
    ? yield* new RouteAttachmentOwnershipStartRejected({ reason: "invalid" })
    : response;
});
