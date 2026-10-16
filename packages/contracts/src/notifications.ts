import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import { AuthError, BadRequest, InternalError, NotFound } from "./errors.ts";

export const NotificationIdV1 = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
);
const ResourceId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
export const NotificationV1 = Schema.Struct({
  notification_id: NotificationIdV1,
  kind: Schema.Literals(["comment_published", "reply_published"]),
  occurred_at: Schema.String,
  read_at: Schema.NullOr(Schema.String),
  target: Schema.Struct({
    kind: Schema.Literal("comment_thread"),
    community_id: ResourceId,
    post_id: ResourceId,
    comment_id: ResourceId,
  }),
});
export type NotificationV1 = Schema.Schema.Type<typeof NotificationV1>;

/** Recipient comes exclusively from the authenticated principal. Fixed page size
 * 20; cursor is an opaque recipient-owned inbox ID, never an account identifier.
 * Target references require the separately reviewed inline navigation resolver.
 */
export const ListMyNotifications = endpoint({
  method: "GET",
  path: "/me/notifications",
  auth: Auth.user(),
  request: { query: Schema.Struct({ cursor: Schema.optional(NotificationIdV1) }) },
  response: Schema.Struct({
    object: Schema.Literal("notification_page"),
    items: Schema.Array(NotificationV1).check(Schema.isMaxLength(20)),
    next_cursor: Schema.NullOr(NotificationIdV1),
    unread_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  errors: [AuthError, BadRequest, InternalError],
});

/** Monotonic set-read. Repeating this command preserves the first read_at.
 * Unknown, foreign and currently inaccessible IDs all return the same 404.
 */
export const ReadMyNotification = endpoint({
  method: "POST",
  path: "/me/notifications/:notificationId/read",
  auth: Auth.user(),
  request: { path: Schema.Struct({ notificationId: NotificationIdV1 }) },
  response: Schema.Struct({ notification_id: NotificationIdV1, read_at: Schema.String }),
  errors: [AuthError, BadRequest, NotFound, InternalError],
});
