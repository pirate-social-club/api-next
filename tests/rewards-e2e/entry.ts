import type { ExecutionContext } from "@cloudflare/workers-types";
import { makeVerificationProviderRegistry } from "@pirate/application/verification";
import { Effect } from "effect";
import { databaseSqlRoleSha256 } from "#rewards-e2e-pins";
import {
  createProductionHttpWorker,
  type HttpWorkerBindings,
} from "../../apps/http-worker/src/composition.ts";
import normalWorker from "../../apps/http-worker/src/index.ts";
import { makeRetryingPromiseCache } from "../../apps/http-worker/src/production-app-cache.ts";
import { makeIsolatedRewardClaimProvider, simulatedClaimLabel } from "./claim-provider.ts";
import { isIsolatedRequest } from "./resource-boundary.ts";

export {
  HnsForwarderReplayStoreDO,
  KaraokeAttemptDO,
  RegistrationApplicationRateLimiterDO,
  RegistrationIpRateLimiterDO,
  StudyGenerationWorkflow,
  VideoPlaybackRateLimiterDO,
} from "../../apps/http-worker/src/index.ts";

const isolatedApp = makeRetryingPromiseCache(async (bindings: HttpWorkerBindings) => {
  const registry = await Effect.runPromise(
    makeVerificationProviderRegistry([makeIsolatedRewardClaimProvider()], { now: Date.now }),
  );
  return createProductionHttpWorker(bindings, { verification_registry: registry });
});

export default {
  async fetch(request: Request, bindings: HttpWorkerBindings, context: ExecutionContext) {
    if (!(await isIsolatedRequest(request, bindings, databaseSqlRoleSha256))) {
      return new Response("Isolated Rewards resource identity mismatch", { status: 503 });
    }
    if (new URL(request.url).pathname.startsWith("/karaoke/realtime/")) {
      return normalWorker.fetch(request, bindings, context);
    }
    const app = await isolatedApp(bindings);
    const response = await app.fetch(request, bindings, context);
    const headers = new Headers(response.headers);
    headers.set("X-Rewards-E2E-Verification", simulatedClaimLabel);
    return new Response(response.body, { status: response.status, headers });
  },
};
