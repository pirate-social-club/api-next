import { Schema } from "effect";

/** Canonical client-facing provider launch shape shared by contracts and application. */
export const ProviderPresentation = Schema.Union([
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
export type ProviderPresentation = Schema.Schema.Type<typeof ProviderPresentation>;
