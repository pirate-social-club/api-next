import { Predicate, Schema } from "effect";

export const PROVIDER_PRESENTATION_SESSION_ID_MAX_BYTES = 512 as const;
export const PROVIDER_PRESENTATION_PROTOCOL_MAX_BYTES = 256 as const;
export const PROVIDER_PRESENTATION_VERSION_MAX_BYTES = 256 as const;
export const PROVIDER_PRESENTATION_URL_MAX_BYTES = 16_384 as const;
export const PROVIDER_PRESENTATION_PAYLOAD_MAX_BYTES = 1_048_576 as const;

function boundedNonEmptyString(maxBytes: number, label: string) {
  return Schema.NonEmptyString.check(
    Schema.makeFilter((value) =>
      new TextEncoder().encode(value).length <= maxBytes
        ? undefined
        : `Expected ${label} no larger than ${maxBytes} UTF-8 bytes`,
    ),
  );
}

const ProviderPresentationSessionId = boundedNonEmptyString(
  PROVIDER_PRESENTATION_SESSION_ID_MAX_BYTES,
  "a provider presentation session id",
);
const ProviderPresentationProtocol = boundedNonEmptyString(
  PROVIDER_PRESENTATION_PROTOCOL_MAX_BYTES,
  "a provider presentation protocol",
);
const ProviderPresentationVersion = boundedNonEmptyString(
  PROVIDER_PRESENTATION_VERSION_MAX_BYTES,
  "a provider presentation version",
);
const ProviderPresentationUrl = boundedNonEmptyString(
  PROVIDER_PRESENTATION_URL_MAX_BYTES,
  "a provider presentation URL",
);
const ProviderPresentationPayload = Schema.Json.check(
  Schema.makeFilter((value) =>
    Predicate.isObject(value) &&
    !Array.isArray(value) &&
    new TextEncoder().encode(JSON.stringify(value)).length <=
      PROVIDER_PRESENTATION_PAYLOAD_MAX_BYTES
      ? undefined
      : "Expected a provider presentation object no larger than 1 MiB",
  ),
);

/** Canonical client-facing provider launch shape shared by contracts and application. */
export const ProviderPresentation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("redirect"),
    session_id: ProviderPresentationSessionId,
    url: ProviderPresentationUrl,
  }),
  Schema.Struct({
    kind: Schema.Literal("deeplink"),
    session_id: ProviderPresentationSessionId,
    uri: ProviderPresentationUrl,
  }),
  Schema.Struct({
    kind: Schema.Literal("embedded_sdk"),
    session_id: ProviderPresentationSessionId,
    protocol: ProviderPresentationProtocol,
    version: ProviderPresentationVersion,
    payload: ProviderPresentationPayload,
  }),
  Schema.Struct({
    kind: Schema.Literal("poll"),
    session_id: ProviderPresentationSessionId,
    poll_url: ProviderPresentationUrl,
  }),
  Schema.Struct({ kind: Schema.Literal("none"), session_id: ProviderPresentationSessionId }),
]);
export type ProviderPresentation = Schema.Schema.Type<typeof ProviderPresentation>;
