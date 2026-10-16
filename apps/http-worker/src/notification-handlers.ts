import {
  listMyNotifications,
  type NotificationStore,
  readMyNotification,
} from "@pirate/application/use-cases/notifications";
import { AuthError } from "@pirate/contracts";
import { Effect } from "effect";
import { type EndpointHandler, withEndpointResult } from "./transport.ts";

export function makeNotificationHandlers(
  store: NotificationStore,
): Readonly<Record<"ListMyNotifications" | "ReadMyNotification", EndpointHandler>> {
  const recipient = (request: Parameters<EndpointHandler>[0]) => {
    if (request.principal?.kind !== "user")
      throw new AuthError({ message: "Authentication required" });
    return request.principal.subject;
  };
  return {
    ListMyNotifications: async (request) => {
      const recipientUserId = recipient(request);
      const query = request.query as { cursor?: string };
      const body = await Effect.runPromise(
        listMyNotifications(
          { recipientUserId, ...(query.cursor === undefined ? {} : { cursor: query.cursor }) },
          store,
        ),
      );
      return withEndpointResult(body, 200, { "cache-control": "private, no-store" });
    },
    ReadMyNotification: async (request) => {
      const recipientUserId = recipient(request);
      const path = request.params as { notificationId: string };
      const body = await Effect.runPromise(
        readMyNotification({ recipientUserId, notificationId: path.notificationId }, store),
      );
      return withEndpointResult(body, 200, { "cache-control": "private, no-store" });
    },
  };
}
