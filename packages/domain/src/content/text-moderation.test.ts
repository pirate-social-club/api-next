import { describe, expect, test } from "bun:test";
import {
  baselineTextModerationDecision,
  canonicalTextModerationInput,
  canonicalTextModerationReasons,
  moreRestrictiveTextPublicationDecision,
  normalizeTextModerationInput,
  publicTextPublicationResult,
  type TextModerationEvaluationV1,
  textContentSubmissionInvariant,
  textModerationEvaluationInvariant,
} from "./text-moderation.ts";

const hash = "a".repeat(64);

function evaluation(
  decision: TextModerationEvaluationV1["decision"],
  reason_codes: TextModerationEvaluationV1["reason_codes"],
): TextModerationEvaluationV1 {
  return {
    version: "text-moderation-v1",
    surface: "text_post",
    decision,
    reason_codes,
    policy_revision: "text-policy-1",
    policy_hash: hash,
    input_sha256: "b".repeat(64),
    evidence_ref: null,
  };
}

describe("text moderation domain", () => {
  test("normalizes line endings, Unicode, edge whitespace, and empty fields", () => {
    expect(
      normalizeTextModerationInput({
        surface: "text_post",
        title: "  Cafe\u0301\r\nPirate  ",
        body: " \rbody\r\n ",
      }),
    ).toEqual({
      kind: "accepted",
      input: {
        version: "text-moderation-input-v1",
        surface: "text_post",
        title: "Café\nPirate",
        body: "body",
      },
    });
    expect(normalizeTextModerationInput({ surface: "comment", body: "  " })).toEqual({
      kind: "rejected",
      reason: "empty",
    });
    expect(normalizeTextModerationInput({ surface: "reply", body: "\ud800" })).toEqual({
      kind: "rejected",
      reason: "invalid_unicode",
    });
    expect(normalizeTextModerationInput({ surface: "image" as "text_post", body: "body" })).toEqual(
      { kind: "rejected", reason: "invalid_surface" },
    );
  });

  test("pins the RFC 8785 preimage and lowercase SHA-256 fixture", () => {
    const normalized = normalizeTextModerationInput({
      surface: "text_post",
      title: "Hello",
      body: "World",
    });
    if (normalized.kind === "rejected") throw new Error(normalized.reason);
    expect(canonicalTextModerationInput(normalized.input)).toEqual({
      kind: "accepted",
      preimage:
        '{"body":"World","surface":"text_post","title":"Hello","version":"text-moderation-input-v1"}',
      sha256: "6a6503f51e3ad8a2b8e616ea92292ac17a1da1cd12d8c6896261d24b9a7e5cb8",
    });
    expect(
      canonicalTextModerationInput({
        version: "text-moderation-input-v1",
        surface: "comment",
        title: '雪\n"pirate"',
        body: "Line\u0001",
      }),
    ).toEqual({
      kind: "accepted",
      preimage:
        '{"body":"Line\\u0001","surface":"comment","title":"雪\\n\\"pirate\\"","version":"text-moderation-input-v1"}',
      sha256: "3253e04a3e2a099fd0004f8f41b6166785b87def942bf96be3b366be383d53ee",
    });
    expect(
      canonicalTextModerationInput({
        version: "future" as "text-moderation-input-v1",
        surface: "text_post",
        title: "Hello",
        body: null,
      }),
    ).toEqual({ kind: "rejected", reason: "invalid_version" });
  });

  test("orders and deduplicates reasons before persistence", () => {
    expect(
      canonicalTextModerationReasons([
        "provider_timeout",
        "hate",
        "provider_timeout",
        "sexual_minors",
      ]),
    ).toEqual(["sexual_minors", "hate", "provider_timeout"]);
    expect(canonicalTextModerationReasons(["unknown-provider-value"])).toEqual([
      "provider_invalid",
    ]);
  });

  test("applies baseline precedence and permits only stricter overlays", () => {
    expect(baselineTextModerationDecision([])).toBe("allow");
    expect(baselineTextModerationDecision(["hate"])).toBe("manual_review");
    expect(baselineTextModerationDecision(["provider_invalid"])).toBe("manual_review");
    expect(baselineTextModerationDecision(["unknown-provider-value"])).toBe("manual_review");
    expect(baselineTextModerationDecision(["sexual_minors", "provider_timeout"])).toBe("blocked");
    expect(moreRestrictiveTextPublicationDecision("manual_review", "allow")).toBe("manual_review");
    expect(moreRestrictiveTextPublicationDecision("manual_review", "blocked")).toBe("blocked");
  });

  test("maps every internal reason to the closed public result without leaking categories", () => {
    expect(publicTextPublicationResult(evaluation("allow", []))).toEqual({
      decision: "allow",
      reason_code: null,
    });
    for (const reason of [
      "adult_sexual",
      "graphic_violence",
      "harassment",
      "threat",
      "hate",
      "self_harm",
      "illicit",
      "spam",
      "other_policy",
      "age_gate_required",
    ] as const) {
      expect(publicTextPublicationResult(evaluation("manual_review", [reason]))).toEqual({
        decision: "manual_review",
        reason_code: "review_required",
      });
    }
    for (const reason of [
      "provider_unavailable",
      "provider_timeout",
      "provider_invalid",
    ] as const) {
      expect(publicTextPublicationResult(evaluation("manual_review", [reason]))).toEqual({
        decision: "manual_review",
        reason_code: "moderation_unavailable",
      });
    }
    expect(publicTextPublicationResult(evaluation("blocked", ["sexual_minors"]))).toEqual({
      decision: "blocked",
      reason_code: "policy_violation",
    });
  });

  test("rejects contradictory or incomplete evaluations", () => {
    expect(textModerationEvaluationInvariant(evaluation("allow", ["spam"]))).toBe(
      "allow_with_reasons",
    );
    expect(textModerationEvaluationInvariant(evaluation("blocked", []))).toBe(
      "non_allow_without_reason",
    );
    expect(textModerationEvaluationInvariant(evaluation("manual_review", ["sexual_minors"]))).toBe(
      "sexual_minors_not_blocked",
    );
    expect(textModerationEvaluationInvariant(evaluation("blocked", ["provider_timeout"]))).toBe(
      "review_reason_not_held",
    );
  });

  test("enforces reload-safe submission cross-field invariants", () => {
    const base = {
      submission_id: "submission-1",
      href: "/text-content-submissions/submission-1",
      surface: "text_post" as const,
      created_at: "2026-08-20T13:00:00.000Z",
      updated_at: "2026-08-20T13:00:00.000Z",
    };
    expect(
      textContentSubmissionInvariant({
        ...base,
        status: "published",
        result: { decision: "allow", reason_code: null },
        published_resource: { kind: "post", post_id: "post-1", href: "/posts/post-1" },
        review_ref: null,
      }),
    ).toBeNull();
    expect(
      textContentSubmissionInvariant({
        ...base,
        status: "manual_review",
        result: { decision: "manual_review", reason_code: "review_required" },
        published_resource: null,
        review_ref: "review-1",
      }),
    ).toBeNull();
    expect(
      textContentSubmissionInvariant({
        ...base,
        status: "blocked",
        result: { decision: "blocked", reason_code: "policy_violation" },
        published_resource: { kind: "post", post_id: "post-1", href: "/posts/post-1" },
        review_ref: null,
      }),
    ).toBe("unexpected_published_resource");
    expect(
      textContentSubmissionInvariant({
        ...base,
        href: "//evil.example/submission-1",
        status: "blocked",
        result: { decision: "blocked", reason_code: "policy_violation" },
        published_resource: null,
        review_ref: null,
      }),
    ).toBe("href");
  });
});
