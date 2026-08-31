import {
  type HnsEdgeAlertFailed,
  type HnsEdgeAlertSink,
  makeHnsEdgeAlertService,
} from "@pirate/application/use-cases/hns-edge-alerts";
import type { HnsEdgeAlertRequest } from "@pirate/contracts";
import { BadRequest, ProviderUnavailable } from "@pirate/contracts";
import { Effect } from "effect";
import type { EndpointHandler } from "./transport.ts";

const wireFailure = (failure: HnsEdgeAlertFailed) =>
  failure.reason === "invalid-text"
    ? new BadRequest({ message: "Invalid HNS edge alert" })
    : new ProviderUnavailable({ message: "HNS edge alert delivery is unavailable" });

export const makeHnsEdgeAlertHandlers = (
  sink: HnsEdgeAlertSink,
): Readonly<{
  DeliverHnsEdgeAlert: EndpointHandler;
}> => {
  const service = makeHnsEdgeAlertService(sink);
  return {
    DeliverHnsEdgeAlert: (request) =>
      Effect.runPromise(
        service.deliver(request.body as HnsEdgeAlertRequest).pipe(
          Effect.map(() => ({ accepted: true as const })),
          Effect.mapError(wireFailure),
        ),
      ),
  };
};
