// D1 community-shard binding resolver, ported from the old
// communities/community-binding-resolver.ts with the same dual-TTL model and
// fail-closed semantics (000 §8): 60s TTL for live routing entries, 5s TTL
// for degraded/decommissioned rows; `provisioning` rows are never cached and
// surface as a retryable `binding_pending` 503; decommissioned communities
// are a terminal 410. Errors are typed values in the Effect error channel —
// the routing-row read is injected so this core stays I/O-free.

import { Data } from "effect";

export type CommunityProvisioningState = "provisioning" | "ready" | "degraded" | "decommissioned";

export type CommunityRoutingRow = {
  community_id: string;
  provisioning_state: CommunityProvisioningState;
  shard_worker_id: string | null;
  binding_name: string | null;
  region: string | null;
  decommissioned_at: string | null;
};

export type ResolvedCommunityBinding = {
  communityId: string;
  provisioningState: CommunityProvisioningState;
  shardWorkerId: string | null;
  bindingName: string | null;
  region: string | null;
  decommissionedAt: string | null;
};

/** Community has no routing directory entry at all (wire: 404 community_not_found). */
export class CommunityNotRouted extends Data.TaggedError("CommunityNotRouted")<{
  readonly communityId: string;
}> {}

/** Binding deploy still in flight; retryable, never cached (wire: 503 binding_pending). */
export class BindingPending extends Data.TaggedError("BindingPending")<{
  readonly communityId: string;
}> {
  readonly retryable = true;
}

/** Terminal: the community's shard is gone (wire: 410 community_decommissioned). */
export class CommunityDecommissioned extends Data.TaggedError("CommunityDecommissioned")<{
  readonly communityId: string;
}> {}

export const ROUTING_CACHE_TTL_MS = 60_000;
// Short TTL for non-stable routing states so the router observes a recovery
// or a decommission quickly, without hammering the control plane.
export const SHORT_CACHE_TTL_MS = 5_000;

type CacheEntry = {
  value: ResolvedCommunityBinding;
  expiresAt: number;
};

export type CommunityBindingResolverOptions = {
  now?: () => number;
  routingTtlMs?: number;
  shortTtlMs?: number;
};

export class CommunityBindingResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly now: () => number;
  private readonly routingTtlMs: number;
  private readonly shortTtlMs: number;

  constructor(options: CommunityBindingResolverOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.routingTtlMs = options.routingTtlMs ?? ROUTING_CACHE_TTL_MS;
    this.shortTtlMs = options.shortTtlMs ?? SHORT_CACHE_TTL_MS;
  }

  private ttlFor(value: ResolvedCommunityBinding): number {
    if (
      value.provisioningState === "degraded" ||
      value.provisioningState === "decommissioned" ||
      value.decommissionedAt
    ) {
      return this.shortTtlMs;
    }
    return this.routingTtlMs;
  }

  /**
   * Resolve a community's binding. Fail closed: a decommissioned community
   * has no live binding to route to — the row is still cached (short TTL) so
   * a flood of requests to a recently decommissioned community does not
   * hammer the control plane.
   */
  async resolve(
    readRoutingRow: (communityId: string) => Promise<CommunityRoutingRow | null>,
    communityId: string,
  ): Promise<ResolvedCommunityBinding> {
    const value = await this.load(readRoutingRow, communityId);
    if (value.provisioningState === "decommissioned" || value.decommissionedAt) {
      throw new CommunityDecommissioned({ communityId });
    }
    return value;
  }

  private async load(
    readRoutingRow: (communityId: string) => Promise<CommunityRoutingRow | null>,
    communityId: string,
  ): Promise<ResolvedCommunityBinding> {
    const cached = this.cache.get(communityId);
    if (cached && this.now() < cached.expiresAt) {
      return cached.value;
    }
    this.cache.delete(communityId);

    const row = await readRoutingRow(communityId);
    if (!row) {
      throw new CommunityNotRouted({ communityId });
    }

    if (row.provisioning_state === "provisioning") {
      // Deploy of the community's binding is still in flight. Do not cache:
      // the state flips to `ready` without a routing change the caller can
      // observe.
      throw new BindingPending({ communityId });
    }

    const value: ResolvedCommunityBinding = {
      communityId: row.community_id,
      provisioningState: row.provisioning_state,
      shardWorkerId: row.shard_worker_id,
      bindingName: row.binding_name,
      region: row.region,
      decommissionedAt: row.decommissioned_at,
    };

    this.cache.set(communityId, { value, expiresAt: this.now() + this.ttlFor(value) });
    return value;
  }

  /** Drop a cached entry — used on a binding error or after a known routing change. */
  invalidate(communityId: string): void {
    this.cache.delete(communityId);
  }

  /** Test/operational hook: clear the whole cache. */
  clear(): void {
    this.cache.clear();
  }
}
