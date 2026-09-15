/**
 * @pirate/http-worker — generated route table and transport composition root.
 *
 * Lane A owns this app (api-next 001 §3). Product behavior enters through
 * application use cases; this module does not validate bindings until Worker
 * fetch receives them.
 */

import type { ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import { httpRequestDiagnostics } from "@pirate/platform-cf/worker-request-diagnostics";
import { createProductionHttpWorker, type HttpWorkerBindings } from "./composition.ts";
import { makeRetryingPromiseCache } from "./production-app-cache.ts";

// The Worker module exports only its default handler and runtime entrypoint classes.
export { HnsForwarderReplayStoreDO } from "@pirate/platform-cf/hns-forwarder-replay-store-do";
export { KaraokeAttemptDO } from "@pirate/platform-cf/karaoke-attempt-do";
export { KaraokeResetOperatorEntrypoint } from "@pirate/platform-cf/karaoke-reset-operator-entrypoint";
export {
  RegistrationApplicationRateLimiterDO,
  RegistrationIpRateLimiterDO,
} from "@pirate/platform-cf/registration-rate-limiter-do";
export { VideoPlaybackRateLimiterDO } from "@pirate/platform-cf/video-playback-rate-limiter-do";
export { StudyGenerationWorkflow } from "./study-generation-entrypoint.ts";

const productionApp = makeRetryingPromiseCache(createProductionHttpWorker);

/**
 * Cloudflare supplies bindings only to fetch, so true pre-serve validation is
 * unavailable to this module. Configuration and composition are therefore
 * validated lazily on the first request and successful composition is cached
 * for the isolate; rejected composition attempts are discarded so a later
 * request can retry while mandatory configuration still fails closed.
 */
const app = {
  async scheduled(
    _event: ScheduledController,
    bindings: HttpWorkerBindings,
    _ctx: ExecutionContext,
  ) {
    const worker = await productionApp(bindings);
    await worker.continuePublicationChecks();
  },
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
      const worker = await productionApp(bindings);
      return worker.fetch(request, bindings, ctx);
    });
  },
};

export default app;
