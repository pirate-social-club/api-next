import type { HnsForwarderGatewayAuthoritySourceV1 } from "@pirate/application/hns-host-serving";
import { Effect } from "effect";
import { makeControlPlaneHnsCommunityAppHostAuthoritySource } from "./hns-host-persistence-repository.ts";
import {
  makeReadOnlyPostgresControlPlaneLayer,
  type PostgresControlPlaneOptions,
} from "./postgres.ts";

export const HNS_COMMUNITY_APP_GATEWAY_AUTHORITY_READINESS_HOST =
  "app.-pirate-readiness-invalid" as const;

export type HnsCommunityAppGatewayPostgresAuthorityV1 = Readonly<{
  authority_source: HnsForwarderGatewayAuthoritySourceV1;
  ready: (signal?: AbortSignal) => Promise<boolean>;
}>;

/**
 * The VPS gateway receives only this narrow, read-only authority seam. Its
 * credential is separate from every Worker, migration, and operator role.
 */
export function makePostgresHnsCommunityAppGatewayAuthorityV1(
  connectionString: string,
  options?: PostgresControlPlaneOptions,
): HnsCommunityAppGatewayPostgresAuthorityV1 {
  const authoritySource = makeControlPlaneHnsCommunityAppHostAuthoritySource(
    makeReadOnlyPostgresControlPlaneLayer(connectionString, options),
    { authority_schema: "api_next" },
  );
  return Object.freeze({
    authority_source: authoritySource,
    ready: async (signal) => {
      try {
        const state = await Effect.runPromise(
          authoritySource.resolve(HNS_COMMUNITY_APP_GATEWAY_AUTHORITY_READINESS_HOST),
          { signal },
        );
        return state === null;
      } catch {
        return false;
      }
    },
  });
}
