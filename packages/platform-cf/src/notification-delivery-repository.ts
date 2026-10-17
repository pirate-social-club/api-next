import {
  ControlPlaneAcquireFailed,
  ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneOperationTimedOut,
  ControlPlaneStatementFailed,
  ControlPlaneTransactionOutcomeUnknown,
} from "@pirate/application";
import { InternalError } from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";

export const NOTIFICATION_RECOVERY_FACTS_SQL = `SELECT fact.outbox_event_id FROM content_publication_outbox fact
  WHERE fact.event_type='comment_notification' AND NOT fact.inbox_delivery_recorded
  ORDER BY fact.created_at,fact.outbox_event_id LIMIT 50`;

const Delivery = Schema.Struct({ processed: Schema.Boolean, delivered: Schema.Boolean });
const failed = (cause: unknown) =>
  cause instanceof ControlPlaneAcquireFailed ||
  cause instanceof ControlPlaneOperationTimedOut ||
  cause instanceof ControlPlaneStatementFailed ||
  cause instanceof ControlPlaneTransactionOutcomeUnknown
    ? cause
    : new InternalError({ message: "Notification delivery unavailable", cause });

export function makeNotificationDeliveryStoreFromDb(db: ControlPlaneDb["Service"]) {
  const deliver = Effect.fn("NotificationDeliveryStore.deliver")(function* (input: {
    sourceEventId: string;
  }) {
    const rows = yield* db.withTransaction((tx) =>
      tx.execute<{ result: unknown }>({
        label: "notifications.deliver",
        text: "SELECT deliver_comment_notification_v1($1) AS result",
        values: [input.sourceEventId],
        readonly: false,
      }),
    );
    return yield* Schema.decodeUnknownEffect(Delivery)(rows.rows[0]?.result);
  }, Effect.mapError(failed));
  const recover = Effect.fn("NotificationDeliveryStore.recover")(function* () {
    const rows = yield* db.withTransaction((tx) =>
      tx.execute({
        label: "notifications.recover.facts",
        text: NOTIFICATION_RECOVERY_FACTS_SQL,
        values: [],
        readonly: true,
      }),
    );
    const facts = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ outbox_event_id: Schema.String })).check(Schema.isMaxLength(50)),
    )(rows.rows);
    let processed = 0;
    let delivered = 0;
    for (const fact of facts) {
      // Each fact commits independently. There is no time watermark, lossy
      // queue acknowledgement or multi-recipient lock cycle across a batch.
      const result = yield* deliver({ sourceEventId: fact.outbox_event_id });
      if (result.processed) {
        processed++;
        if (result.delivered) delivered++;
      }
    }
    return { examined: facts.length, processed, delivered, suppressed: processed - delivered };
  }, Effect.mapError(failed));
  return { deliver, recover };
}

export function makeControlPlaneNotificationDeliveryStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError>,
) {
  return {
    deliver: Effect.fn("ControlPlaneNotificationDeliveryStore.deliver")(
      function* (input: { sourceEventId: string }) {
        return yield* makeNotificationDeliveryStoreFromDb(yield* ControlPlaneDb).deliver(input);
      },
      Effect.provide(runtime),
      Effect.mapError(failed),
    ),
    recover: Effect.fn("ControlPlaneNotificationDeliveryStore.recover")(
      function* () {
        return yield* makeNotificationDeliveryStoreFromDb(yield* ControlPlaneDb).recover();
      },
      Effect.provide(runtime),
      Effect.mapError(failed),
    ),
  };
}
