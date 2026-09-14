import type {
  HandleNationalityAuthoringContextV1,
  HandleNationalityPolicyAuthoredV1,
} from "@pirate/contracts";
import { Effect } from "effect";
import { IdGen } from "../ports.ts";
import type { HandleSalesFailure } from "./sales.ts";

type ActorCommunity = Readonly<{ accountId: string; communityId: string }>;
export type CreateHandleNationalityPolicyInput = ActorCommunity &
  Readonly<{
    idempotencyKey: string;
    authoringReference: string;
    allowedCountries: readonly string[];
  }>;

export type HandleNationalityAuthoringStore = Readonly<{
  getContext: (
    input: ActorCommunity,
  ) => Effect.Effect<HandleNationalityAuthoringContextV1, HandleSalesFailure>;
  createPolicy: (
    input: CreateHandleNationalityPolicyInput & Readonly<{ policyId: string; actionId: string }>,
  ) => Effect.Effect<HandleNationalityPolicyAuthoredV1, HandleSalesFailure>;
}>;

export function makeHandleNationalityAuthoringService(store: HandleNationalityAuthoringStore) {
  return {
    getContext: store.getContext,
    createPolicy: (input: CreateHandleNationalityPolicyInput) =>
      Effect.gen(function* () {
        const ids = yield* IdGen;
        const policyId = `nationality_policy_${yield* ids.next}`;
        const actionId = `nationality_policy_action_${yield* ids.next}`;
        return yield* store.createPolicy({ ...input, policyId, actionId });
      }),
  };
}
