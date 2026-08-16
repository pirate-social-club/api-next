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
export {
  CRON_LOCK_NAME,
  evaluateFencedLease,
  evaluateLease,
  type FencedLeaseDecision,
  type FencedLeaseRecord,
  type LeaseDecision,
  type LeaseRecord,
} from "./cron-lock";
export { ScheduledCronLockDO } from "./cron-lock-do";
export {
  CONTROL_PLANE_CONNECT_TIMEOUT_MS,
  CONTROL_PLANE_IDLE_TRANSACTION_TIMEOUT_MS,
  CONTROL_PLANE_SLOW_STATEMENT_MS,
  CONTROL_PLANE_STATEMENT_TIMEOUT_MS,
  type ControlPlaneLogFields,
  type ControlPlaneLogger,
  type ControlPlaneLogValue,
  type HyperdriveConnection,
  makeDirectPostgresControlPlaneLayer,
  makeHyperdriveControlPlaneLayer,
  type PostgresClientFactory,
  type PostgresClientLike,
  type PostgresControlPlaneOptions,
  type PostgresQueryConfig,
  type PostgresStreamLike,
} from "./postgres";
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
