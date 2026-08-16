/**
 * @pirate/http-worker — route table from contracts + HTTP adapter only.
 *
 * Lane A owns this app (api-next 001 §3). Routes are thin from day one:
 * generated from the contracts package, no product handlers in this slice.
 */
import type { ExecutionContext } from "@cloudflare/workers-types";
import { createProductionHttpWorker, type HttpWorkerBindings } from "./composition.ts";

export {
  createProductionHttpWorker,
  type HttpWorkerBindings,
} from "./composition.ts";
export { createHttpWorker, withEndpointResult } from "./transport.ts";

let cachedProductionApp: ReturnType<typeof createProductionHttpWorker> | undefined;

/**
 * Cloudflare supplies bindings to fetch, so configuration is resolved before
 * the first request and cached for the Worker isolate. A failed construction
 * rejects the health-check request before any route can limp into service.
 */
export const app = {
  async fetch(request: Request, bindings: HttpWorkerBindings, ctx: ExecutionContext) {
    cachedProductionApp ??= createProductionHttpWorker(bindings);
    const worker = await cachedProductionApp;
    return worker.fetch(request, bindings, ctx);
  },
};

export default app;
