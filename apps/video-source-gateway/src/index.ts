import {
  type HyperdriveConnection,
  makeReadOnlyPostgresControlPlaneLayer,
} from "@pirate/platform-cf/postgres";
import {
  makeVideoSourceGateway,
  type VideoSourceBucket,
  type VideoSourceGatewayLogEvent,
  type VideoSourceGrantResolver,
} from "@pirate/platform-cf/video-source-gateway";
import { makeVideoSourceGrantResolver } from "@pirate/platform-cf/video-source-grant-resolver";

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
  resolver: (env: VideoSourceGatewayEnv) => VideoSourceGrantResolver = (env) =>
    makeVideoSourceGrantResolver(
      makeReadOnlyPostgresControlPlaneLayer(env.CONTROL_PLANE.connectionString, {
        logger: { info: () => {}, error: () => {} },
      }),
    ),
) {
  return {
    async fetch(request: Request, env: VideoSourceGatewayEnv): Promise<Response> {
      const log = (event: GatewayEvent) => console.log(JSON.stringify(event));
      try {
        return await makeVideoSourceGateway({
          bucket: env.MEDIA_IMMUTABLE_ORIGINALS,
          grants: {
            resolve: async (capability) => {
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
