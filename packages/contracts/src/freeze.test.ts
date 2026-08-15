import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import {
  Auth,
  DecimalStringSchema,
  NotFound,
  PaymentRequired,
  RateLimited,
  RetryableConflict,
  toErrorBody,
} from "./index.ts";

// Phase-0 acceptance: the frozen catalogs behave as the old wire surface did.

describe("wire-error catalog", () => {
  it("preserves old code/status/retryability semantics", () => {
    expect(toErrorBody(new NotFound({ message: "nope" })).body).toEqual({
      code: "not_found",
      message: "nope",
      retryable: false,
    });
    // payment_required is retryable in the old API — ported as-is.
    expect(toErrorBody(new PaymentRequired({ message: "pay" })).body.retryable).toBe(true);
    expect(toErrorBody(new RateLimited({ message: "slow" })).body.retryable).toBe(true);
    expect(toErrorBody(new RetryableConflict({ message: "again" })).body).toMatchObject({
      code: "conflict",
      retryable: true,
      message: "again",
    });
  });

  it("redacts unknown failures and reports request ids", () => {
    const leaked = new Error("postgres://user:pass@host/db failed");
    const { status, body } = toErrorBody(leaked, "req_123");
    expect(status).toBe(500);
    expect(body).toEqual({
      code: "internal_error",
      message: "Internal server error",
      retryable: true,
      request_id: "req_123",
    });
  });

  it("carries details only when present", () => {
    expect(toErrorBody(new NotFound({ message: "x" })).body.details).toBeUndefined();
    expect(toErrorBody(new NotFound({ message: "x", details: { id: 7 } })).body.details).toEqual({
      id: 7,
    });
  });
});

describe("branded money types", () => {
  it("accepts integer smallest units", () => {
    expect(Schema.is(DecimalStringSchema)("12.345678")).toBe(true);
    expect(Schema.is(DecimalStringSchema)("1.5.2")).toBe(false);
    expect(Schema.is(DecimalStringSchema)("nan")).toBe(false);
  });
});

describe("auth policy vocabulary", () => {
  it("declares policies as values", () => {
    expect(Auth.userOrAdmin({ altcha: "vote" })).toEqual({
      policy: { kind: "userOrAdmin" },
      altcha: "vote",
    });
    expect(Auth.sharedSecret("telegram")).toEqual({
      policy: { kind: "sharedSecret", name: "telegram" },
    });
  });
});
