import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import { InternalError } from "./errors.ts";

/** More qualifying roots fail the read. A partial list would drop live roots. */
export const HNS_NAMESPACE_DISCOVERY_MAX_ROOTS = 256;

/** Lowercase LDH only: letters, digits and inner hyphens, at most 63 octets. */
const HnsNamespaceRootV1 = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u),
);

/** One database instant truncated to milliseconds. */
export const HnsNamespaceInstantV1 = Schema.String.check(
  Schema.isPattern(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u),
);

export const HnsNamespaceEntryV1 = Schema.Struct({
  root: HnsNamespaceRootV1,
  expires_at: HnsNamespaceInstantV1,
});

export const HnsNamespaceDiscoveryV1 = Schema.Struct({
  version: Schema.Literal(1),
  generated_at: HnsNamespaceInstantV1,
  roots: Schema.Array(HnsNamespaceEntryV1).check(
    Schema.isMaxLength(HNS_NAMESPACE_DISCOVERY_MAX_ROOTS),
  ),
}).check(
  Schema.makeFilter((list) =>
    list.roots.every(
      (entry, index) =>
        entry.expires_at > list.generated_at && (list.roots[index - 1]?.root ?? "") < entry.root,
    )
      ? undefined
      : "Expected unique sorted roots that each expire after generation",
  ),
);
export type HnsNamespaceDiscoveryV1 = Schema.Schema.Type<typeof HnsNamespaceDiscoveryV1>;

/**
 * Roots whose current zone Pirate serves, for the Freedom browser's routing only.
 * The list is never trust: native Handshake verification still decides every
 * name. `pirate` is built into the browser and has no zone row here.
 */
export const ListHnsNamespaces = endpoint({
  method: "GET",
  path: "/public/hns/namespaces/v1",
  auth: Auth.public(),
  cacheControl: "private, no-store",
  response: HnsNamespaceDiscoveryV1,
  errors: [InternalError],
});
