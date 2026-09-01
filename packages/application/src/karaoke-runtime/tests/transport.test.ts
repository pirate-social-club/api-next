import { describe, expect, test } from "bun:test";
import {
  KARAOKE_TRANSPORT_PROTOCOL_VERSION,
  type KaraokeServerEvent,
  validateKaraokeClientEventPayload,
  validateKaraokeStreamingSttEventPayload,
} from "../transport";

const envelope = {
  attemptId: "attempt-1",
  protocolVersion: KARAOKE_TRANSPORT_PROTOCOL_VERSION,
  sequence: 0,
  sessionId: "session-1",
};

describe("karaoke transport payload validation", () => {
  test("keeps provider retention correction additive in protocol v1", () => {
    const event: KaraokeServerEvent = {
      ...envelope,
      eventId: "karaoke_event_1",
      provider_retention: "stored",
      type: "provider_retention_changed",
    };

    expect(event).toMatchObject({
      protocolVersion: 1,
      provider_retention: "stored",
      type: "provider_retention_changed",
    });
  });

  test("accepts complete client and STT events", () => {
    expect(
      validateKaraokeClientEventPayload({
        ...envelope,
        audioTimeMs: 1000,
        lineId: "line-1",
        lineIndex: 0,
        scoredLineIndex: 0,
        type: "line_boundary",
      }),
    ).toBeNull();
    expect(
      validateKaraokeStreamingSttEventPayload({
        ...envelope,
        deliveredAtAudioMs: 1000,
        text: "hold",
        type: "stt_final",
        words: [{ endMs: 900, startMs: 500, text: "hold" }],
      }),
    ).toBeNull();
  });

  test("rejects malformed event-specific payloads", () => {
    expect(validateKaraokeClientEventPayload({ ...envelope, type: "line_boundary" })?.code).toBe(
      "invalid_event_payload",
    );
    expect(
      validateKaraokeStreamingSttEventPayload({
        ...envelope,
        deliveredAtAudioMs: 1000,
        text: "hold",
        type: "stt_final",
        words: [{ endMs: 400, startMs: 500, text: "hold" }],
      })?.code,
    ).toBe("invalid_event_payload");
  });
});
