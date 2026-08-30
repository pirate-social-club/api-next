import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  HNS_EDGE_ALERT_EMAIL_FROM,
  HNS_EDGE_ALERT_EMAIL_TO,
  type HnsEdgeAlertEmailClient,
  makeCloudflareHnsEdgeAlertSink,
} from "./hns-edge-alert-email.ts";

describe("Cloudflare HNS edge alert email adapter", () => {
  test("pins sender and recipient and waits for provider acceptance", async () => {
    const sent: unknown[] = [];
    const binding: HnsEdgeAlertEmailClient = {
      send: async (message) => {
        sent.push(message);
        return { messageId: "accepted" };
      },
    };

    await Effect.runPromise(
      makeCloudflareHnsEdgeAlertSink(binding).deliver({ text: "zone drift" }),
    );

    expect(sent).toEqual([
      {
        to: HNS_EDGE_ALERT_EMAIL_TO,
        from: { email: HNS_EDGE_ALERT_EMAIL_FROM, name: "Pirate operations" },
        subject: "HNS edge deployment alert",
        text: "zone drift",
      },
    ]);
  });

  test("maps provider rejection to a typed unavailable failure", async () => {
    const binding: HnsEdgeAlertEmailClient = {
      send: () => Promise.reject(new Error("provider detail must not cross the boundary")),
    };

    const result = await Effect.runPromise(
      makeCloudflareHnsEdgeAlertSink(binding).deliver({ text: "zone drift" }).pipe(Effect.flip),
    );

    expect(result.reason).toBe("delivery-unavailable");
    expect(JSON.stringify(result)).not.toContain("provider detail");
  });
});
