import { expect, test } from "bun:test";
import { Schema } from "effect";
import { ListMyNotifications, NotificationV1, ReadMyNotification } from "./notifications.ts";

const id = "00000000-0000-4000-8000-000000000001";
const fact = {
  notification_id: id,
  kind: "reply_published",
  occurred_at: "2026-10-16T00:00:00.000000Z",
  read_at: null,
  target: {
    kind: "comment_thread",
    community_id: "community",
    post_id: "post",
    comment_id: "reply",
  },
} as const;
const exact = { onExcessProperty: "error" } as const;

test("inbox contract round-trips supported facts without account or moderation payloads", () => {
  const decode = Schema.decodeUnknownSync(NotificationV1, exact);
  expect(decode(fact)).toEqual(fact);
  for (const extra of [
    { recipient_user_id: "other" },
    { body: "private" },
    { evidence_ref: "private" },
  ])
    expect(() => decode({ ...fact, ...extra })).toThrow();
  for (const kind of ["review_required", "vote", "reward", "follow"])
    expect(() => decode({ ...fact, kind })).toThrow();
});

test("page contract bounds results and recipient selection is absent", () => {
  const decode = Schema.decodeUnknownSync(ListMyNotifications.response, exact);
  const page = {
    object: "notification_page" as const,
    items: [fact],
    next_cursor: id,
    unread_count: 1,
  };
  expect(decode(page)).toEqual(page);
  expect(() => decode({ ...page, items: Array(21).fill(fact) })).toThrow();
  expect(() => decode({ ...page, unread_count: -1 })).toThrow();
  const query = Schema.decodeUnknownSync(ListMyNotifications.request.query, exact);
  expect(query({ cursor: id })).toEqual({ cursor: id });
  for (const value of [
    { cursor: "x".repeat(2049) },
    { recipient_user_id: "other" },
    { limit: 1000 },
  ])
    expect(() => query(value)).toThrow();
  expect(ListMyNotifications.auth).toEqual({ policy: { kind: "user" } });
  expect(ReadMyNotification.auth).toEqual({ policy: { kind: "user" } });
  expect("body" in ReadMyNotification.request).toBe(false);
});

test("Dance terminal notifications navigate only to the recipient-private result", () => {
  const decode = Schema.decodeUnknownSync(NotificationV1, exact);
  const dance = {
    notification_id: id,
    kind: "dance_review_result",
    occurred_at: fact.occurred_at,
    read_at: null,
    target: { kind: "private_dance_result", community_id: "community", review_id: "review" },
    outcome: "passed",
  } as const;
  for (const outcome of ["passed", "not_passed", "review_expired"] as const)
    expect(decode({ ...dance, outcome })).toEqual({ ...dance, outcome });
  for (const forged of [
    { ...dance, outcome: "withdrawn" },
    { ...dance, outcome: undefined },
    { ...dance, target: fact.target },
    { ...fact, target: dance.target },
    { ...dance, target: { ...dance.target, account_id: "other" } },
    { ...dance, recording_url: "https://private.invalid/recording" },
    { ...dance, qualification_id: "qualification" },
    { ...dance, reviewer_account_id: "owner" },
  ])
    expect(() => decode(forged)).toThrow();
  expect(
    Schema.decodeUnknownSync(
      ListMyNotifications.response,
      exact,
    )({
      object: "notification_page",
      items: [fact, dance],
      next_cursor: null,
      unread_count: 2,
    }).items,
  ).toEqual([fact, dance]);
});
