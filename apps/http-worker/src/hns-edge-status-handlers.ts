import {
  type HnsEdgeStatusFailed,
  makeHnsEdgeStatusService,
} from "@pirate/application/use-cases/hns-edge-status";
import {
  BadRequest,
  Conflict,
  type HnsEdgeStatusReportV1,
  ProviderUnavailable,
} from "@pirate/contracts";
import { Effect } from "effect";
import type { HnsEdgeStatusComposition } from "./hns-edge-status-page.ts";
import type { EndpointHandler } from "./transport.ts";

const wireFailure = (failure: HnsEdgeStatusFailed) => {
  switch (failure.reason) {
    case "invalid-report":
    case "stale-report":
      return new BadRequest({ message: "Invalid HNS edge status report" });
    case "conflicting-report":
      return new Conflict({ message: "HNS edge status report conflicts with stored state" });
    case "storage-unavailable":
      return new ProviderUnavailable({ message: "HNS edge status storage is unavailable" });
  }
};

export const makeHnsEdgeStatusHandlers = (
  composition: Extract<HnsEdgeStatusComposition, { readonly enabled: true }>,
): Readonly<{ PublishHnsEdgeStatusReport: EndpointHandler }> => {
  const service = makeHnsEdgeStatusService({
    store: composition.store,
    clock: composition.clock,
  });
  return {
    PublishHnsEdgeStatusReport: (request) =>
      Effect.runPromise(
        service.publish(request.body as HnsEdgeStatusReportV1).pipe(Effect.mapError(wireFailure)),
      ),
  };
};
