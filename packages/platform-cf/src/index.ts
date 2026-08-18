/**
 * @pirate/platform-cf — the only package importing `cloudflare:workers` or
 * Effect platform adapters.
 *
 * Lane C owns this package (api-next 001 §5) EXCEPT `config/`, which lane A
 * owns because config schema and contracts co-evolve (001 §3).
 */
export const platformCf = "api-next/platform-cf: lane C (001 §5), config/ lane A" as const;

export {
  type AlertSinkBindings,
  AlertSinkConfigurationError,
  makeConfiguredAlertSink,
} from "./alert-config";
export {
  ALERT_CONDITION_ACTIVE_WINDOW_MS,
  ALERT_REMINDER_DELAYS_MS,
  type AlertDeliveryLedger,
  type AlertDeliveryStore,
  type AlertDigest,
  type AlertGroup,
  type AlertSink,
  AlertSinkDeliveryFailed,
  type AlertSuppressionDecision,
  type AlertSuppressionLedger,
  type AlertSuppressionState,
  type AlertTickOptions,
  aggregateAlerts,
  alertTick,
  decideAlertSuppression,
  makeAlertDeliveryLedger,
  makeHttpAlertSink,
  makeLocalAlertSink,
} from "./alerts";
export {
  COMMUNITY_PURCHASE_CHAIN_RPC_MAX_RESPONSE_BYTES,
  COMMUNITY_PURCHASE_CHAIN_RPC_TIMEOUT_MS,
  type CommunityPurchaseFundingChainFetcher,
  type CommunityPurchaseFundingChainReaderOptions,
  makeCommunityPurchaseFundingChainReader,
} from "./community-purchase-funding-chain-reader";
export {
  makeControlPlaneCommunityPurchaseFundingAdmissionStore,
  makeControlPlaneCommunityPurchaseFundingRepository,
  makeControlPlaneCommunityPurchaseFundingStore,
} from "./community-purchase-funding-repository";
export {
  makeControlPlaneCommunityRepository,
  makeControlPlaneCommunityStore,
} from "./community-repository";
export {
  type ContentRepository,
  makeControlPlaneContentRepository,
  makeControlPlaneContentStore,
} from "./content-repository";
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
  type FeedRepository,
  type FeedRepositoryOptions,
  makeControlPlaneFeedRepository,
  makeControlPlaneFeedStore,
} from "./feed-repository";
export {
  type CanonicalIdentity,
  type IdentityRepository,
  IdentityRepositoryError,
  type IdentityUser,
  MAX_CANONICAL_ALIAS_HOPS,
  makeControlPlaneIdentityRepository,
  makeControlPlaneIdentityStore,
} from "./identity-repository";
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
  applyPostgresMigrations,
  type MigrationApplyResult,
  MigrationDefinitionInvalid,
  MigrationLedgerMismatch,
  type PostgresMigration,
} from "./postgres-migrations";
export {
  makeControlPlanePublicCommunityThreadsRepository,
  makeControlPlanePublicCommunityThreadsStore,
  type PublicCommunityThreadsRepository,
  type PublicCommunityThreadsRepositoryOptions,
} from "./public-community-threads-repository";
export {
  makeControlPlanePublicProfileRepository,
  makeControlPlanePublicProfileStore,
} from "./public-profile-repository";
export {
  QUEUE_RETRY_BASE_SECONDS,
  QUEUE_RETRY_CAP_SECONDS,
  queueRetryBackoffSeconds,
  queueRetryDelaySeconds,
} from "./queue-retry";
export {
  MAX_SESSION_TOKEN_LENGTH,
  makeSessionCrypto,
  makeSessionCryptoFromEnv,
  type SessionClaimsInput,
  type SessionCrypto,
  type SessionCryptoEnvironment,
  SessionCryptoError,
  type SessionCryptoOptions,
  type SessionJwks,
  type SessionPublicJwk,
  type VerifiedSessionClaims,
} from "./session-crypto";
export {
  makeJwksSessionProofVerifier,
  SESSION_PROOF_CACHE_TTL_MS,
  SESSION_PROOF_FETCH_TIMEOUT_MS,
  SESSION_PROOF_MAX_JWKS_BYTES,
  SESSION_PROOF_MAX_TOKEN_LENGTH,
  type SessionProofAdapterOptions,
  type SessionProofFetcher,
  type SessionProofProviderConfig,
} from "./session-proof";
export {
  makeRs256SessionTokenMinter,
  makeRs256SessionTokenVerifier,
  type SessionPrincipal,
  type SessionTokenClassification,
  type SessionTokenFailureCode,
  type SessionTokenScope,
  SessionTokenVerificationError,
  type SessionTokenVerifier,
} from "./session-tokens";
