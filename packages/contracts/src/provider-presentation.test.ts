import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  PROVIDER_PRESENTATION_PAYLOAD_MAX_BYTES,
  PROVIDER_PRESENTATION_PROTOCOL_MAX_BYTES,
  PROVIDER_PRESENTATION_SESSION_ID_MAX_BYTES,
  PROVIDER_PRESENTATION_URL_MAX_BYTES,
  PROVIDER_PRESENTATION_VERSION_MAX_BYTES,
  ProviderPresentation,
} from "./provider-presentation.ts";

const accepts = Schema.is(ProviderPresentation);

describe("provider presentation contract", () => {
  test("bounds every public string field by UTF-8 bytes", () => {
    const sessionId = "s".repeat(PROVIDER_PRESENTATION_SESSION_ID_MAX_BYTES);
    const url = "u".repeat(PROVIDER_PRESENTATION_URL_MAX_BYTES);
    const protocol = "p".repeat(PROVIDER_PRESENTATION_PROTOCOL_MAX_BYTES);
    const version = "v".repeat(PROVIDER_PRESENTATION_VERSION_MAX_BYTES);

    expect(accepts({ kind: "redirect", session_id: sessionId, url })).toBeTrue();
    expect(accepts({ kind: "deeplink", session_id: sessionId, uri: url })).toBeTrue();
    expect(accepts({ kind: "poll", session_id: sessionId, poll_url: url })).toBeTrue();
    expect(
      accepts({ kind: "embedded_sdk", session_id: sessionId, protocol, version, payload: {} }),
    ).toBeTrue();
    expect(accepts({ kind: "none", session_id: sessionId })).toBeTrue();

    expect(
      accepts({
        kind: "redirect",
        session_id: "🚀".repeat(PROVIDER_PRESENTATION_SESSION_ID_MAX_BYTES / 2),
        url: "/verification",
      }),
    ).toBeFalse();
    expect(
      accepts({
        kind: "deeplink",
        session_id: "session",
        uri: "u".repeat(PROVIDER_PRESENTATION_URL_MAX_BYTES + 1),
      }),
    ).toBeFalse();
    expect(
      accepts({
        kind: "embedded_sdk",
        session_id: "session",
        protocol: "p".repeat(PROVIDER_PRESENTATION_PROTOCOL_MAX_BYTES + 1),
        version,
        payload: {},
      }),
    ).toBeFalse();
    expect(
      accepts({
        kind: "embedded_sdk",
        session_id: "session",
        protocol,
        version: "v".repeat(PROVIDER_PRESENTATION_VERSION_MAX_BYTES + 1),
        payload: {},
      }),
    ).toBeFalse();
  });

  test("accepts a bounded JSON object and rejects oversized or scalar payloads", () => {
    const envelopeBytes = new TextEncoder().encode(JSON.stringify({ value: "" })).length;
    const exactPayload = {
      value: "x".repeat(PROVIDER_PRESENTATION_PAYLOAD_MAX_BYTES - envelopeBytes),
    };
    const oversizedUnicodePayload = {
      value: "🚀".repeat(Math.ceil(PROVIDER_PRESENTATION_PAYLOAD_MAX_BYTES / 4)),
    };
    const base = {
      kind: "embedded_sdk" as const,
      session_id: "session",
      protocol: "provider.v1",
      version: "1",
    };

    expect(accepts({ ...base, payload: exactPayload })).toBeTrue();
    expect(
      accepts({ ...base, payload: { ...exactPayload, value: `${exactPayload.value}x` } }),
    ).toBe(false);
    expect(accepts({ ...base, payload: oversizedUnicodePayload })).toBeFalse();
    expect(accepts({ ...base, payload: "opaque" })).toBeFalse();
    expect(accepts({ ...base, payload: [] })).toBeFalse();
  });
});
