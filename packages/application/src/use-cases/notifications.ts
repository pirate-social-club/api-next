import {
  AuthError,
  BadRequest,
  type InternalError,
  type ListMyNotifications,
  type NotFound,
  NotificationIdV1,
  type ReadMyNotification,
} from "@pirate/contracts";
import { Effect, Schema } from "effect";

type Page = Schema.Schema.Type<typeof ListMyNotifications.response>;
type ReadResult = Schema.Schema.Type<typeof ReadMyNotification.response>;
export interface NotificationStore {
  readonly list: (input: {
    recipientUserId: string;
    cursor?: string;
  }) => Effect.Effect<Page, BadRequest | InternalError>;
  readonly read: (input: {
    recipientUserId: string;
    notificationId: string;
  }) => Effect.Effect<ReadResult, NotFound | InternalError>;
}

export const listMyNotifications = Effect.fn("listMyNotifications")(function* (
  input: { recipientUserId: string; cursor?: string },
  store: NotificationStore,
) {
  if (!input.recipientUserId.trim())
    return yield* new AuthError({ message: "Authentication required" });
  if (input.cursor !== undefined) {
    yield* Schema.decodeUnknownEffect(NotificationIdV1)(input.cursor).pipe(
      Effect.mapError(() => new BadRequest({ message: "Invalid notification cursor" })),
    );
  }
  return yield* store.list(input);
});

export const readMyNotification = Effect.fn("readMyNotification")(function* (
  input: { recipientUserId: string; notificationId: string },
  store: NotificationStore,
) {
  if (!input.recipientUserId.trim())
    return yield* new AuthError({ message: "Authentication required" });
  yield* Schema.decodeUnknownEffect(NotificationIdV1)(input.notificationId).pipe(
    Effect.mapError(() => new BadRequest({ message: "Invalid notification ID" })),
  );
  return yield* store.read(input);
});
