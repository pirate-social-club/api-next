import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  TextContentSubmissionV1,
  TextModerationEvaluationV1,
  TextModerationEvaluationV2,
  TextModerationInputV1,
} from "./text-moderation.ts";

describe("text moderation contracts", () => {
  test("accepts only the frozen canonical input projection", () => {
    const decode = Schema.decodeUnknownSync(TextModerationInputV1);
    expect(
      decode({
        version: "text-moderation-input-v1",
        surface: "text_post",
        title: "Hello",
        body: "World\nAgain",
      }),
    ).toMatchObject({ title: "Hello", body: "World\nAgain" });
    for (const candidate of [
      {
        version: "text-moderation-input-v1",
        surface: "text_post",
        title: null,
        body: null,
      },
      {
        version: "text-moderation-input-v1",
        surface: "text_post",
        title: " padded ",
        body: null,
      },
      {
        version: "text-moderation-input-v1",
        surface: "text_post",
        title: "Cafe\u0301",
        body: null,
      },
      {
        version: "text-moderation-input-v1",
        surface: "image",
        title: "Hello",
        body: null,
      },
    ]) {
      expect(() => decode(candidate)).toThrow();
    }
  });

  test("enforces internal decision invariants", () => {
    const decode = Schema.decodeUnknownSync(TextModerationEvaluationV1);
    const base = {
      version: "text-moderation-v1",
      surface: "text_post",
      policy_revision: "text-policy-1",
      policy_hash: "a".repeat(64),
      input_sha256: "b".repeat(64),
      evidence_ref: null,
    };
    expect(decode({ ...base, decision: "allow", reason_codes: [] }).decision).toBe("allow");
    expect(decode({ ...base, decision: "blocked", reason_codes: ["sexual_minors"] }).decision).toBe(
      "blocked",
    );
    for (const candidate of [
      { ...base, decision: "allow", reason_codes: ["spam"] },
      { ...base, decision: "manual_review", reason_codes: [] },
      { ...base, decision: "manual_review", reason_codes: ["sexual_minors"] },
      { ...base, decision: "blocked", reason_codes: ["provider_timeout"] },
      { ...base, decision: "manual_review", reason_codes: ["spam", "spam"] },
      { ...base, decision: "manual_review", reason_codes: ["free_form"] },
    ]) {
      expect(() => decode(candidate)).toThrow();
    }
  });

  test("binds V2 evaluations to all three policy revisions", () => {
    const decode = Schema.decodeUnknownSync(TextModerationEvaluationV2);
    expect(
      decode({
        version: "text-moderation-v2",
        surface: "text_post",
        decision: "manual_review",
        reason_codes: ["harassment"],
        policy_revision: "provider-v2",
        policy_hash: "a".repeat(64),
        platform_policy_revision: "floor-v1",
        platform_policy_hash: "b".repeat(64),
        community_policy_revision: "community-v1",
        community_policy_hash: "c".repeat(64),
        matched_categories: ["harassment"],
        category_decisions: { harassment: "review" },
        effective_policy_decision: "review",
        author_declared_rating: "general",
        resulting_content_rating: "general",
        input_sha256: "d".repeat(64),
        evidence_ref: "evidence-v2",
      }),
    ).toMatchObject({ version: "text-moderation-v2", decision: "manual_review" });
  });

  test("freezes reload-safe public submission variants", () => {
    const decode = Schema.decodeUnknownSync(TextContentSubmissionV1);
    const base = {
      submission_id: "submission-1",
      href: "/text-content-submissions/submission-1",
      surface: "text_post",
      created_at: "2026-08-20T13:00:00.000Z",
      updated_at: "2026-08-20T13:00:00.000Z",
    };
    expect(
      decode({
        ...base,
        status: "published",
        result: { decision: "allow", reason_code: null },
        published_resource: { kind: "post", post_id: "post-1", href: "/posts/post-1" },
        review_ref: null,
      }).status,
    ).toBe("published");
    expect(
      decode({
        ...base,
        status: "manual_review",
        result: { decision: "manual_review", reason_code: "moderation_unavailable" },
        published_resource: null,
        review_ref: "review-1",
      }).status,
    ).toBe("manual_review");
    expect(
      decode({
        ...base,
        status: "blocked",
        result: { decision: "blocked", reason_code: "policy_violation" },
        published_resource: null,
        review_ref: null,
      }).status,
    ).toBe("blocked");
  });

  test("rejects cross-field mismatches and internal reason leakage", () => {
    const decode = Schema.decodeUnknownSync(TextContentSubmissionV1);
    const base = {
      submission_id: "submission-1",
      href: "/text-content-submissions/submission-1",
      surface: "text_post",
      created_at: "2026-08-20T13:00:00.000Z",
      updated_at: "2026-08-20T13:00:00.000Z",
      published_resource: null,
      review_ref: null,
    };
    for (const candidate of [
      {
        ...base,
        status: "published",
        result: { decision: "allow", reason_code: null },
      },
      {
        ...base,
        status: "manual_review",
        result: { decision: "manual_review", reason_code: "sexual_minors" },
        review_ref: "review-1",
      },
      {
        ...base,
        status: "blocked",
        result: { decision: "blocked", reason_code: "policy_violation" },
        review_ref: "review-1",
      },
      {
        ...base,
        href: "//evil.example/submission-1",
        status: "blocked",
        result: { decision: "blocked", reason_code: "policy_violation" },
      },
      {
        ...base,
        submission_id: " submission-1 ",
        status: "blocked",
        result: { decision: "blocked", reason_code: "policy_violation" },
      },
    ]) {
      expect(() => decode(candidate)).toThrow();
    }

    const decoded = decode({
      ...base,
      status: "blocked",
      result: { decision: "blocked", reason_code: "policy_violation" },
      reason_codes: ["sexual_minors"],
      policy_hash: "a".repeat(64),
      evidence_ref: "evidence-1",
    });
    expect(decoded).not.toHaveProperty("reason_codes");
    expect(decoded).not.toHaveProperty("policy_hash");
    expect(decoded).not.toHaveProperty("evidence_ref");
  });
});
