/**
 * @pirate/platform-cf — the only package importing `cloudflare:workers` or
 * Effect platform adapters.
 *
 * Lane C owns this package (api-next 001 §5) EXCEPT `config/`, which lane A
 * owns because config schema and contracts co-evolve (001 §3).
 */
export const platformCf = "api-next/platform-cf: lane C (001 §5), config/ lane A" as const;

export {
  type AlertDigest,
  type AlertGroup,
  type AlertSink,
  aggregateAlerts,
  alertTick,
} from "./alerts";
export { CRON_LOCK_NAME, evaluateLease, type LeaseDecision, type LeaseRecord } from "./cron-lock";
export { ScheduledCronLockDO } from "./cron-lock-do";
export {
  QUEUE_RETRY_BASE_SECONDS,
  QUEUE_RETRY_CAP_SECONDS,
  queueRetryBackoffSeconds,
  queueRetryDelaySeconds,
} from "./queue-retry";
export {
  BindingPending,
  CommunityBindingResolver,
  type CommunityBindingResolverOptions,
  CommunityDecommissioned,
  CommunityNotRouted,
  type CommunityProvisioningState,
  type CommunityRoutingRow,
  type ResolvedCommunityBinding,
  ROUTING_CACHE_TTL_MS,
  SHORT_CACHE_TTL_MS,
} from "./shard-resolver";
