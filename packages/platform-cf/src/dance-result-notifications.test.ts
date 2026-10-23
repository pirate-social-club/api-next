import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import {
  ControlPlaneDb,
  type ControlPlaneStatement,
  type ControlPlaneTransaction,
  ControlPlaneTransactionOutcomeUnknown,
} from "../../application/src/ports.ts";
import { makeNotificationDeliveryStoreFromDb } from "./notification-delivery-repository.ts";
import { makeControlPlaneNotificationStore } from "./notifications-repository.ts";

/** Bounded packet driver only; no SQL execution, source publication or resources. */
function fixture(options: { unknownCommit?: boolean; own?: boolean } = {}) {
  const statements: ControlPlaneStatement[] = [];
  const id = "00000000-0000-4000-8000-000000000001";
  const item = {
    notification_id: id,
    kind: "dance_review_result",
    outcome: "passed",
    occurred_at: "2026-10-21T18:00:00.000000Z",
    read_at: null,
    target: { kind: "private_dance_result", community_id: "community", review_id: "review" },
  } as const;
  const execute: ControlPlaneTransaction["execute"] = <Row>(s: ControlPlaneStatement) =>
    Effect.sync(() => {
      statements.push(s);
      let rows: unknown[];
      switch (s.label) {
        case "notifications.list":
          rows = [
            {
              cursor_valid: true,
              document: {
                object: "notification_page",
                items: [item],
                next_cursor: null,
                unread_count: 1,
              },
            },
          ];
          break;
        case "notifications.recover.facts":
          rows = [{ outbox_event_id: "dance-result:review" }];
          break;
        case "notifications.deliver":
          rows = [{ result: { processed: true, delivered: true } }];
          break;
        case "notifications.read":
          rows =
            options.own === false
              ? []
              : [{ notification_id: id, read_at: "2026-10-21T18:01:00.000000Z" }];
          break;
        default:
          throw new Error(`Unexpected SQL ${s.label}`);
      }
      return { rows: rows as Row[], rowCount: rows.length };
    });
  const db = ControlPlaneDb.of({
    execute,
    withTransaction: (use) =>
      Effect.gen(function* () {
        const result = yield* use({ execute });
        if (options.unknownCommit)
          return yield* new ControlPlaneTransactionOutcomeUnknown({
            phase: "commit",
            label: "COMMIT",
            limitMs: 100,
            elapsedMs: 100,
          });
        return result;
      }),
  });
  return {
    statements,
    id,
    item,
    store: makeControlPlaneNotificationStore(Layer.succeed(ControlPlaneDb, db)),
    delivery: makeNotificationDeliveryStoreFromDb(db),
  };
}

describe("Dance terminal facts use the existing private inbox/recovery consumers", () => {
  test("list/mark-read preserve private recipient binding and current source visibility", async () => {
    const f = fixture();
    expect((await Effect.runPromise(f.store.list({ recipientUserId: "dancer" }))).items).toEqual([
      f.item,
    ]);
    await Effect.runPromise(f.store.read({ recipientUserId: "dancer", notificationId: f.id }));
    expect(f.statements.every((s) => s.values[0] === "dancer")).toBe(true);
    expect(f.statements.every((s) => s.text.includes("readable_recipient_notification_v2"))).toBe(
      true,
    );
    const foreign = fixture({ own: false });
    await expect(
      Effect.runPromise(foreign.store.read({ recipientUserId: "other", notificationId: f.id })),
    ).rejects.toMatchObject({ _tag: "NotFound" });
  });
  test("bounded recovery consumes real Dance and comment fact families through one dispatch", async () => {
    const f = fixture();
    expect(await Effect.runPromise(f.delivery.recover())).toEqual({
      examined: 1,
      processed: 1,
      delivered: 1,
      suppressed: 0,
    });
    expect(f.statements.map((s) => s.label)).toEqual([
      "notifications.recover.facts",
      "notifications.deliver",
    ]);
    expect(f.statements[0]?.text).toBe(
      "SELECT outbox_event_id FROM pending_recipient_notifications_v2() LIMIT 50",
    );
    expect(f.statements[1]?.text).toBe("SELECT deliver_recipient_notification_v2($1) AS result");
    expect(f.statements[1]?.values).toEqual(["dance-result:review"]);
    expect(f.statements.some((s) => /qualification|verdict|payout/.test(s.text))).toBe(false);
  });
  test("unknown delivery COMMIT escapes without retry, additional fact or claimed completion", async () => {
    const f = fixture({ unknownCommit: true });
    await expect(
      Effect.runPromise(f.delivery.deliver({ sourceEventId: "dance-result:review" })),
    ).rejects.toMatchObject({ _tag: "ControlPlaneTransactionOutcomeUnknown", phase: "commit" });
    expect(f.statements).toHaveLength(1);
  });
});
