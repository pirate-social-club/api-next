import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  CreatePost,
  GetTextContentSubmission,
  IdempotencyConflict,
  ProviderUnavailable,
  schemaToOpenApi,
  TextContentSubmissionV1,
  toErrorBody,
} from "./index.ts";

const publishedTextSubmission = {
  submission_id: "sub_1",
  href: "/text-content-submissions/sub_1",
  surface: "text_post",
  status: "published",
  result: { decision: "allow", reason_code: null },
  published_resource: { kind: "post", post_id: "post_1", href: "/posts/post_1" },
  review_ref: null,
  created_at: "2026-08-21T12:00:00.000Z",
  updated_at: "2026-08-21T12:00:00.000Z",
} as const;

describe("text CreatePost contract", () => {
  test("returns the text submission snapshot with only HTTP 201", () => {
    expect(CreatePost.response).toBe(TextContentSubmissionV1);
    expect(CreatePost.successStatus).toBe(201);
    expect(CreatePost.errors).not.toContain(ProviderUnavailable);
    expect(Schema.decodeUnknownSync(TextContentSubmissionV1)(publishedTextSubmission)).toEqual(
      publishedTextSubmission,
    );
  });

  test("removes publish_mode from every declared request branch and strict decoding rejects it", () => {
    const requestSchema = schemaToOpenApi(CreatePost.request?.body);
    const branches = Array.isArray(requestSchema.anyOf) ? requestSchema.anyOf : [];
    expect(branches.length).toBeGreaterThan(0);
    for (const branch of branches) {
      expect(
        Object.hasOwn((branch as Record<string, unknown>).properties ?? {}, "publish_mode"),
      ).toBe(false);
    }
    const body = {
      post_type: "text",
      idempotency_key: "key_1",
      body: "hello",
      publish_mode: "async",
    };
    expect(() =>
      Schema.decodeUnknownSync(CreatePost.request?.body as Schema.ConstraintDecoder<unknown>, {
        onExcessProperty: "error",
      })(body),
    ).toThrow();
  });

  test("adds an author-scoped current-state lookup", () => {
    expect(GetTextContentSubmission.path).toBe("/text-content-submissions/:submissionId");
    expect(GetTextContentSubmission.response).toBe(TextContentSubmissionV1);
  });

  test("uses the standard non-retryable conflict envelope with typed details", () => {
    expect(
      toErrorBody(
        new IdempotencyConflict({
          message: "The idempotency key belongs to another submission",
          details: { reason_code: "idempotency_conflict", submission_id: "sub_1" },
        }),
        "req_1",
      ),
    ).toEqual({
      status: 409,
      body: {
        error: {
          code: "conflict",
          message: "The idempotency key belongs to another submission",
          retryable: false,
          details: { reason_code: "idempotency_conflict", submission_id: "sub_1" },
        },
        request_id: "req_1",
      },
    });
  });
});
