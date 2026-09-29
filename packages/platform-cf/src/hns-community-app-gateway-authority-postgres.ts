import type {
  HnsForwarderGatewayAuthoritySourceV1,
  HnsHostAuthorityStateV1,
} from "@pirate/application/hns-host-serving";
import { Effect } from "effect";
import { makeGatewayPostgresPoolClientFactory } from "./hns-gateway-postgres-pool.ts";
import { makeControlPlaneHnsCommunityAppHostAuthoritySource } from "./hns-host-persistence-repository.ts";
import {
  makeReadOnlyPostgresGatewayAuthorityLayer,
  type PostgresControlPlaneOptions,
} from "./postgres.ts";

export const HNS_COMMUNITY_APP_GATEWAY_AUTHORITY_READINESS_HOST =
  "app.-pirate-readiness-invalid" as const;

export type HnsCommunityAppGatewayPostgresAuthorityV1 = Readonly<{
  authority_source: HnsForwarderGatewayAuthoritySourceV1;
  ready: (signal?: AbortSignal) => Promise<boolean>;
}>;

export interface HnsCommunityAppGatewayPostgresAuthorityOptionsV1
  extends PostgresControlPlaneOptions {
  readonly resolutionDeadlineMs?: number;
}

export function makeCoalescingHnsGatewayAuthoritySourceV1(
  source: HnsForwarderGatewayAuthoritySourceV1,
  deadlineMs = 1_500,
  now: () => number = Date.now,
): HnsForwarderGatewayAuthoritySourceV1 {
  // Each resolve borrows its own client from the bounded pool, so distinct
  // hosts can resolve concurrently. Same-host callers share only the live
  // resolution. Only an unclaimed answer is remembered for three seconds;
  // claimed answers and failures remain fresh. No caller AbortSignal owns the
  // shared operation.
  const pending = new Map<string, Promise<HnsHostAuthorityStateV1 | null>>();
  const unclaimedUntil = new Map<string, number>();
  const negativeCacheMs = 3_000;
  const negativeCacheLimit = 1_024;
  return Object.freeze({
    resolve: (normalizedHost) =>
      Effect.promise(() => {
        const existing = pending.get(normalizedHost);
        if (existing !== undefined) return existing;
        const expiresAt = unclaimedUntil.get(normalizedHost);
        if (expiresAt !== undefined) {
          if (expiresAt > now()) return Promise.resolve(null);
          unclaimedUntil.delete(normalizedHost);
        }
        const promise = Effect.runPromise(source.resolve(normalizedHost), {
          signal: AbortSignal.timeout(deadlineMs),
        });
        pending.set(normalizedHost, promise);
        void promise.then(
          (state) => {
            if (pending.get(normalizedHost) === promise) pending.delete(normalizedHost);
            if (state === null) {
              unclaimedUntil.delete(normalizedHost);
              unclaimedUntil.set(normalizedHost, now() + negativeCacheMs);
              if (unclaimedUntil.size > negativeCacheLimit) {
                const oldest = unclaimedUntil.keys().next().value;
                if (oldest !== undefined) unclaimedUntil.delete(oldest);
              }
            }
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
  options: HnsCommunityAppGatewayPostgresAuthorityOptionsV1 = {},
): HnsCommunityAppGatewayPostgresAuthorityV1 {
  const { resolutionDeadlineMs = 1_500, ...postgresOptions } = options;
  const source = makeControlPlaneHnsCommunityAppHostAuthoritySource(
    makeReadOnlyPostgresGatewayAuthorityLayer(connectionString, {
      ...postgresOptions,
      clientFactory: postgresOptions.clientFactory ?? makeGatewayPostgresPoolClientFactory(),
    }),
    { authority_schema: "api_next" },
  );
  const authoritySource = makeCoalescingHnsGatewayAuthoritySourceV1(source, resolutionDeadlineMs);
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
