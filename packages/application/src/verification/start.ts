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

export type VerificationSessionStartCommitOutcome =
  | { readonly kind: "created" | "replay"; readonly start: ProviderSessionStart }
  | { readonly kind: "conflict" };

export interface VerificationSessionStartStore {
  /** Persist the validated pending session and its presentation in one local transaction. */
  readonly commit: (
    start: ProviderSessionStart,
  ) => Effect.Effect<VerificationSessionStartCommitOutcome, VerificationStartStorageFailed>;
}

export interface StartVerificationServices {
  readonly intents: VerificationIntentResolver;
  readonly registry: VerificationProviderRegistryService;
  readonly store: VerificationSessionStartStore;
}

export interface StartVerificationResult {
  readonly proof_session_id: string;
  readonly provider_id: string;
  readonly presentation: ProviderPresentation;
  readonly expires_at: string;
  readonly replayed: boolean;
}

export class VerificationStartRejected extends Data.TaggedError("VerificationStartRejected")<{
  readonly reason: "invalid" | "intent_unavailable" | "unsupported" | "indeterminate" | "conflict";
}> {}

export class VerificationStartStorageFailed extends Data.TaggedError(
  "VerificationStartStorageFailed",
) {}

export type StartVerificationFailure =
  | VerificationStartRejected
  | VerificationStartStorageFailed
  | VerificationProviderFailure
  | VerificationProviderUnknown;

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
  const started = yield* provider.start({ ...hashInput, request_hash });
  const committed = yield* services.store.commit(started);
  if (committed.kind === "conflict") {
    return yield* new VerificationStartRejected({ reason: "conflict" });
  }
  return {
    proof_session_id: committed.start.session.id,
    provider_id: committed.start.session.provider_id,
    presentation: committed.start.presentation,
    expires_at: committed.start.session.expires_at,
    replayed: committed.kind === "replay",
  };
});
