import { HNS_EDGE_ALERT_TEXT_MAX_BYTES } from "@pirate/contracts";
import { Data, Effect } from "effect";

export class HnsEdgeAlertFailed extends Data.TaggedError("HnsEdgeAlertFailed")<{
  readonly reason: "invalid-text" | "delivery-unavailable";
}> {}

export interface HnsEdgeAlertSink {
  readonly deliver: (input: { readonly text: string }) => Effect.Effect<void, HnsEdgeAlertFailed>;
}

const textEncoder = new TextEncoder();

export const makeHnsEdgeAlertService = (sink: HnsEdgeAlertSink) => ({
  deliver: (input: { readonly text: string }) => {
    const text = input.text.trim();
    if (text.length === 0 || textEncoder.encode(text).byteLength > HNS_EDGE_ALERT_TEXT_MAX_BYTES) {
      return Effect.fail(new HnsEdgeAlertFailed({ reason: "invalid-text" }));
    }
    return sink.deliver({ text });
  },
});
