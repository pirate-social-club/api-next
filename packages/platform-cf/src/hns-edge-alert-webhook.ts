import {
  HnsEdgeAlertFailed,
  type HnsEdgeAlertSink,
} from "@pirate/application/use-cases/hns-edge-alerts";
import { Effect } from "effect";

export type HnsAlertFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Operator-owned endpoint; no request value can choose its destination. */
export function makeHnsEdgeWebhookAlertSink(
  destination: string,
  fetchImpl: HnsAlertFetch = fetch,
): HnsEdgeAlertSink {
  let url: URL;
  try {
    url = new URL(destination);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "")
      throw new Error();
  } catch {
    throw new Error("HNS webhook configuration invalid");
  }
  return {
    deliver: ({ text }) =>
      Effect.tryPromise({
        try: async (signal) => {
          const response = await fetchImpl(url, {
            method: "POST",
            redirect: "error",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
          });
          await response.body?.cancel();
          if (!response.ok) throw new Error();
        },
        catch: () => new HnsEdgeAlertFailed({ reason: "delivery-unavailable" }),
      }),
  };
}
