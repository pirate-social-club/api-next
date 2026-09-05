import type { HyperdriveConnection } from "@pirate/platform-cf/postgres";
import {
  makeVideoSourceGateway,
  type VideoSourceBucket,
  type VideoSourceGatewayLogEvent,
  type VideoSourceGrantResolver,
} from "@pirate/platform-cf/video-source-gateway";

export type VideoSourceGatewayEnv = Readonly<{
  CONTROL_PLANE: HyperdriveConnection;
  MEDIA_IMMUTABLE_ORIGINALS: VideoSourceBucket;
}>;

type GatewayEvent =
  | VideoSourceGatewayLogEvent
  | Readonly<{
      event: "source_unavailable";
      status: 503;
    }>;

/** Resolver injection is the sole test seam; no test binding or write route. */
export function makeVideoSourceGatewayWorker(
  resolver?: (env: VideoSourceGatewayEnv) => VideoSourceGrantResolver,
) {
  return {
    async fetch(request: Request, env: VideoSourceGatewayEnv): Promise<Response> {
      const log = (event: GatewayEvent) => console.log(JSON.stringify(event));
      try {
        return await makeVideoSourceGateway({
          bucket: env.MEDIA_IMMUTABLE_ORIGINALS,
          grants: {
            resolve: async (capability) => {
              // The durable resolver lands with the reserved grant migration.
              // A deployment of this checkpoint cannot serve fixture grants.
              if (resolver === undefined) throw new Error("source resolver unavailable");
              return resolver(env).resolve(capability);
            },
          },
          now: Date.now,
          logger: log,
        })(request);
      } catch {
        // Never stringify dependency exceptions: they may contain SQL or URLs.
        log({ event: "source_unavailable", status: 503 });
        return new Response(null, {
          status: 503,
          headers: { "cache-control": "private, no-store" },
        });
      }
    },
  };
}

export default makeVideoSourceGatewayWorker();
