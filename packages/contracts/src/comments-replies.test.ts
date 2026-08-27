import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  CreateComment,
  CreateCommentReply,
  ModerateCaseAction,
  ReplyDepthExceeded,
  ReportComment,
  schemaToOpenApi,
} from "./index.ts";
import { TextContentSubmissionV1 } from "./text-moderation.ts";

const publishedCommentSubmission = {
  submission_id: "submission_comment_1",
  href: "/text-content-submissions/submission_comment_1",
  surface: "comment",
  status: "published",
  result: { decision: "allow", reason_code: null },
  published_resource: {
    kind: "comment",
    comment_id: "comment_1",
    href: "/comments/comment_1",
  },
  review_ref: null,
  created_at: "2026-08-22T00:00:00.000Z",
  updated_at: "2026-08-22T00:00:00.000Z",
} as const;

const schemaProperties = (schema: unknown): Record<string, unknown> => {
  const openApi = schemaToOpenApi(schema);
  return (openApi.properties ?? {}) as Record<string, unknown>;
};

describe("comments and replies contracts", () => {
  test("uses the exact text request and shared submission response for both routes", () => {
    expect(CreateComment.path).toBe("/posts/:postId/comments");
    expect(CreateCommentReply.path).toBe("/comments/:commentId/replies");
    expect(CreateComment.auth).toEqual({ policy: { kind: "userOrAdmin" } });
    expect(CreateCommentReply.auth).toEqual({ policy: { kind: "userOrAdmin" } });
    expect(CreateComment.request?.body).toBe(CreateCommentReply.request?.body);
    expect(CreateComment.response).toBe(TextContentSubmissionV1);
    expect(CreateCommentReply.response).toBe(TextContentSubmissionV1);
    expect(CreateComment.successStatus).toBe(201);
    expect(CreateCommentReply.successStatus).toBe(201);
    expect(CreateCommentReply.errors).toContain(ReplyDepthExceeded);
  });

  test("requires persona_id, idempotency_key, and body and rejects legacy fields", () => {
    const requestBody = CreateComment.request?.body;
    const schema = schemaToOpenApi(requestBody);
    expect(schema.required).toEqual(["idempotency_key", "persona_id", "body"]);
    expect(Object.keys(schemaProperties(requestBody)).sort()).toEqual([
      "author_declared_rating",
      "body",
      "idempotency_key",
      "persona_id",
    ]);
    expect(schema.additionalProperties).toBe(false);
    expect(() =>
      Schema.decodeUnknownSync(requestBody, { onExcessProperty: "error" })({
        idempotency_key: "key_1",
        persona_id: "persona_comment_author",
        body: "hello",
        media_refs: [],
      }),
    ).toThrow();
  });

  test("accepts a comment resource through the frozen submission response", () => {
    expect(Schema.decodeUnknownSync(TextContentSubmissionV1)(publishedCommentSubmission)).toEqual(
      publishedCommentSubmission,
    );
  });

  test("keeps report coalescing and case-scoped action shapes closed", () => {
    expect(ReportComment.path).toBe("/comments/:commentId/reports");
    expect(schemaToOpenApi(ReportComment.request?.body).required).toEqual([
      "idempotency_key",
      "reason_code",
    ]);
    expect(schemaToOpenApi(ReportComment.response).required).toEqual([
      "report_id",
      "case_ref",
      "status",
    ]);
    expect(ModerateCaseAction.path).toBe("/moderation/cases/:caseRef/actions");
    const actionBody = ModerateCaseAction.request?.body;
    const actionProperty = schemaProperties(actionBody).action as Record<string, unknown>;
    expect(actionProperty.enum).toEqual([
      "approve_as_general",
      "approve_as_adult_18",
      "reject",
      "dismiss_report",
      "hide",
      "raise_rating_to_adult_18",
      "restore",
    ]);
    expect(() =>
      Schema.decodeUnknownSync(actionBody)({
        version: "moderation-case-action-v2",
        idempotency_key: "action_1",
        expected_case_revision: 1,
        action: "block",
      }),
    ).toThrow();
  });
});
