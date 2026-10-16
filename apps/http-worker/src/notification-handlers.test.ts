import { expect, test } from "bun:test";
import { BadRequest, NotFound } from "@pirate/contracts";
import { Effect } from "effect";
import { makeNotificationHandlers } from "./notification-handlers.ts";
import type { DecodedRequest } from "./transport.ts";

const id = "00000000-0000-4000-8000-000000000001";
const request: DecodedRequest = {
  principal: { kind: "user", subject: "inbox-owner" },
  params: { notificationId: id },
  query: {},
  body: undefined,
};
test("inbox handlers bind ownership only to the principal and never cache results", async () => {
  const handlers = makeNotificationHandlers({
    list: (input) => {
      expect(input).toEqual({ recipientUserId: "inbox-owner", cursor: id });
      return Effect.succeed({
        object: "notification_page",
        items: [],
        next_cursor: null,
        unread_count: 0,
      });
    },
    read: (input) => {
      expect(input).toEqual({ recipientUserId: "inbox-owner", notificationId: id });
      return Effect.succeed({ notification_id: id, read_at: "2026-10-16T00:00:00Z" });
    },
  });
  const page = await handlers.ListMyNotifications({ ...request, query: { cursor: id } });
  const read = await handlers.ReadMyNotification({
    ...request,
    body: { recipientUserId: "inbox-other" },
  });
  for (const result of [page, read]) {
    expect(result).toMatchObject({ status: 200 });
    expect(result).toMatchObject({ responseHeaders: { "cache-control": "private, no-store" } });
  }
  for (const principal of [
    null,
    { kind: "admin", subject: "inbox-owner" },
    { kind: "agent", subject: "inbox-owner" },
  ] as const) {
    for (const handler of Object.values(handlers))
      await expect(handler({ ...request, principal })).rejects.toThrow("Authentication required");
  }
});

test("malformed cursor refuses before store access and foreign reads preserve the private not-found result", async () => {
  const handlers = makeNotificationHandlers({
    list: () => Effect.die("invalid cursor reached storage"),
    read: () => Effect.fail(new NotFound({ message: "Notification not found" })),
  });
  await expect(
    handlers.ListMyNotifications({ ...request, query: { cursor: "bad" } }),
  ).rejects.toBeInstanceOf(BadRequest);
  await expect(handlers.ReadMyNotification(request)).rejects.toBeInstanceOf(NotFound);
});
