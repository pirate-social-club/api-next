import { describe, expect, test } from "bun:test";

import {
  createMediaSubmissionState,
  mediaSubmissionInvariant,
  transition,
} from "./media-submission.ts";

const actor = "user_1";
const base = createMediaSubmissionState({
  submissionId: "sub_1",
  operationId: "op_1",
  actorId: actor,
});
const command = (
  event: Parameters<typeof transition>[1]["event"],
  extra: Record<string, unknown> = {},
) => ({
  event,
  actorId: actor,
  expectedRevision: 1,
  ...extra,
});

describe("song media submission machine", () => {
  test("keeps the upload and analysis path explicit", () => {
    const reserved = transition(
      base,
      command("media_reservation_issued", { reservationId: "res_1" }),
    );
    expect(reserved).toMatchObject({
      ok: true,
      state: { status: "processing", phase: "awaiting_upload" },
    });
    if (!reserved.ok) return;
    const finalize = transition(
      reserved.state,
      command("finalize_requested", { reservationId: "res_1" }),
    );
    expect(finalize).toMatchObject({ ok: true, state: { phase: "finalize" } });
    if (!finalize.ok) return;
    const sealed = transition(
      finalize.state,
      command("upload_finalized", { reservationId: "res_1", immutableRef: "audio_1" }),
    );
    expect(sealed).toMatchObject({
      ok: true,
      state: { phase: "analysis", immutableRef: "audio_1" },
    });
  });

  test("rejects stale revisions and foreign actors without mutation", () => {
    const stale = transition(base, { ...command("text_input_bound"), expectedRevision: 2 });
    expect(stale).toEqual({
      ok: false,
      rejection: { _tag: "stale_revision", expected: 2, actual: 1 },
    });
    const foreign = transition(base, { ...command("text_input_bound"), actorId: "user_2" });
    expect(foreign).toEqual({
      ok: false,
      rejection: { _tag: "actor_not_authorized", reason_code: "submission_owner_required" },
    });
  });

  test("fences retry count and preserves the failure reason", () => {
    const failed = transition(
      { ...base, phase: "analysis" },
      command("media_failure_recorded", { failureReason: "probe_failed", retryable: true }),
    );
    expect(failed).toMatchObject({
      ok: true,
      state: { status: "processing_failed", retryCount: 0 },
    });
    if (!failed.ok) return;
    const retry = transition(failed.state, command("retry_authorized"));
    expect(retry).toMatchObject({
      ok: true,
      state: { status: "processing", creationRevision: 2, retryCount: 1 },
    });
    expect(mediaSubmissionInvariant(failed.state)).toBeNull();
  });

  test("requires a held revision for review and publishes only through publish", () => {
    const review = transition(
      { ...base, phase: "analysis" },
      command("review_required", { reviewRef: "review_1" }),
    );
    expect(review).toMatchObject({ ok: true, state: { status: "manual_review", heldRevision: 1 } });
    if (!review.ok) return;
    const approved = transition(review.state, {
      ...command("moderator_approved"),
      moderator: true,
    });
    expect(approved).toMatchObject({ ok: true, state: { status: "processing", phase: "publish" } });
    if (!approved.ok) return;
    const published = transition(
      approved.state,
      command("publication_committed", { postId: "post_1" }),
    );
    expect(published).toMatchObject({ ok: true, state: { status: "published", postId: "post_1" } });
  });
});
