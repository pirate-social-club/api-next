import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  DanceReviewServiceFailure,
  projectPrivateDanceReview,
} from "../../../packages/application/src/use-cases/dance/moderator-review-services.ts";
import { moderatedDanceFixture } from "../../../packages/testing/src/moderated-dance-fixture.ts";
import { makeModeratedDanceReviewHandlers } from "./moderated-dance-review-handlers.ts";
import { createHttpWorker } from "./transport.ts";

const headers = {
  cookie: "__Host-pirate_session=fictional; __Host-pirate_csrf=fictional_csrf",
  origin: "https://app.pirate.test",
  "x-csrf-token": "fictional_csrf",
  "content-type": "application/json",
};
const base = "/communities/community/dance/reviews/review";
const body = {
  version: "dance-review-submit-v1",
  operation: "submit",
  idempotency_key: "submit-key",
  community_id: "community",
  review_id: "review",
  expected_review_revision: 1,
  show_publicly_if_passed: false,
  publication_disclosure_version: "disclosure-v1",
};
function fixture() {
  const calls: string[] = [];
  const result = projectPrivateDanceReview(moderatedDanceFixture().state);
  const handlers = makeModeratedDanceReviewHandlers((accountId) => {
    calls.push(`principal:${accountId}`);
    const unauthorized = () =>
      Effect.fail(new DanceReviewServiceFailure({ reason: "unauthorized" }));
    return {
      authenticateAccount: () => Effect.succeed({ kind: "account", accountId }),
      authenticateWorker: unauthorized,
      withTransaction: () => {
        calls.push("transaction");
        return Effect.fail(new DanceReviewServiceFailure({ reason: "outcome_unknown" }));
      },
      getOwnResult: (communityId, reviewId) => {
        calls.push(`result:${communityId}:${reviewId}`);
        return Effect.succeed(result);
      },
      getLatest: () =>
        Effect.succeed({
          object: "latest_moderated_dance_review",
          latest_submitted: result,
          active_session_id: null,
        }),
      ownerQueue: () => Effect.fail(new DanceReviewServiceFailure({ reason: "not_found" })),
      ownerDetail: () => Effect.fail(new DanceReviewServiceFailure({ reason: "not_found" })),
    };
  });
  const worker = createHttpWorker({
    config: { corsOrigin: "https://app.pirate.test" },
    handlers,
    authenticate: () => ({ kind: "user", subject: "dancer" }),
    authorize: () => undefined,
  });
  return { calls, worker, result };
}

describe("moderated Dance browser/private HTTP surface", () => {
  test("cookie-only commands require exact Origin and CSRF before source access", async () => {
    const f = fixture();
    for (const override of [
      { cookie: "", authorization: "Bearer machine" },
      { origin: "https://foreign.invalid" },
      { "x-csrf-token": "wrong" },
    ]) {
      const response = await f.worker.request(`${base}/submit`, {
        method: "POST",
        headers: { ...headers, ...override },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(401);
    }
    expect(f.calls).toEqual([]);
  });
  test("closed exact JSON rejects duplicate/escaped keys, scores, actor and path mismatch", async () => {
    const f = fixture();
    const serialized = JSON.stringify(body);
    for (const invalid of [
      `{"show_publicly_if_passed":true,${serialized.slice(1)}`,
      `{"show_publicly_if_\\u0070assed":true,${serialized.slice(1)}`,
      JSON.stringify({ ...body, reviewer_account_id: "owner" }),
      JSON.stringify({ ...body, score_bps: 10000 }),
      JSON.stringify({ ...body, review_id: "foreign" }),
      JSON.stringify({ ...body, show_publicly_if_passed: undefined }),
    ]) {
      const response = await f.worker.request(`${base}/submit`, {
        method: "POST",
        headers,
        body: invalid,
      });
      expect(response.status).toBe(400);
    }
    expect(f.calls).toEqual([]);
  });
  test("valid command uses the session actor; unknown commit never becomes success or retry", async () => {
    const f = fixture();
    const response = await f.worker.request(`${base}/submit`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: {
        message: "Review outcome unknown; read current status or replay the same command key",
      },
    });
    expect(f.calls).toEqual(["principal:dancer", "transaction"]);
  });
  test("own results are private/no-store and ordinary activity is not gated by Rewards", async () => {
    const f = fixture();
    const response = await f.worker.request(`${base}/result`, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(f.result);
    expect(f.calls).toEqual(["principal:dancer", "result:community:review"]);
    const queue = await f.worker.request("/communities/community/dance/owner-reviews", { headers });
    expect(queue.status).toBe(404);
  });
});
