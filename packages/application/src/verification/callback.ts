import { Data, Effect, Option, Schema } from "effect";
import {
  VerificationCallbackHeaders,
  VerificationCallbackRawBody,
  type VerificationProviderFailure,
} from "./adapter.ts";
import {
  type CompleteVerificationResult,
  completeVerification,
  type VerificationCompletionFailure,
  type VerificationCompletionServices,
} from "./completion.ts";
import type { VerificationProviderUnknown } from "./registry.ts";

export const HandleVerificationCallbackInput = Schema.Struct({
  provider_id: Schema.NonEmptyString,
  raw_body: VerificationCallbackRawBody,
  headers: VerificationCallbackHeaders,
});
export type HandleVerificationCallbackInput = Schema.Schema.Type<
  typeof HandleVerificationCallbackInput
>;

export type VerificationCallbackServices = VerificationCompletionServices;

export class VerificationCallbackRejected extends Data.TaggedError("VerificationCallbackRejected")<{
  readonly reason: "invalid" | "unsupported" | "unavailable";
}> {}

export type VerificationCallbackFailure =
  | VerificationCallbackRejected
  | VerificationCompletionFailure
  | VerificationProviderFailure
  | VerificationProviderUnknown;

function decodeInput(
  input: unknown,
): Effect.Effect<HandleVerificationCallbackInput, VerificationCallbackRejected> {
  const decoded = Schema.decodeUnknownOption(HandleVerificationCallbackInput)(input);
  if (
    Option.isNone(decoded) ||
    decoded.value.provider_id.trim() !== decoded.value.provider_id ||
    Object.keys(decoded.value.headers).some((name) => name !== name.toLowerCase())
  ) {
    return Effect.fail(new VerificationCallbackRejected({ reason: "invalid" }));
  }
  return Effect.succeed(decoded.value);
}

/**
 * Authenticate a provider callback before resolving local session identity,
 * then delegate to the same idempotent transactional completion path used by
 * authenticated client-result ceremonies.
 */
export const handleVerificationCallback = Effect.fn("handleVerificationCallback")(function* (
  untrustedInput: unknown,
  services: VerificationCallbackServices,
): Effect.fn.Return<CompleteVerificationResult, VerificationCallbackFailure> {
  const input = yield* decodeInput(untrustedInput);
  const provider = yield* services.registry.resolve(input.provider_id);
  if (provider.verifyCallback === undefined) {
    return yield* new VerificationCallbackRejected({ reason: "unsupported" });
  }

  const callback = yield* provider.verifyCallback({
    raw_body: input.raw_body,
    headers: input.headers,
  });
  const stored = yield* services.store.load({ proof_session_id: callback.proof_session_id });
  if (stored === null || stored.session.provider_id !== input.provider_id) {
    return yield* new VerificationCallbackRejected({ reason: "unavailable" });
  }

  return yield* completeVerification(
    {
      actor_id: stored.session.actor_id,
      proof_session_id: stored.session.id,
      idempotency_key: callback.idempotency_key,
      submission: callback.submission,
    },
    services,
  );
});
