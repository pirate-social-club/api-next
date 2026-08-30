import {
  HnsEdgeAlertFailed,
  type HnsEdgeAlertSink,
} from "@pirate/application/use-cases/hns-edge-alerts";
import { Effect } from "effect";

export const HNS_EDGE_ALERT_EMAIL_FROM = "alerts@pirate.sc" as const;
export const HNS_EDGE_ALERT_EMAIL_TO = "piratesocialclub@proton.me" as const;

/** Minimal application-facing seam implemented by Cloudflare's generated SendEmail binding. */
export interface HnsEdgeAlertEmailClient {
  readonly send: (message: {
    readonly to: string;
    readonly from: Readonly<{ readonly email: string; readonly name: string }>;
    readonly subject: string;
    readonly text: string;
  }) => Promise<unknown>;
}

/**
 * Dedicated operational-alert adapter. The restricted Worker binding is the
 * final sender/recipient authority; no request value can select either side.
 */
export const makeCloudflareHnsEdgeAlertSink = (
  binding: HnsEdgeAlertEmailClient,
): HnsEdgeAlertSink => ({
  deliver: ({ text }) =>
    Effect.tryPromise({
      try: () =>
        binding
          .send({
            to: HNS_EDGE_ALERT_EMAIL_TO,
            from: { email: HNS_EDGE_ALERT_EMAIL_FROM, name: "Pirate operations" },
            subject: "HNS edge deployment alert",
            text,
          })
          .then(() => undefined),
      catch: () => new HnsEdgeAlertFailed({ reason: "delivery-unavailable" }),
    }),
});
