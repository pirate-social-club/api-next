// Historical api-next notification fixture for the populated274-to275 rehearsal only.
// Bound to d032109b1ded8d0d83b9038a129c6506221354f2 packages/platform-cf/src/notifications-repository.ts
// Original source SHA256 fb6792987b8453d0af2ee920aad42a1fab04d1489e9c6b3e29ccfcbc3d48f651.
// No production fallback, schema detection or later migration is introduced.
import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import type { NotificationStore } from "@pirate/application/use-cases/notifications";
import {
  BadRequest,
  InternalError,
  ListMyNotifications,
  NotFound,
  NotificationIdV1,
  ReadMyNotification,
} from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";
import { makeVideoOrderingHistoricalNotificationDeliveryStore } from "./notifications-video-historical-delivery.pg-fixture.ts";

const NOTIFICATION_PAGE_SQL = `WITH anchor AS MATERIALIZED (
  SELECT delivery_order FROM notification_inbox WHERE recipient_user_id=$1 AND notification_id=$2
), page AS MATERIALIZED (
  SELECT inbox.notification_id,inbox.delivery_order,inbox.read_at,source.*
  FROM notification_inbox inbox
  CROSS JOIN LATERAL (
    SELECT * FROM readable_notification_source_v1($1,inbox.source_event_id) LIMIT 1
  ) source
  WHERE inbox.recipient_user_id=$1
    AND ($2::text IS NULL OR inbox.delivery_order<(SELECT delivery_order FROM anchor))
  ORDER BY inbox.delivery_order DESC LIMIT 21
), shown AS (SELECT * FROM page ORDER BY delivery_order DESC LIMIT 20)
SELECT ($2::text IS NULL OR EXISTS(SELECT 1 FROM anchor)) AS cursor_valid,
  jsonb_build_object('object','notification_page',
    'items',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'notification_id',notification_id,'kind',CASE WHEN parent_comment_id IS NULL THEN 'comment_published' ELSE 'reply_published' END,
      'occurred_at',to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'read_at',CASE WHEN read_at IS NULL THEN NULL ELSE to_char(read_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
      'target',jsonb_build_object('kind','comment_thread','community_id',community_id,'post_id',post_id,'comment_id',comment_id))
      ORDER BY delivery_order DESC) FROM shown),'[]'::jsonb),
    'next_cursor',CASE WHEN (SELECT count(*) FROM page)>20 THEN
      (SELECT notification_id FROM shown ORDER BY delivery_order LIMIT 1) ELSE NULL END,
    'unread_count',(SELECT count(*) FROM notification_inbox unread
      WHERE unread.recipient_user_id=$1 AND unread.read_at IS NULL
        AND EXISTS(SELECT 1 FROM readable_notification_source_v1($1,unread.source_event_id)))) AS document`;

const unavailable = (cause?: unknown) =>
  new InternalError({ message: "Notifications unavailable", cause });

export function makeVideoOrderingHistoricalNotificationStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError>,
) {
  const list: NotificationStore["list"] = Effect.fn("NotificationStore.list")(
    function* (input) {
      if (input.cursor !== undefined)
        yield* Schema.decodeUnknownEffect(NotificationIdV1)(input.cursor).pipe(
          Effect.mapError(() => new BadRequest({ message: "Invalid notification cursor" })),
        );
      const db = yield* ControlPlaneDb;
      const result = yield* db.withTransaction((tx) =>
        tx.execute({
          label: "notifications.list",
          text: NOTIFICATION_PAGE_SQL,
          values: [input.recipientUserId, input.cursor ?? null],
          readonly: true,
        }),
      );
      const row = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ cursor_valid: Schema.Boolean, document: Schema.Unknown }),
      )(result.rows[0]);
      if (!row.cursor_valid)
        return yield* new BadRequest({ message: "Invalid notification cursor" });
      return yield* Schema.decodeUnknownEffect(ListMyNotifications.response, {
        onExcessProperty: "error",
      })(row.document);
    },
    Effect.provide(runtime),
    Effect.mapError((error) => (error instanceof BadRequest ? error : unavailable(error))),
  );

  const read: NotificationStore["read"] = Effect.fn("NotificationStore.read")(
    function* (input) {
      const db = yield* ControlPlaneDb;
      const result = yield* db.withTransaction((tx) =>
        tx.execute({
          label: "notifications.read",
          text: `UPDATE notification_inbox inbox SET read_at=COALESCE(inbox.read_at,clock_timestamp())
        WHERE inbox.recipient_user_id=$1 AND inbox.notification_id=$2
          AND EXISTS(SELECT 1 FROM readable_notification_source_v1($1,inbox.source_event_id))
        RETURNING notification_id,to_char(read_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS read_at`,
          values: [input.recipientUserId, input.notificationId],
          readonly: false,
        }),
      );
      if (result.rows.length === 0)
        return yield* new NotFound({ message: "Notification not found" });
      if (result.rows.length !== 1) return yield* unavailable();
      return yield* Schema.decodeUnknownEffect(ReadMyNotification.response)(result.rows[0]);
    },
    Effect.provide(runtime),
    Effect.mapError((error) => (error instanceof NotFound ? error : unavailable(error))),
  );

  return { list, read, ...makeVideoOrderingHistoricalNotificationDeliveryStore(runtime) };
}
