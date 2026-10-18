import type { PublicPostRouteResultV1 } from "@pirate/contracts";
import type { Effect } from "effect";

export type VideoDetailSelector =
  | Readonly<{ kind: "post_id"; value: string }>
  | Readonly<{ kind: "alias"; value: string }>;
export type VideoDetailSnapshot =
  | Readonly<{ kind: "not_video" }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "result"; result: PublicPostRouteResultV1 }>;

/** The implementation must project and classify authorization in one SQL statement. */
export interface VideoDetailStore {
  readonly read: (
    input: Readonly<{
      selector: VideoDetailSelector;
      viewerUserId?: string;
      locale?: string;
    }>,
  ) => Effect.Effect<VideoDetailSnapshot, unknown>;
}
