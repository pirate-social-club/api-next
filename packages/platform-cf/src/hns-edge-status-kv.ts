import {
  HnsEdgeStatusFailed,
  HnsEdgeStatusSnapshotV1,
  type HnsEdgeStatusStore,
} from "@pirate/application/use-cases/hns-edge-status";
import { Effect, Schema } from "effect";

export const HNS_EDGE_STATUS_KV_KEY = "hns-edge-status/jazleeuw/latest/v1" as const;

/** The exact KV capability used by the status adapter. */
export interface HnsEdgeStatusKvNamespace {
  readonly get: (key: string, type: "text") => Promise<string | null>;
  readonly put: (key: string, value: string) => Promise<void>;
}

const decodeSnapshot = Schema.decodeUnknownSync(HnsEdgeStatusSnapshotV1, {
  onExcessProperty: "error",
});

export const makeCloudflareHnsEdgeStatusStore = (
  namespace: HnsEdgeStatusKvNamespace,
): HnsEdgeStatusStore => ({
  load: () =>
    Effect.tryPromise({
      try: async () => {
        const stored = await namespace.get(HNS_EDGE_STATUS_KV_KEY, "text");
        if (stored === null) return null;
        return decodeSnapshot(JSON.parse(stored));
      },
      catch: () => new HnsEdgeStatusFailed({ reason: "storage-unavailable" }),
    }),
  save: (snapshot) =>
    Effect.tryPromise({
      try: () => namespace.put(HNS_EDGE_STATUS_KV_KEY, JSON.stringify(snapshot)),
      catch: () => new HnsEdgeStatusFailed({ reason: "storage-unavailable" }),
    }),
});
