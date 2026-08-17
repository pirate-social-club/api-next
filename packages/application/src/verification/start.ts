import { Data, Effect, Option, Schema } from "effect";
import {
  type ProviderPresentation,
  type ProviderSessionStart,
  type VerificationProviderFailure,
  VerificationProviderPlanInput,
  type VerificationProviderStartInput,
} from "./adapter.ts";
import type {
  VerificationProviderRegistryService,
  VerificationProviderUnknown,
} from "./registry.ts";
import { computeVerificationRequestHash } from "./request-hash.ts";

export const StartVerificationInput = Schema.Struct({
  actor_id: Schema.NonEmptyString,
  intent_id: Schema.NonEmptyString,
  provider_id: Schema.NonEmptyString,
});
export type StartVerificationInput = Schema.Schema.Type<typeof StartVerificationInput>;

export interface VerificationIntentResolver {
  readonly resolve: (
    input: StartVerificationInput,
  ) => Effect.Effect<unknown, VerificationStartStorageFailed>;
}

export type VerificationSessionStartReservation = Readonly<{
  readonly reservation_id: string;
  readonly fence_token: number;
  readonly lease_expires_at: string;
}>;

export type VerificationSessionStartReservationOutcome =
  | { readonly kind: "acquired"; readonly reservation: VerificationSessionStartReservation }
  | { readonly kind: "replay"; readonly start: ProviderSessionStart }
  | { readonly kind: "in_flight"; readonly retry_after_seconds: number }
  | { readonly kind: "conflict" }
  | {
      readonly kind: "terminal";
      readonly status: "completed" | "failed" | "expired";
      readonly start: ProviderSessionStart;
    };

export type VerificationSessionStartFinalizeOutcome =
  | { readonly kind: "created" | "replay"; readonly start: ProviderSessionStart }
  | { readonly kind: "conflict" }
  | { readonly kind: "stale" };

export type VerificationSessionStartReservationInput = Readonly<{
  readonly start: VerificationProviderStartInput;
  /** Lease is start deadline plus a small finalization margin. */
  readonly ttl_ms: number;
}>;

export interface VerificationSessionStartStore {
  /** Reserve one actor/intent before any provider side effect. */
  readonly reserve: (
    input: VerificationSessionStartReservationInput,
  ) => Effect.Effect<VerificationSessionStartReservationOutcome, VerificationStartStorageFailed>;
  /** Persist the provider result with a lease and monotonic fence check. */
  readonly finalize: (
    reservation: VerificationSessionStartReservation,
    start: ProviderSessionStart,
  ) => Effect.Effect<VerificationSessionStartFinalizeOutcome, VerificationStartStorageFailed>;
  /** Release a failed provider attempt without releasing another owner. */
  readonly release: (
    reservation: VerificationSessionStartReservation,
  ) => Effect.Effect<void, VerificationStartStorageFailed>;
}

export interface StartVerificationServices {
  readonly intents: VerificationIntentResolver;
  readonly registry: VerificationProviderRegistryService;
  readonly store: VerificationSessionStartStore;
}

export type StartVerificationResult =
  | {
      readonly proof_session_id: string;
      readonly provider_id: string;
      readonly presentation: ProviderPresentation;
      readonly expires_at: string;
      readonly replayed: boolean;
    }
  | {
      readonly proof_session_id: string;
      readonly provider_id: string;
      readonly status: "completed";
      readonly replayed: true;
    };

export class VerificationStartRejected extends Data.TaggedError("VerificationStartRejected")<{
  readonly reason:
    | "invalid"
    | "intent_unavailable"
    | "unsupported"
    | "indeterminate"
    | "conflict"
    | "in_flight"
    | "terminal";
  readonly retry_after_seconds?: number;
}> {}

export class VerificationStartStorageFailed extends Data.TaggedError(
  "VerificationStartStorageFailed",
) {}

export type StartVerificationFailure =
  | VerificationStartRejected
  | VerificationStartStorageFailed
  | VerificationProviderFailure
  | VerificationProviderUnknown;

const START_RESERVATION_MARGIN_MS = 1_000;

function decodeInput(
  input: unknown,
): Effect.Effect<StartVerificationInput, VerificationStartRejected> {
  const decoded = Schema.decodeUnknownOption(StartVerificationInput)(input);
  if (
    Option.isNone(decoded) ||
    decoded.value.actor_id.trim() !== decoded.value.actor_id ||
    decoded.value.intent_id.trim() !== decoded.value.intent_id ||
    decoded.value.provider_id.trim() !== decoded.value.provider_id
  ) {
    return Effect.fail(new VerificationStartRejected({ reason: "invalid" }));
  }
  return Effect.succeed(decoded.value);
}

function decodeIntent(input: unknown) {
  const decoded = Schema.decodeUnknownOption(VerificationProviderPlanInput)(input);
  return Option.isNone(decoded)
    ? Effect.fail(new VerificationStartRejected({ reason: "intent_unavailable" }))
    : Effect.succeed(decoded.value);
}

/**
 * Start one provider-neutral ceremony from a server-resolved intent. The
 * actor and canonical requirements never come from provider callback data.
 */
export const startVerification = Effect.fn("startVerification")(function* (
  untrustedInput: unknown,
  services: StartVerificationServices,
): Effect.fn.Return<StartVerificationResult, StartVerificationFailure> {
  const input = yield* decodeInput(untrustedInput);
  const provider = yield* services.registry.resolve(input.provider_id);
  const planInput = yield* services.intents.resolve(input).pipe(Effect.flatMap(decodeIntent));
  const plan = yield* provider.plan(planInput);
  if (plan.status === "unsupported") {
    return yield* new VerificationStartRejected({ reason: "unsupported" });
  }
  if (plan.status === "unknown") {
    return yield* new VerificationStartRejected({ reason: "indeterminate" });
  }

  const hashInput = {
    actor_id: input.actor_id,
    intent_id: input.intent_id,
    ...planInput,
    request_mode: plan.request_mode,
    provider_configuration: plan.provider_configuration,
  } satisfies Omit<VerificationProviderStartInput, "request_hash">;
  const request_hash = yield* Effect.tryPromise({
    try: () => computeVerificationRequestHash(input.provider_id, hashInput),
    catch: () => new VerificationStartRejected({ reason: "invalid" }),
  });
  const startInput = { ...hashInput, request_hash } satisfies VerificationProviderStartInput;
  const reservationOutcome = yield* services.store.reserve({
    start: startInput,
    ttl_ms: provider.manifest.operation_deadlines.start_ms + START_RESERVATION_MARGIN_MS,
  });
  if (reservationOutcome.kind === "replay") {
    return {
      proof_session_id: reservationOutcome.start.session.id,
      provider_id: reservationOutcome.start.session.provider_id,
      presentation: reservationOutcome.start.presentation,
      expires_at: reservationOutcome.start.session.expires_at,
      replayed: true,
    };
  }
  if (reservationOutcome.kind === "in_flight") {
    return yield* new VerificationStartRejected({
      reason: "in_flight",
      retry_after_seconds: reservationOutcome.retry_after_seconds,
    });
  }
  if (reservationOutcome.kind === "terminal") {
    if (reservationOutcome.status === "completed") {
      return {
        proof_session_id: reservationOutcome.start.session.id,
        provider_id: reservationOutcome.start.session.provider_id,
        status: "completed",
        replayed: true,
      };
    }
    return yield* new VerificationStartRejected({ reason: "terminal" });
  }
  if (reservationOutcome.kind === "conflict") {
    return yield* new VerificationStartRejected({ reason: "conflict" });
  }

  const reservation = reservationOutcome.reservation;
  const started = yield* provider
    .start(startInput)
    .pipe(
      Effect.tapError(() =>
        services.store.release(reservation).pipe(Effect.catch(() => Effect.succeed(undefined))),
      ),
    );
  const committed = yield* services.store.finalize(reservation, started);
  if (committed.kind === "conflict") {
    return yield* new VerificationStartRejected({ reason: "conflict" });
  }
  if (committed.kind === "stale") {
    return yield* new VerificationStartRejected({ reason: "in_flight", retry_after_seconds: 1 });
  }
  return {
    proof_session_id: committed.start.session.id,
    provider_id: committed.start.session.provider_id,
    presentation: committed.start.presentation,
    expires_at: committed.start.session.expires_at,
    replayed: committed.kind === "replay",
  };
});
