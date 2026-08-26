/**
 * @pirate/http-worker — generated route table and transport composition root.
 *
 * Lane A owns this app (api-next 001 §3). Product behavior enters through
 * application use cases; this module does not validate bindings until Worker
 * fetch receives them.
 */
import type { ExecutionContext } from "@cloudflare/workers-types";
import { createProductionHttpWorker, type HttpWorkerBindings } from "./composition.ts";

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
  disabledProductionHnsHostServingComposition,
  makeHnsHostServingComposition,
} from "./hns-host-serving-composition.ts";
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
    cachedProductionApp ??= createProductionHttpWorker(bindings);
    const worker = await cachedProductionApp;
    return worker.fetch(request, bindings, ctx);
  },
};

export default app;
