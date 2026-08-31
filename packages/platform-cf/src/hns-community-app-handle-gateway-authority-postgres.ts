import type { HnsForwarderGatewayAuthoritySourceV1 } from "@pirate/application/hns-host-serving";
import { Effect } from "effect";
import { makeSerializedCoalescingHnsGatewayAuthoritySourceV1 } from "./hns-community-app-gateway-authority-postgres.ts";
import { makeControlPlaneHnsHandlePersonaHostAuthoritySource } from "./hns-handle-host-authority-repository.ts";
import { makeControlPlaneHnsCommunityAppHostAuthoritySource } from "./hns-host-persistence-repository.ts";
import {
  makeReadOnlyPostgresControlPlaneLayer,
  type PostgresControlPlaneOptions,
} from "./postgres.ts";

const COMMUNITY_READINESS_HOST = "app.-pirate-readiness-invalid";
const HANDLE_READINESS_HOST = "-pirate-readiness-invalid.-pirate-readiness-invalid";

export type HnsCommunityAppHandleGatewayPostgresAuthorityV1 = Readonly<{
  community_authority_source: HnsForwarderGatewayAuthoritySourceV1;
  handle_authority_source: HnsForwarderGatewayAuthoritySourceV1;
  ready: (signal?: AbortSignal) => Promise<boolean>;
}>;

/**
 * The combined VPS process receives two narrow readers over the same
 * server-enforced read-only credential. Neither source exposes a write seam.
 */
export function makePostgresHnsCommunityAppHandleGatewayAuthorityV1(
  connectionString: string,
  options?: PostgresControlPlaneOptions,
): HnsCommunityAppHandleGatewayPostgresAuthorityV1 {
  const runtime = makeReadOnlyPostgresControlPlaneLayer(connectionString, options);
  const communityAuthority = makeSerializedCoalescingHnsGatewayAuthoritySourceV1(
    makeControlPlaneHnsCommunityAppHostAuthoritySource(runtime, {
      authority_schema: "api_next",
    }),
  );
  const handleAuthority = makeSerializedCoalescingHnsGatewayAuthoritySourceV1(
    makeControlPlaneHnsHandlePersonaHostAuthoritySource(runtime),
  );
  return Object.freeze({
    community_authority_source: communityAuthority,
    handle_authority_source: handleAuthority,
    ready: async (signal) => {
      try {
        const [community, handle] = await Promise.all([
          Effect.runPromise(communityAuthority.resolve(COMMUNITY_READINESS_HOST), { signal }),
          Effect.runPromise(handleAuthority.resolve(HANDLE_READINESS_HOST), { signal }),
        ]);
        return community === null && handle === null;
      } catch {
        return false;
      }
    },
  });
}
