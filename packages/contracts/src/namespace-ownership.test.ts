import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { NamespaceUnavailable } from "./errors.ts";
import {
  HnsNamespaceStartRequestV1,
  HnsNamespaceStartResponseV1,
  HnsPollResultCompletionRequestV1,
  HnsPollResultCompletionResponseV1,
  PollNamespaceOwnership,
  StartNamespaceOwnership,
} from "./namespace-ownership.ts";

const startRequest = {
  ceremony_intent_id: "ceremony-1",
  expected_revision: 1,
  idempotency_key: "start-1",
};

const pollRequest = {
  ceremony_intent_id: "ceremony-1",
  session_id: "session-1",
  expected_revision: 1,
  idempotency_key: "poll-1",
  channel: "poll_result" as const,
};

const exactOptions = { onExcessProperty: "error" } as const;

describe("namespace ownership endpoint contracts", () => {
  test("ratifies paths, auth, statuses, media encoding, and byte caps", () => {
    expect(StartNamespaceOwnership.path).toBe(
      "/community-creation-intents/:intentId/namespace-ownership/start",
    );
    expect(StartNamespaceOwnership.auth.policy).toEqual({ kind: "userOrAdmin" });
    expect(StartNamespaceOwnership.successStatus).toEqual([200, 201]);
    expect(StartNamespaceOwnership.request?.bodyEncoding).toBe("exact-json");
    expect(StartNamespaceOwnership.request?.maxBodyBytes).toBe(2_048);
    expect(PollNamespaceOwnership.path).toBe(
      "/community-creation-intents/:intentId/namespace-ownership/poll",
    );
    expect(PollNamespaceOwnership.successStatus).toEqual([200, 202, 422, 503]);
    expect(PollNamespaceOwnership.request?.maxBodyBytes).toBe(4_096);
    expect(PollNamespaceOwnership.errors).not.toContain(NamespaceUnavailable);
  });

  test("decodes only the exact schema-order request representation", () => {
    const decoded = Schema.decodeUnknownSync(
      HnsNamespaceStartRequestV1,
      exactOptions,
    )(startRequest);
    expect(JSON.stringify(decoded)).toBe(
      '{"ceremony_intent_id":"ceremony-1","expected_revision":1,"idempotency_key":"start-1"}',
    );
    expect(() =>
      Schema.decodeUnknownSync(
        HnsNamespaceStartRequestV1,
        exactOptions,
      )({
        ...startRequest,
        extra: true,
      }),
    ).toThrow();
  });

  test("keeps the response shapes closed and cross-field coherent", () => {
    expect(
      Schema.is(HnsNamespaceStartResponseV1)({
        creation_intent_id: "intent-1",
        ceremony_intent_id: "ceremony-1",
        generation: 1,
        session_id: "session-1",
        channel: "poll_result",
        status: "pending",
        expires_at: "2026-08-21T00:00:00.000Z",
        replayed: false,
      }),
    ).toBe(true);
    expect(() =>
      Schema.decodeUnknownSync(
        HnsPollResultCompletionRequestV1,
        exactOptions,
      )({
        ...pollRequest,
        payload: {},
      }),
    ).toThrow();
    expect(
      Schema.is(HnsPollResultCompletionResponseV1)({
        ceremony_intent_id: "ceremony-1",
        session_id: "session-1",
        revision: 1,
        status: "pending",
        replayed: false,
        result_hash: null,
        retry_after_seconds: 5,
      }),
    ).toBe(true);
    expect(
      Schema.is(HnsPollResultCompletionResponseV1)({
        ceremony_intent_id: "ceremony-1",
        session_id: "session-1",
        revision: 1,
        status: "pending",
        replayed: false,
        result_hash: "a".repeat(64),
        retry_after_seconds: null,
      }),
    ).toBe(false);
  });
});
