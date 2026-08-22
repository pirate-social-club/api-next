import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  CastPostVote,
  ClearPostVote,
  Conflict,
  GateUnsatisfied,
  schemaToOpenApi,
  VerificationRequired,
} from "./index.ts";

const decode = (schema: Schema.ConstraintDecoder<unknown>, input: unknown) =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input);

describe("post vote contracts", () => {
  test("requires exact idempotent cast and clear bodies with no ALTCHA field", () => {
    const castBody = CastPostVote.request?.body as Schema.ConstraintDecoder<unknown>;
    const clearBody = ClearPostVote.request?.body as Schema.ConstraintDecoder<unknown>;
    expect(schemaToOpenApi(castBody).required).toEqual(["idempotency_key", "value"]);
    expect(schemaToOpenApi(clearBody).required).toEqual(["idempotency_key"]);
    expect(decode(castBody, { idempotency_key: "cast_1", value: -1 })).toEqual({
      idempotency_key: "cast_1",
      value: -1,
    });
    expect(decode(clearBody, { idempotency_key: "clear_1" })).toEqual({
      idempotency_key: "clear_1",
    });
    expect(() => decode(castBody, { idempotency_key: "cast_1", value: 1, altcha: "x" })).toThrow();
    expect(() => decode(clearBody, { idempotency_key: "clear_1", altcha: "x" })).toThrow();
  });

  test("uses ordinary user/admin auth and declares typed replay conflicts", () => {
    expect(CastPostVote.auth).toEqual({ policy: { kind: "userOrAdmin" } });
    expect(ClearPostVote.auth).toEqual({ policy: { kind: "userOrAdmin" } });
    for (const endpoint of [CastPostVote, ClearPostVote]) {
      expect(endpoint.errors).toContain(Conflict);
      expect(endpoint.errors).not.toContain(VerificationRequired);
      expect(endpoint.errors).not.toContain(GateUnsatisfied);
    }
  });

  test("returns post_id and the closed cast or clear value", () => {
    expect(
      Schema.decodeUnknownSync(CastPostVote.response)({ post_id: "post_1", value: 1 }),
    ).toEqual({
      post_id: "post_1",
      value: 1,
    });
    expect(
      Schema.decodeUnknownSync(ClearPostVote.response)({ post_id: "post_1", value: 0 }),
    ).toEqual({
      post_id: "post_1",
      value: 0,
    });
    expect(() =>
      Schema.decodeUnknownSync(ClearPostVote.response)({ post_id: "post_1", value: null }),
    ).toThrow();
  });
});
