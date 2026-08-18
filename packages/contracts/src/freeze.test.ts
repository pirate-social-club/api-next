import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import {
  Auth,
  DecimalStringSchema,
  GateFailed,
  GetCommunityPreview,
  NotFound,
  PaymentRequired,
  ProviderMisconfigured,
  ProviderUnavailable,
  RateLimited,
  RetryableConflict,
  toErrorBody,
  VerificationStartInProgress,
  VerificationStartNewIntentRequired,
} from "./index.ts";

// The coordinator-owned clean-break catalog defines the api-next v2 wire surface.

describe("wire-error catalog", () => {
  it("preserves the selected code/status/retryability decisions", () => {
    expect(toErrorBody(new NotFound({ message: "nope" })).body).toEqual({
      error: { code: "not_found", message: "nope", retryable: false },
    });
    // payment_required is explicitly retryable in api-next v2.
    expect(toErrorBody(new PaymentRequired({ message: "pay" })).body.error.retryable).toBe(true);
    expect(toErrorBody(new RateLimited({ message: "slow" })).body.error.retryable).toBe(true);
    expect(toErrorBody(new RetryableConflict({ message: "again" })).body).toMatchObject({
      error: { code: "conflict", retryable: true, message: "again" },
    });
  });

  it("redacts unknown failures and reports request ids", () => {
    const leaked = new Error("postgres://user:pass@host/db failed");
    const { status, body } = toErrorBody(leaked, "req_123");
    expect(status).toBe(500);
    expect(body).toEqual({
      error: { code: "internal_error", message: "Internal server error", retryable: true },
      request_id: "req_123",
    });
  });

  it("carries details only when present", () => {
    expect(toErrorBody(new NotFound({ message: "x" })).body.error.details).toBeUndefined();
    expect(
      toErrorBody(new NotFound({ message: "x", details: { id: 7 } })).body.error.details,
    ).toEqual({
      id: 7,
    });
  });

  it("serializes only the canonical retry header for an in-progress start", () => {
    const serialized = toErrorBody(
      new VerificationStartInProgress({ message: "busy", retry_after_seconds: 7 }),
    );
    expect(serialized.headers).toEqual({ "Retry-After": "7" });
    expect(serialized.body).toMatchObject({
      error: { code: "verification_start_in_progress", retryable: true },
    });
    expect(
      toErrorBody(new VerificationStartInProgress({ message: "bad", retry_after_seconds: 0 }))
        .headers,
    ).toBeUndefined();
    expect(
      toErrorBody(new VerificationStartNewIntentRequired({ message: "new intent" })).headers,
    ).toBeUndefined();
  });

  it("requires structured details for gate failures", () => {
    const error = new GateFailed({ message: "gate failed", details: { gate: "age" } });
    expect(toErrorBody(error).body.error.details).toEqual({ gate: "age" });
  });

  it("splits provider_unavailable retryability across two members", () => {
    // Regression: a `retryable` constructor prop on ProviderUnavailable was
    // clobbered by the class field initializer, silently forcing true. The
    // Terminal provider failures use ProviderMisconfigured; the v2 wire code
    // remains provider_unavailable while retryability is explicit by member.
    expect(toErrorBody(new ProviderUnavailable({ message: "upstream down" })).body).toMatchObject({
      error: { code: "provider_unavailable", retryable: true },
    });
    expect(
      toErrorBody(new ProviderMisconfigured({ message: "RPC URL is invalid" })).body,
    ).toMatchObject({ error: { code: "provider_unavailable", retryable: false } });
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
    expect(GetCommunityPreview.auth).toEqual({
      policy: { kind: "userOrAdmin" },
      optionalUser: true,
    });
  });
});
