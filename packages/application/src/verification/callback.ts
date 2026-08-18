import { Data, Effect, Option, Schema } from "effect";
import {
  VERIFICATION_CALLBACK_CREDENTIAL_HEADERS,
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

/**
 * Strip platform and deployment credentials before the HTTP handler hands a
 * callback to application code. The guarded registry repeats this filtering
 * before the provider adapter as defense in depth.
 */
export function stripVerificationCallbackCredentialHeaders(
  headers: Readonly<Record<string, string>>,
  additionalCredentialHeaders: readonly string[] = [],
): Readonly<Record<string, string>> {
  const denied = new Set(VERIFICATION_CALLBACK_CREDENTIAL_HEADERS);
  for (const name of additionalCredentialHeaders) denied.add(name.toLowerCase());
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !denied.has(name.toLowerCase())),
  );
}

export class VerificationCallbackRejected extends Data.TaggedError("VerificationCallbackRejected")<{
  readonly reason: "invalid" | "unsupported" | "unavailable";
}> {}

export type VerificationCallbackFailure =
  | VerificationCallbackRejected
  | VerificationCompletionFailure
  | VerificationProviderFailure
  | VerificationProviderUnknown;

export type VerificationCallbackResult =
  | CompleteVerificationResult
  | Schema.Schema.Type<typeof Schema.Json>;

function decodeInput(
  input: unknown,
): Effect.Effect<HandleVerificationCallbackInput, VerificationCallbackRejected> {
  const decoded = Schema.decodeUnknownOption(HandleVerificationCallbackInput)(
    normalizeCallbackInput(input),
  );
  if (Option.isNone(decoded) || decoded.value.provider_id.trim() !== decoded.value.provider_id) {
    return Effect.fail(new VerificationCallbackRejected({ reason: "invalid" }));
  }
  return Effect.succeed(decoded.value);
}

function normalizeCallbackInput(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const record = input as Readonly<Record<string, unknown>>;
  const rawHeaders = record.headers;
  if (typeof rawHeaders !== "object" || rawHeaders === null || Array.isArray(rawHeaders)) {
    return input;
  }
  const headers: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(rawHeaders)) {
    const normalized = name.toLowerCase();
    if (Object.hasOwn(headers, normalized)) return undefined;
    headers[normalized] = value;
  }
  return { ...record, headers };
}

/**
 * Resolve callback trust according to the provider manifest, then delegate to
 * the same idempotent transactional completion path used by authenticated
 * client-result ceremonies. Signed envelopes authenticate before lookup;
 * session-bound proofs only disclose an opaque session ID before completion.
 */
export const handleVerificationCallback = Effect.fn("handleVerificationCallback")(function* (
  untrustedInput: unknown,
  services: VerificationCallbackServices,
): Effect.fn.Return<VerificationCallbackResult, VerificationCallbackFailure> {
  const input = yield* decodeInput(untrustedInput);
  const provider = yield* services.registry.resolve(input.provider_id);
  const resolveCallback =
    provider.manifest.callback_mode === "signed_envelope"
      ? provider.verifyCallback
      : provider.manifest.callback_mode === "session_bound_proof"
        ? provider.resolveCallback
        : undefined;
  if (resolveCallback === undefined) {
    return yield* new VerificationCallbackRejected({ reason: "unsupported" });
  }

  // Signed envelopes authenticate before lookup. Session-bound proofs only
  // extract an opaque high-entropy ID here; completeVerification performs the
  // cryptographic verification after loading the stored session.
  const callback = yield* resolveCallback({
    raw_body: input.raw_body,
    headers: input.headers,
  });
  const stored = yield* services.store.load({ proof_session_id: callback.proof_session_id });
  if (stored === null || stored.session.provider_id !== input.provider_id) {
    return yield* new VerificationCallbackRejected({ reason: "unavailable" });
  }

  const acknowledgment = provider.callbackResponse;
  const completion = completeVerification(
    {
      actor_id: stored.session.actor_id,
      proof_session_id: stored.session.id,
      idempotency_key: callback.idempotency_key,
      submission: callback.submission,
    },
    services,
  );
  if (acknowledgment === undefined) return yield* completion;

  const response = (status: "verified" | "pending") =>
    acknowledgment({ session: stored.session, status });
  return yield* completion.pipe(
    Effect.flatMap(() => response("verified")),
    Effect.catchTag("VerificationProviderRejected", () => response("pending")),
    Effect.catchTag("VerificationProviderUnboundRejected", () => response("pending")),
  );
});
