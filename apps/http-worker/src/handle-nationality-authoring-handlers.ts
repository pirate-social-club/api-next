import {
  type HandleNationalityAuthoringStore,
  type HandleNationalityQualificationStore,
  type HandleSalesFailure,
  IdGen,
  makeHandleNationalityAuthoringService,
} from "@pirate/application/use-cases/handles/sales";
import { Effect } from "effect";
import { accountId, wireFailure } from "./handle-sales-handlers.ts";
import { type EndpointHandler, withEndpointResult } from "./transport.ts";

export function makeHandleNationalityAuthoringHandlers(
  services: Readonly<{
    store: HandleNationalityAuthoringStore;
    qualification?: HandleNationalityQualificationStore;
    ids: IdGen["Service"];
  }>,
): Readonly<Record<string, EndpointHandler>> {
  const authoring = makeHandleNationalityAuthoringService(services.store);
  const run = <A>(effect: Effect.Effect<A, HandleSalesFailure, IdGen>) =>
    Effect.runPromise(
      effect.pipe(Effect.provideService(IdGen, services.ids), Effect.mapError(wireFailure)),
    );
  return {
    ...(services.qualification === undefined
      ? {}
      : {
          GetHandleNationalityQualification: (request: Parameters<EndpointHandler>[0]) =>
            run(
              services.qualification!.getProgress({
                accountId: accountId(request.principal),
                intentId: (request.params as { intentId: string }).intentId,
              }),
            ),
        }),
    GetHandleNationalityAuthoring: (request) => {
      const path = request.params as { communityId: string };
      return run(
        authoring.getContext({
          accountId: accountId(request.principal),
          communityId: path.communityId,
        }),
      );
    },
    CreateHandleNationalityQualificationPolicy: async (request) => {
      const path = request.params as { communityId: string };
      const body = request.body as {
        idempotency_key: string;
        authoring_reference: string;
        allowed_countries: readonly string[];
      };
      const result = await run(
        authoring.createPolicy({
          accountId: accountId(request.principal),
          communityId: path.communityId,
          idempotencyKey: body.idempotency_key,
          authoringReference: body.authoring_reference,
          allowedCountries: body.allowed_countries,
        }),
      );
      return withEndpointResult(result, result.replayed ? 200 : 201);
    },
  };
}
