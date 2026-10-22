import {
  type HnsNamespaceDiscoveryStore,
  listHnsNamespaces,
} from "@pirate/application/use-cases/hns-namespace-discovery";
import { Effect } from "effect";
import type { EndpointHandler } from "./transport.ts";

/** Each request reads current zone authority; nothing is memoized in the isolate. */
export function makeHnsNamespaceDiscoveryHandlers(
  store: HnsNamespaceDiscoveryStore,
): Readonly<Record<"ListHnsNamespaces", EndpointHandler>> {
  return {
    ListHnsNamespaces: () => Effect.runPromise(listHnsNamespaces(store)),
  };
}
