import { expect, test } from "bun:test";
import { createPirateApiClient } from "@pirate/api-client";
import { AuthError } from "@pirate/contracts";
import { Effect } from "effect";
import { makeNotificationHandlers } from "./notification-handlers.ts";
import { createHttpWorker } from "./transport.ts";

const id = "00000000-0000-4000-8000-000000000001";
test("generated inbox routes enforce session/CSRF, exact query decoding and generated-client responses", async () => {
  let reads = 0;
  const worker = createHttpWorker({
    config: { corsOrigin: "https://solid.test" },
    authenticate: ({ credentials }) => ({
      kind: "user",
      subject: credentials.sessionCookie ?? "machine",
    }),
    authorize: ({ input }) => {
      if (input.principal?.kind !== "user")
        throw new AuthError({ message: "Authentication required" });
    },
    handlers: makeNotificationHandlers({
      list: ({ recipientUserId }) => {
        expect(recipientUserId).toBe("inbox-owner");
        return Effect.succeed({
          object: "notification_page",
          items: [],
          unread_count: 0,
          next_cursor: null,
        });
      },
      read: ({ recipientUserId, notificationId }) => {
        expect(recipientUserId).toBe("inbox-owner");
        expect(notificationId).toBe(id);
        reads++;
        return Effect.succeed({ notification_id: id, read_at: "2026-10-16T00:00:00Z" });
      },
    }),
  });
  const cookie = "__Host-pirate_session=inbox-owner; __Host-pirate_csrf=csrf-proof";
  const path = `https://worker.test/me/notifications/${id}/read`;
  expect((await worker.request("https://worker.test/me/notifications")).status).toBe(401);
  expect(
    (
      await worker.request("https://worker.test/me/notifications?recipient_user_id=inbox-other", {
        headers: { cookie },
      })
    ).status,
  ).toBe(400);
  for (const headers of [
    { cookie, origin: "https://solid.test" },
    { cookie, origin: "https://other.test", "x-csrf-token": "csrf-proof" },
    { cookie, origin: "https://solid.test", "x-csrf-token": "different" },
  ])
    expect((await worker.request(path, { method: "POST", headers })).status).toBe(401);
  expect(reads).toBe(0);
  const fetchImpl = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) =>
      worker.request(input instanceof Request ? input.url : String(input), init),
    { preconnect: fetch.preconnect },
  );
  const client = createPirateApiClient("https://worker.test", { fetchImpl });
  expect(await client.get_meNotifications({}, { headers: { cookie } })).toEqual({
    object: "notification_page",
    items: [],
    unread_count: 0,
    next_cursor: null,
  });
  expect(
    await client.post_meNotificationsNotificationIdRead(
      { path: { notificationId: id } },
      { headers: { cookie, origin: "https://solid.test", "x-csrf-token": "csrf-proof" } },
    ),
  ).toEqual({ notification_id: id, read_at: "2026-10-16T00:00:00Z" });
  expect(reads).toBe(1);
});
