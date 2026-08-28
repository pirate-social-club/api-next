import type {
  HnsForwarderGatewayAuthoritySourceV1,
  HnsHostAuthorityStateV1,
} from "@pirate/application/hns-host-serving";
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

export function makeSerializedCoalescingHnsGatewayAuthoritySourceV1(
  source: HnsForwarderGatewayAuthoritySourceV1,
  deadlineMs = 1_500,
): HnsForwarderGatewayAuthoritySourceV1 {
  // Every resolve owns a scoped Postgres layer. Run one scope at a time so a
  // sibling request cannot release a client still in use by another scope.
  // Same-host callers share only the live resolution; settled results are
  // never cached, and no caller AbortSignal owns the shared operation.
  let queue = Promise.resolve();
  const pending = new Map<string, Promise<HnsHostAuthorityStateV1 | null>>();
  return Object.freeze({
    resolve: (normalizedHost) =>
      Effect.promise(() => {
        const existing = pending.get(normalizedHost);
        if (existing !== undefined) return existing;
        const execute = () =>
          Effect.runPromise(source.resolve(normalizedHost), {
            signal: AbortSignal.timeout(deadlineMs),
          });
        const promise = queue.then(execute, execute);
        queue = promise.then(
          () => undefined,
          () => undefined,
        );
        pending.set(normalizedHost, promise);
        void promise.then(
          () => {
            if (pending.get(normalizedHost) === promise) pending.delete(normalizedHost);
          },
          () => {
            if (pending.get(normalizedHost) === promise) pending.delete(normalizedHost);
          },
        );
        return promise;
      }),
  });
}

/**
 * The VPS gateway receives only this narrow, read-only authority seam. Its
 * credential is separate from every Worker, migration, and operator role.
 */
export function makePostgresHnsCommunityAppGatewayAuthorityV1(
  connectionString: string,
  options?: PostgresControlPlaneOptions,
): HnsCommunityAppGatewayPostgresAuthorityV1 {
  const source = makeControlPlaneHnsCommunityAppHostAuthoritySource(
    makeReadOnlyPostgresControlPlaneLayer(connectionString, options),
    { authority_schema: "api_next" },
  );
  const authoritySource = makeSerializedCoalescingHnsGatewayAuthoritySourceV1(source);
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
