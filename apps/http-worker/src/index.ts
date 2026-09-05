/**
 * @pirate/http-worker — generated route table and transport composition root.
 *
 * Lane A owns this app (api-next 001 §3). Product behavior enters through
 * application use cases; this module does not validate bindings until Worker
 * fetch receives them.
 */

import type { ExecutionContext } from "@cloudflare/workers-types";
import { httpRequestDiagnostics } from "@pirate/platform-cf/worker-request-diagnostics";
import { createProductionHttpWorker, type HttpWorkerBindings } from "./composition.ts";

export { HnsForwarderReplayStoreDO } from "@pirate/platform-cf/hns-forwarder-replay-store-do";
export { KaraokeAttemptDO } from "@pirate/platform-cf/karaoke-attempt-do";
export {
  RegistrationApplicationRateLimiterDO,
  RegistrationIpRateLimiterDO,
} from "@pirate/platform-cf/registration-rate-limiter-do";
export { makeActivityQualificationHandlers } from "./activity-qualification-handlers.ts";
export { makeCanonicalCommunityRouteHandlers } from "./canonical-community-route-handlers.ts";
export { makeCommunityPurchaseFundingHandlers } from "./community-purchase-funding-handlers.ts";
export {
  createProductionHttpWorker,
  type HttpWorkerBindings,
  type HttpWorkerCompositionDependencies,
} from "./composition.ts";
export {
  disabledProductionHnsCommunityAppApiComposition,
  type HnsCommunityAppApiComposition,
  type HnsCommunityAppApiCompositionDependencies,
  makeHnsCommunityAppApiComposition,
} from "./hns-community-app-api-composition.ts";
export {
  HNS_FORWARDER_V3_KEY_REGISTRY_MAX_BYTES,
  HNS_FORWARDER_V3_KEY_REGISTRY_SCHEMA,
  makeProductionHnsCommunityAppApiComposition,
} from "./hns-community-app-api-production-composition.ts";
export {
  disabledProductionHnsHandleHostApiComposition,
  type HnsHandleHostApiComposition,
  type HnsHandleHostApiCompositionDependencies,
  makeHnsHandleHostApiComposition,
} from "./hns-handle-host-api-composition.ts";
export {
  disabledProductionHnsHostServingComposition,
  makeHnsHostServingComposition,
} from "./hns-host-serving-composition.ts";
export { makePlatformPirateHandleHandlers } from "./platform-pirate-handle-handlers.ts";
export { makePublicPostRouteHandlers } from "./public-post-route-handlers.ts";
export { StudyGenerationWorkflow } from "./study-generation-entrypoint.ts";
export { makeStudyV2Handlers } from "./study-v2-handlers.ts";
export { createHttpWorker, withEndpointResult } from "./transport.ts";

let cachedProductionApp: ReturnType<typeof createProductionHttpWorker> | undefined;

/**
 * Cloudflare supplies bindings only to fetch, so true pre-serve validation is
 * unavailable to this module. Configuration and composition are therefore
 * validated lazily on the first request and cached for the isolate; missing
 * configuration fails that health-check request before any route is served.
 */
export const app = {
  async fetch(request: Request, bindings: HttpWorkerBindings, ctx: ExecutionContext) {
    return httpRequestDiagnostics.run(bindings.CF_VERSION_METADATA?.id ?? null, async () => {
      const realtimeMatch = new URL(request.url).pathname.match(/^\/karaoke\/realtime\/([^/]+)$/u);
      if (realtimeMatch !== null) {
        const encodedSessionId = realtimeMatch[1];
        if (encodedSessionId === undefined || bindings.KARAOKE_ATTEMPT === undefined) {
          return new Response("Not found", { status: 404 });
        }
        let sessionId: string;
        try {
          sessionId = decodeURIComponent(encodedSessionId);
        } catch {
          return new Response("Bad request", { status: 400 });
        }
        return bindings.KARAOKE_ATTEMPT.getByName(sessionId).fetch(request);
      }
      cachedProductionApp ??= createProductionHttpWorker(bindings);
      const worker = await cachedProductionApp;
      return worker.fetch(request, bindings, ctx);
    });
  },
};

export default app;
