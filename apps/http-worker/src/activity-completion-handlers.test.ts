import { describe, expect, test } from "bun:test";
import type { ActivityCompletionStore } from "@pirate/application/use-cases/rewards/activity-completion";
import {
  ActivityQualificationRejected,
  ActivityQualificationStorageFailed,
} from "@pirate/application/use-cases/rewards/activity-qualification";
import { AuthError, InternalError, NotFound, toErrorBody } from "@pirate/contracts";
import { Effect } from "effect";
import { makeActivityCompletionHandlers } from "./activity-completion-handlers.ts";
import { createHttpWorker, type Principal } from "./transport.ts";

const readAt = "2026-10-16T02:00:00.000Z";
function fixture(principal: Principal | null) {
  const calls: unknown[] = [];
  const store: ActivityCompletionStore = {
    getCompletion: (input) => {
      calls.push(input);
      return Effect.succeed({
        object: "activity_completion",
        community_id: input.communityId,
        post_id: "song",
        persona_id: "persona",
        audio_revision: 1,
        attempt:
          input.activity === "study"
            ? { kind: "study", session_id: input.sessionId }
            : { kind: "karaoke", session_id: input.sessionId, attempt_id: input.attemptId ?? "" },
        timezone: "UTC",
        day_semantics: "account_pinned_iana_timezone_v1",
        observed_at: input.readAt,
        decision: { status: "pending" },
      });
    },
    getProgress: () => Effect.fail(new ActivityQualificationRejected({ reason: "not-found" })),
    getPresentation: (input) => {
      calls.push(input);
      return Effect.succeed({
        object: "activity_presentation_state",
        community_id: input.communityId,
        observed_at: input.readAt,
        selection: { status: "unset" },
      });
    },
  };
  const handlers = makeActivityCompletionHandlers({
    store,
    clock: { now: Effect.succeed(Date.parse(readAt)) },
  });
  const worker = createHttpWorker({
    config: { corsOrigin: "https://app.pirate.test" },
    handlers,
    authenticate: () => {
      if (principal === null) throw new AuthError({ message: "Authentication required" });
      return principal;
    },
    authorize: () => undefined,
  });
  return { worker, calls };
}
describe("private activity completion HTTP", () => {
  test("retains mapped domain causes for diagnostics without putting private causes on the wire", async () => {
    for (const [failure, wireType] of [
      [new ActivityQualificationStorageFailed({ reason: "invalid-row" }), InternalError],
      [new ActivityQualificationRejected({ reason: "not-found" }), NotFound],
    ] as const) {
      Object.assign(failure, { cause: new Error("private-evidence-marker") });
      const fail = () => Effect.fail(failure);
      const store: ActivityCompletionStore = {
        getCompletion: fail,
        getProgress: fail,
        getPresentation: fail,
      };
      const handlers = makeActivityCompletionHandlers({
        store,
        clock: { now: Effect.succeed(Date.parse(readAt)) },
      });
      const error = await Promise.resolve(
        handlers.GetSongActivityProgress({
          body: undefined,
          params: { communityId: "community", postId: "song" },
          query: {},
          principal: { kind: "user", subject: "authenticated-account" },
        }),
      ).then(
        () => {
          throw new Error("expected mapped failure");
        },
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(wireType);
      expect((error as InternalError | NotFound).cause).toBe(failure);
      const wire = toErrorBody(error);
      expect(JSON.stringify(wire)).not.toContain("private-evidence-marker");
      expect(wire.body).not.toHaveProperty("cause");
    }
  });
  test("uses only the authenticated identity and preserves exact Karaoke source keys", async () => {
    const { worker, calls } = fixture({ kind: "user", subject: "authenticated-account" });
    const response = await worker.request(
      "/communities/community/karaoke/sessions/session/attempts/attempt/completion",
      {
        headers: { authorization: "Bearer test" },
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(calls).toEqual([
      {
        accountId: "authenticated-account",
        communityId: "community",
        sessionId: "session",
        attemptId: "attempt",
        activity: "karaoke",
        readAt,
      },
    ]);
    expect(await response.text()).not.toContain("authenticated-account");
  });
  test("returns a presentation without requiring standing and marks refusal private", async () => {
    const { worker } = fixture({ kind: "user", subject: "authenticated-account" });
    const response = await worker.request("/communities/community/rewards/presentation-persona", {
      headers: { authorization: "Bearer test" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ selection: { status: "unset" } });
    const denied = await worker.request("/communities/community/posts/song/rewards/progress", {
      headers: { authorization: "Bearer test" },
    });
    expect(denied.status).toBe(404);
    expect(denied.headers.get("cache-control")).toBe("private, no-store");
  });
  test("refuses an unauthenticated read before returning private state", async () => {
    const { worker, calls } = fixture(null);
    const response = await worker.request(
      "/communities/community/study/v2/sessions/session/completion",
    );
    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
