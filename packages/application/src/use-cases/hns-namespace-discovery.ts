import {
  HNS_NAMESPACE_DISCOVERY_MAX_ROOTS,
  type HnsNamespaceDiscoveryV1,
  InternalError,
} from "@pirate/contracts";
import { Effect } from "effect";
import { isReservedHnsRoot } from "../hns-reserved-roots.ts";

export type HnsServedRootsV1 = Readonly<{
  generated_at: string;
  roots: HnsNamespaceDiscoveryV1["roots"];
}>;

export interface HnsNamespaceDiscoveryStore {
  /** Every LDH root whose current zone is served, judged at one database instant. */
  servedRoots: () => Effect.Effect<HnsServedRootsV1, InternalError>;
}

/** Any failure, including an over-long list, is an error and never an empty success. */
export const listHnsNamespaces = Effect.fn("listHnsNamespaces")(function* (
  store: HnsNamespaceDiscoveryStore,
) {
  const served = yield* store.servedRoots();
  const roots = served.roots.filter((entry) => !isReservedHnsRoot(entry.root));
  if (roots.length > HNS_NAMESPACE_DISCOVERY_MAX_ROOTS)
    return yield* new InternalError({ message: "HNS namespace discovery exceeds its root bound" });
  return { version: 1 as const, generated_at: served.generated_at, roots };
});
