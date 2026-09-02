import {
  ACCOUNT_ERASURE_OWNERS,
  type AccountErasureWorkflowResult,
  type AccountErasureWorkflowStore,
  assertAccountErasureProgress,
} from "@pirate/application/use-cases/account-erasure-orchestration";
import type { CloudflareWorkflowStepDo } from "@pirate/platform-cf/cloudflare-orchestration-primitives";

export type AccountErasureWorkflowPayload = Readonly<{
  erasure_request_id: string;
}>;

const ACCOUNT_ERASURE_STEP_OPTIONS = {
  retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
  timeout: "15 minutes",
} as const;

export interface AccountErasureWorkflowStep
  extends CloudflareWorkflowStepDo<typeof ACCOUNT_ERASURE_STEP_OPTIONS> {}

export type AccountErasureWorkflowComposition = Readonly<{
  store: AccountErasureWorkflowStore;
}>;

export const makeAccountErasureWorkflowRunner =
  <Env>(resolve: (env: Env) => AccountErasureWorkflowComposition) =>
  async (
    env: Env,
    event: Readonly<{ payload: AccountErasureWorkflowPayload; instanceId: string }>,
    step: AccountErasureWorkflowStep,
  ): Promise<AccountErasureWorkflowResult> => {
    const { erasure_request_id: erasureRequestId } = event.payload;
    const { store } = resolve(env);
    const claim = await step.do("account-erasure-claim", ACCOUNT_ERASURE_STEP_OPTIONS, () =>
      store.claim(erasureRequestId),
    );
    if (claim.outcome === "terminal") {
      return { erasureRequestId, status: claim.status };
    }

    for (const owner of ACCOUNT_ERASURE_OWNERS) {
      let sequence = 0;
      while (true) {
        const result = await step.do(
          `account-erasure-${owner}-${sequence}`,
          ACCOUNT_ERASURE_STEP_OPTIONS,
          () => store.drainOwner({ erasureRequestId, owner }),
        );
        if (result.outcome === "terminal") break;
        if (result.outcome === "paused") {
          return { erasureRequestId, status: result.status };
        }
        assertAccountErasureProgress(result);
        sequence += 1;
      }
    }

    return step.do("account-erasure-complete", ACCOUNT_ERASURE_STEP_OPTIONS, () =>
      store.complete(erasureRequestId),
    );
  };
