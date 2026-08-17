import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import {
  AuthError,
  BadRequest,
  Conflict,
  InternalError,
  NotFound,
  ProviderMisconfigured,
  ProviderUnavailable,
  VerificationStartInProgress,
  VerificationStartNewIntentRequired,
} from "./errors.ts";

const ProviderPresentation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("redirect"),
    session_id: Schema.NonEmptyString,
    url: Schema.NonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("deeplink"),
    session_id: Schema.NonEmptyString,
    uri: Schema.NonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("embedded_sdk"),
    session_id: Schema.NonEmptyString,
    protocol: Schema.NonEmptyString,
    version: Schema.NonEmptyString,
    payload: Schema.Json,
  }),
  Schema.Struct({
    kind: Schema.Literal("poll"),
    session_id: Schema.NonEmptyString,
    poll_url: Schema.NonEmptyString,
  }),
  Schema.Struct({ kind: Schema.Literal("none"), session_id: Schema.NonEmptyString }),
]);

const VerificationCompletionResponse = Schema.Struct({
  proof_session_id: Schema.NonEmptyString,
  status: Schema.Literal("completed"),
  replayed: Schema.Boolean,
});

const VerificationStartResponse = Schema.Union([
  Schema.Struct({
    proof_session_id: Schema.NonEmptyString,
    provider_id: Schema.NonEmptyString,
    presentation: ProviderPresentation,
    expires_at: Schema.NonEmptyString,
    replayed: Schema.Boolean,
  }),
  Schema.Struct({
    proof_session_id: Schema.NonEmptyString,
    provider_id: Schema.NonEmptyString,
    status: Schema.Literal("completed"),
    replayed: Schema.Literal(true),
  }),
]);

const CallbackRawBody = Schema.String.check(
  Schema.makeFilter((value) =>
    value.length > 0 && value.length <= 1_048_576
      ? undefined
      : "Expected a non-empty callback body no larger than 1 MiB",
  ),
);

const CallbackHeaders = Schema.Record(Schema.String, Schema.String).check(
  Schema.makeFilter((headers) => {
    const entries = Object.entries(headers);
    return entries.length <= 64 &&
      entries.every(
        ([name, value]) =>
          name.length > 0 &&
          name.length <= 128 &&
          /^[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(name) &&
          value.length <= 8_192,
      ) &&
      entries.reduce((length, [name, value]) => length + name.length + value.length, 0) <= 32_768
      ? undefined
      : "Expected a bounded canonical callback header map";
  }),
);

export const StartVerificationSession = endpoint({
  method: "POST",
  path: "/verification/sessions",
  auth: Auth.userOrAdmin(),
  request: {
    body: Schema.Struct({
      intent_id: Schema.NonEmptyString,
      provider_id: Schema.NonEmptyString,
    }),
  },
  response: VerificationStartResponse,
  successStatus: [200, 201],
  errors: [
    AuthError,
    BadRequest,
    Conflict,
    VerificationStartInProgress,
    VerificationStartNewIntentRequired,
    NotFound,
    ProviderUnavailable,
    ProviderMisconfigured,
    InternalError,
  ],
});

export const CompleteVerificationSession = endpoint({
  method: "POST",
  path: "/verification/sessions/:proofSessionId/complete",
  auth: Auth.userOrAdmin(),
  request: {
    path: Schema.Struct({ proofSessionId: Schema.NonEmptyString }),
    body: Schema.Struct({
      idempotency_key: Schema.NonEmptyString,
      payload: Schema.Json,
    }),
  },
  response: VerificationCompletionResponse,
  successStatus: 200,
  errors: [
    AuthError,
    BadRequest,
    Conflict,
    NotFound,
    ProviderUnavailable,
    ProviderMisconfigured,
    InternalError,
  ],
});

/**
 * Public provider callbacks use manifest-declared trust. Signed envelopes are
 * authenticated before lookup; session-bound proofs carry only an opaque ID
 * until completion verifies them against stored requirements. The transport
 * preserves exact body text and passes a bounded lowercase header map; neither
 * actor nor session authority is accepted from an app client.
 * `providerId` remains intentionally open-coded: unknown providers receive a
 * redacted 404 rather than being enumerated by a fixed contract enum.
 */
export const CompleteVerificationCallback = endpoint({
  method: "POST",
  path: "/verification/callbacks/:providerId",
  auth: Auth.public(),
  request: {
    path: Schema.Struct({ providerId: Schema.NonEmptyString }),
    headers: CallbackHeaders,
    body: CallbackRawBody,
    bodyEncoding: "raw-text",
  },
  response: VerificationCompletionResponse,
  successStatus: 200,
  errors: [
    BadRequest,
    Conflict,
    NotFound,
    ProviderUnavailable,
    ProviderMisconfigured,
    InternalError,
  ],
});
