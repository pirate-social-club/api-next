import { Clock, IdGen, type KaraokeFailure, makeKaraokeService } from "@pirate/application";
import type { MediaSubmissionServices } from "@pirate/application/media/submission-service";
import { makeCommunityPurchaseFundingInterpreter } from "@pirate/application/money/community-purchase-funding";
import { makeCommunityPurchaseFundingObservationUseCase } from "@pirate/application/money/community-purchase-funding-observation";
import {
  type TextModeration,
  TextModerationProviderError,
} from "@pirate/application/use-cases/content/text-post";
import { makeRandomIdentityRegistrationCandidateSource } from "@pirate/application/use-cases/identity-registration";
import { PERSONA_WALLET_SETUP_SESSION_SCOPE } from "@pirate/application/use-cases/identity-registration-handler";
import { getMyProfile } from "@pirate/application/use-cases/profile";
import { makePublicProfileHandler } from "@pirate/application/use-cases/public-profile";
import {
  type StudyItemSource,
  StudyItemSourceError,
} from "@pirate/application/use-cases/rewards/activity-qualification";
import type {
  StudyAudioArchive,
  StudyBatchTranscriber,
} from "@pirate/application/use-cases/rewards/study-v2";
import {
  type AuthenticatedSession,
  authenticateSession,
  authorizeSession,
} from "@pirate/application/use-cases/session-authentication";
import {
  makePrivySessionIdentityStore,
  makeSessionIdentityStore,
} from "@pirate/application/use-cases/session-exchange";
import type { VerificationIntentResolver } from "@pirate/application/verification";
import {
  AuthError,
  BadRequest,
  Conflict,
  InternalError,
  NotFound,
  ProviderUnavailable,
} from "@pirate/contracts";
import { makeControlPlaneActivityQualificationStore } from "@pirate/platform-cf/activity-qualification-repository";
import { makeControlPlaneAgeAccessStore } from "@pirate/platform-cf/age-access-repository";
import { makeControlPlaneCommunityCreationIntentResolver } from "@pirate/platform-cf/community-creation-intent-resolver";
import { makeControlPlaneCommunityCreationStore } from "@pirate/platform-cf/community-creation-repository";
import { makeControlPlaneCommunityJoinIntentResolver } from "@pirate/platform-cf/community-join-intent-resolver";
import { makeControlPlaneCommunityModerationStore } from "@pirate/platform-cf/community-moderation-repository";
import { makeCommunityPurchaseFundingChainReader } from "@pirate/platform-cf/community-purchase-funding-chain-reader";
import {
  makeControlPlaneCommunityPurchaseFundingProducerStore,
  makeControlPlaneCommunityPurchaseFundingQueryStore,
  makeControlPlaneCommunityPurchaseFundingStore,
} from "@pirate/platform-cf/community-purchase-funding-repository";
import { makeControlPlaneCommunityStore } from "@pirate/platform-cf/community-repository";
import { makeControlPlaneCanonicalCommunityRouteStore } from "@pirate/platform-cf/community-route-repository";
import {
  assertMegapotRewardRuntimePosture,
  HttpWorkerConfig,
  type HttpWorkerConfigValue,
  loadConfigFrom,
} from "@pirate/platform-cf/config";
import { makeControlPlaneContentStore } from "@pirate/platform-cf/content-repository";
import { makeControlPlaneFeedStore } from "@pirate/platform-cf/feed-repository";
import { makeHandleRecipientTokenVault } from "@pirate/platform-cf/handle-recipient-token-vault";
import { makeControlPlaneHandleSalesStore } from "@pirate/platform-cf/handle-sales-repository";
import type { HnsForwarderReplayStoreNamespace } from "@pirate/platform-cf/hns-forwarder-replay-store";
import { makeControlPlaneHnsCommunityAppHostAuthoritySource } from "@pirate/platform-cf/hns-host-persistence-repository";
import {
  makeControlPlaneCredentialCanonicalResolver,
  makeControlPlaneIdentityRegistrationStore,
  makeControlPlaneIdentityStore,
  makeControlPlanePrivySessionCredentialStore,
  makeControlPlaneSessionProductReadiness,
} from "@pirate/platform-cf/identity-repository";
import {
  type KaraokeAttemptDoNamespace,
  makeDurableObjectKaraokeRuntimeGateway,
} from "@pirate/platform-cf/karaoke-attempt-do";
import { makeControlPlaneKaraokeReadinessStore } from "@pirate/platform-cf/karaoke-readiness-repository";
import { makeControlPlaneKaraokeStore } from "@pirate/platform-cf/karaoke-repository";
import { makeR2MediaIngressPresigner } from "@pirate/platform-cf/media-ingress-presigner";
import {
  type MediaSealBuckets,
  makeR2MediaSealer,
} from "@pirate/platform-cf/media-sealing-adapter";
import {
  makeMediaUploadApplicationCommands,
  makeMediaUploadStore,
} from "@pirate/platform-cf/media-upload-store";
import { makeControlPlaneMegapotDrawingObservationStore } from "@pirate/platform-cf/megapot-drawing-observation-repository";
import { makeMegapotV2RpcClient } from "@pirate/platform-cf/megapot-v2-rpc";
import { makeControlPlaneNamespaceOwnershipCompletionStore } from "@pirate/platform-cf/namespace-ownership-completion-repository";
import {
  type HnsOwnerServiceBinding,
  type HnsOwnerTransport,
  makeHnsOwnerServiceBindingTransport,
  makePlatformNamespaceOwnershipProviderRegistry,
} from "@pirate/platform-cf/namespace-ownership-provider-registry";
import {
  makeControlPlaneNamespaceOwnershipStartAuthorityResolver,
  makeControlPlaneNamespaceOwnershipStartStore,
} from "@pirate/platform-cf/namespace-ownership-start-repository";
import {
  makeOpenAiTextModerationProvider,
  OPENAI_MODERATION_BASE_URL,
  OPENAI_MODERATION_MODEL,
  OPENAI_MODERATION_TIMEOUT_MS,
  type OpenAiModerationTransport,
} from "@pirate/platform-cf/openai-text-moderation";
import {
  makeControlPlanePersonaStore,
  makeControlPlanePersonaWalletStore,
} from "@pirate/platform-cf/persona-repository";
import { makeControlPlanePlatformPirateHandleStore } from "@pirate/platform-cf/platform-pirate-handle-repository";
import {
  type HyperdriveConnection,
  makeHyperdriveControlPlaneLayer,
} from "@pirate/platform-cf/postgres";
import { makeControlPlanePublicProfileStore } from "@pirate/platform-cf/public-profile-repository";
import {
  makeDurableObjectIdentityRegistrationRateLimiter,
  type RegistrationRateLimiterNamespaces,
} from "@pirate/platform-cf/registration-rate-limiter";
import { makeRewardFundingCoordinator } from "@pirate/platform-cf/reward-funding-coordinator";
import { makeControlPlaneRewardFundingStore } from "@pirate/platform-cf/reward-funding-repository";
import { makeControlPlaneRewardProjectionStore } from "@pirate/platform-cf/reward-projection-repository";
import { makeSessionCrypto } from "@pirate/platform-cf/session-crypto";
import { makeJwksSessionProofVerifier } from "@pirate/platform-cf/session-proof";
import {
  makeRs256SessionTokenMinter,
  makeRs256SessionTokenVerifier,
} from "@pirate/platform-cf/session-tokens";
import { makeControlPlaneSongRewardOfferStore } from "@pirate/platform-cf/song-reward-offer-repository";
import {
  makeR2StudyAudioArchive,
  type StudyAudioBucket,
} from "@pirate/platform-cf/study-spoken-audio";
import { makeControlPlaneStudyV2Store } from "@pirate/platform-cf/study-v2-repository";
import { makeControlPlaneTextSubmissionStore } from "@pirate/platform-cf/text-submission-repository";
import {
  makeControlPlaneVerificationCompletionStore,
  makeSha256VerificationCompletionHasher,
} from "@pirate/platform-cf/verification-completion-repository";
import {
  makeOrderedVerificationIntentResolver,
  makeStaticVerificationIntentResolver,
} from "@pirate/platform-cf/verification-intent-resolver";
import {
  makePlatformVerificationProviderRegistry,
  validVeryOauthOptions,
  validVeryWebOptions,
} from "@pirate/platform-cf/verification-provider-registry";
import { makeControlPlaneVerificationSessionStartStore } from "@pirate/platform-cf/verification-start-repository";
import { Effect, Redacted, Schema } from "effect";
import { makeActivityQualificationHandlers } from "./activity-qualification-handlers.ts";
import { makeCanonicalCommunityRouteHandlers } from "./canonical-community-route-handlers.ts";
import { makeCommunityCreationHandlers } from "./community-creation-handlers.ts";
import { makeLegacyModerationActionCompatibility } from "./community-moderation-compatibility.ts";
import {
  makeCommunityPurchaseFundingObservationHandlers,
  makeCommunityPurchaseFundingQuoteHandlers,
} from "./community-purchase-funding-handlers.ts";
import { makeHandleSalesHandlers } from "./handle-sales-handlers.ts";
import { makeProductionHnsCommunityAppApiComposition } from "./hns-community-app-api-production-composition.ts";
import { makeHnsOwnershipComposition } from "./hns-ownership-composition.ts";
import { makeKaraokeHandlers, makeKaraokeReadinessHandlers } from "./karaoke-handlers.ts";
import { makeMediaUploadHandlers } from "./media-upload-handlers.ts";
import { makeNamespaceOwnershipHandlers } from "./namespace-ownership-handlers.ts";
import { makePersonaHandlers } from "./persona-handlers.ts";
import { makePlatformPirateHandleHandlers } from "./platform-pirate-handle-handlers.ts";
import { makeProductHandlers } from "./product-handlers.ts";
import { makeSongRewardOfferHandlers } from "./rewards-song-offer-handlers.ts";
import { makeStudyV2Handlers } from "./study-v2-handlers.ts";
import { createHttpWorker, type EndpointHandler, type Principal } from "./transport.ts";
import { makeVerificationHandlers } from "./verification-handlers.ts";

export interface HttpWorkerBindings {
  readonly CONTROL_PLANE?: unknown;
  readonly HNS_OWNER_VERIFIER?: HnsOwnerServiceBinding;
  readonly REGISTRATION_IP_LIMITER?: RegistrationRateLimiterNamespaces["ip"];
  readonly REGISTRATION_APPLICATION_LIMITER?: RegistrationRateLimiterNamespaces["application"];
  readonly API_NEXT_ENV?: string;
  readonly CORS_ORIGIN?: string;
  readonly PIRATE_API_PUBLIC_ORIGIN?: string;
  readonly SELF_PASS_ENABLED?: string;
  readonly SELF_PASS_APP_NAME?: string;
  readonly SELF_PASS_MOCK_PASSPORT?: string;
  readonly ZKPASSPORT_ENABLED?: string;
  readonly ZKPASSPORT_DOMAIN?: string;
  readonly ZKPASSPORT_NAME?: string;
  readonly ZKPASSPORT_LOGO?: string;
  readonly ZKPASSPORT_VERIFIER_URL?: string;
  readonly ZKPASSPORT_VERIFIER_SHARED_SECRET?: string;
  readonly ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_SECRET?: string;
  readonly ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_KEY_ID?: string;
  readonly ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_SECRET?: string;
  readonly ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_KEY_ID?: string;
  readonly ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_VALID_UNTIL?: string;
  readonly ZKPASSPORT_DEV_MODE?: string;
  readonly VERY_OAUTH_ENABLED?: string;
  readonly VERY_OAUTH_AUTHORIZATION_ENDPOINT?: string;
  readonly VERY_OAUTH_TOKEN_ENDPOINT?: string;
  readonly VERY_OAUTH_USERINFO_ENDPOINT?: string;
  readonly VERY_OAUTH_ISSUER?: string;
  readonly VERY_OAUTH_JWKS_URL?: string;
  readonly VERY_OAUTH_CLIENT_ID?: string;
  readonly VERY_OAUTH_CLIENT_SECRET?: string;
  readonly VERY_OAUTH_REDIRECT_URI?: string;
  readonly VERY_OAUTH_SEALING_KEY?: string;
  readonly VERY_WEB_ENABLED?: string;
  readonly VERY_WEB_APP_ID?: string;
  readonly VERY_WEB_API_URL?: string;
  readonly VERY_WEB_VERIFY_URL?: string;
  readonly VERY_WEB_BRIDGE_API_URL?: string;
  readonly VERY_WEB_SEALING_KEY?: string;
  readonly HNS_OWNERSHIP_ENABLED?: string;
  readonly HNS_OWNERSHIP_CONFIGURATION_REFERENCE?: string;
  readonly HNS_OWNERSHIP_CONFIGURATION_VERSION?: string;
  readonly HNS_COMMUNITY_APP_API_REPLAY?: HnsForwarderReplayStoreNamespace;
  readonly KARAOKE_ATTEMPT?: KaraokeAttemptDoNamespace;
  readonly HNS_COMMUNITY_APP_API_ENABLED?: string;
  readonly HNS_COMMUNITY_APP_API_PROTECTED_ORIGIN?: string;
  readonly HNS_COMMUNITY_APP_API_ACCESS_ISSUER?: string;
  readonly HNS_COMMUNITY_APP_API_ACCESS_JWKS_URL?: string;
  readonly HNS_COMMUNITY_APP_API_ACCESS_AUDIENCE?: string;
  readonly HNS_FORWARDER_V3_KEY_REGISTRY_REFERENCE?: string;
  readonly HNS_FORWARDER_V3_KEY_REGISTRY_VERSION?: string;
  readonly HNS_FORWARDER_V3_HMAC_KEY_REGISTRY?: string;
  readonly HNS_FORWARDER_V3_FRESHNESS_WINDOW_SECONDS?: string;
  readonly HNS_FORWARDER_V3_FUTURE_CLOCK_SKEW_SECONDS?: string;
  readonly VERIFICATION_CALLBACK_CREDENTIAL_HEADERS?: string;
  readonly PIRATE_APP_JWT_PRIVATE_KEY?: string;
  readonly PIRATE_APP_JWT_PUBLIC_KEY?: string;
  readonly PIRATE_APP_JWT_ISSUER?: string;
  readonly PIRATE_APP_JWT_AUDIENCE?: string;
  readonly PIRATE_APP_JWT_SCOPE?: string;
  readonly PIRATE_APP_JWT_TTL_SECONDS?: string;
  readonly PRIVY_APP_ID?: string;
  readonly PRIVY_APP_SECRET?: string;
  readonly PRIVY_API_URL?: string;
  readonly PRIVY_JWKS_URL?: string;
  readonly PRIVY_JWT_ISSUER?: string;
  readonly PRIVY_JWT_AUDIENCE?: string;
  readonly COMMUNITY_PURCHASE_FUNDING_RPC_URL?: string;
  readonly HANDLE_RECIPIENT_TOKEN_HMAC_KEYS?: string;
  readonly HANDLE_RECIPIENT_TOKEN_ENVELOPE_KEYS?: string;
  readonly OPENAI_MODERATION_ENABLED?: string;
  readonly OPENAI_API_KEY?: string;
  readonly OPENAI_MODERATION_MODEL?: string;
  readonly OPENAI_MODERATION_BASE_URL?: string;
  readonly OPENAI_MODERATION_TIMEOUT_MS?: string;
  readonly ELEVENLABS_API_KEY?: string;
  readonly MEGAPOT_REWARDS_ENABLED?: string;
  readonly MEGAPOT_CHAIN_ID?: string;
  readonly MEGAPOT_V2_RPC_URL?: string;
  readonly MEGAPOT_ATTESTATION_ID?: string;
  readonly MEGAPOT_REQUIRED_CONFIRMATIONS?: string;
  readonly MEDIA_UPLOADS_ENABLED?: string;
  readonly MEDIA_INGRESS_R2_ACCOUNT_ID?: string;
  readonly MEDIA_INGRESS_R2_BUCKET_NAME?: string;
  readonly MEDIA_INGRESS_R2_PRESIGN_ACCESS_KEY_ID?: string;
  readonly MEDIA_INGRESS_R2_PRESIGN_SECRET_ACCESS_KEY?: string;
  readonly MEDIA_INGRESS?: MediaSealBuckets["ingress"];
  readonly MEDIA_IMMUTABLE_ORIGINALS?: MediaSealBuckets["immutableOriginals"];
  readonly LEARNER_AUDIO?: StudyAudioBucket;
}

export interface HttpWorkerCompositionDependencies {
  readonly hns_ownership?: Readonly<{
    readonly transport?: HnsOwnerTransport;
  }>;
  /** Server-owned producer supplied by the Study content-generation composition. */
  readonly study_item_source?: StudyItemSource["Service"];
  /** Explicit provider enablement is external to composition; tests and staged callers inject it. */
  readonly study_batch_transcriber?: StudyBatchTranscriber;
  readonly study_audio_archive?: StudyAudioArchive;
  /** Test/review injection. Production constructs this only when media is explicitly enabled. */
  readonly media_services?: MediaSubmissionServices;
  /** Fake transport for provider-free composition and request-path tests. */
  readonly openai_moderation_transport?: OpenAiModerationTransport;
}

type WorkerConfig = HttpWorkerConfigValue;

/**
 * Builds the only production registration limiter adapter. No composition
 * path may substitute an in-memory or allow-all limiter.
 */
export function makeProductionIdentityRegistrationRateLimiter(
  bindings: HttpWorkerBindings,
  environment: WorkerConfig["API_NEXT_ENV"],
) {
  const ip = bindings.REGISTRATION_IP_LIMITER;
  const application = bindings.REGISTRATION_APPLICATION_LIMITER;
  if (ip === undefined || application === undefined) {
    throw new Error("Registration Durable Object limiter bindings are incomplete");
  }
  const namespaces: RegistrationRateLimiterNamespaces = { ip, application };
  return makeDurableObjectIdentityRegistrationRateLimiter({
    namespaces,
    applicationName: `api-next:${environment}`,
  });
}

function configSource(bindings: HttpWorkerBindings): Record<string, string | undefined> {
  return {
    API_NEXT_ENV: bindings.API_NEXT_ENV,
    CORS_ORIGIN: bindings.CORS_ORIGIN,
    PIRATE_API_PUBLIC_ORIGIN: bindings.PIRATE_API_PUBLIC_ORIGIN,
    SELF_PASS_ENABLED: bindings.SELF_PASS_ENABLED,
    SELF_PASS_APP_NAME: bindings.SELF_PASS_APP_NAME,
    SELF_PASS_MOCK_PASSPORT: bindings.SELF_PASS_MOCK_PASSPORT,
    ZKPASSPORT_ENABLED: bindings.ZKPASSPORT_ENABLED,
    ZKPASSPORT_DOMAIN: bindings.ZKPASSPORT_DOMAIN,
    ZKPASSPORT_NAME: bindings.ZKPASSPORT_NAME,
    ZKPASSPORT_LOGO: bindings.ZKPASSPORT_LOGO,
    ZKPASSPORT_VERIFIER_URL: bindings.ZKPASSPORT_VERIFIER_URL,
    ZKPASSPORT_VERIFIER_SHARED_SECRET: bindings.ZKPASSPORT_VERIFIER_SHARED_SECRET,
    ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_SECRET:
      bindings.ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_SECRET,
    ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_KEY_ID:
      bindings.ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_KEY_ID,
    ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_SECRET:
      bindings.ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_SECRET,
    ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_KEY_ID:
      bindings.ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_KEY_ID,
    ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_VALID_UNTIL:
      bindings.ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_VALID_UNTIL,
    ZKPASSPORT_DEV_MODE: bindings.ZKPASSPORT_DEV_MODE,
    VERY_OAUTH_ENABLED: bindings.VERY_OAUTH_ENABLED,
    VERY_OAUTH_AUTHORIZATION_ENDPOINT: bindings.VERY_OAUTH_AUTHORIZATION_ENDPOINT,
    VERY_OAUTH_TOKEN_ENDPOINT: bindings.VERY_OAUTH_TOKEN_ENDPOINT,
    VERY_OAUTH_USERINFO_ENDPOINT: bindings.VERY_OAUTH_USERINFO_ENDPOINT,
    VERY_OAUTH_ISSUER: bindings.VERY_OAUTH_ISSUER,
    VERY_OAUTH_JWKS_URL: bindings.VERY_OAUTH_JWKS_URL,
    VERY_OAUTH_CLIENT_ID: bindings.VERY_OAUTH_CLIENT_ID,
    VERY_OAUTH_CLIENT_SECRET: bindings.VERY_OAUTH_CLIENT_SECRET,
    VERY_OAUTH_REDIRECT_URI: bindings.VERY_OAUTH_REDIRECT_URI,
    VERY_OAUTH_SEALING_KEY: bindings.VERY_OAUTH_SEALING_KEY,
    VERY_WEB_ENABLED: bindings.VERY_WEB_ENABLED,
    VERY_WEB_APP_ID: bindings.VERY_WEB_APP_ID,
    VERY_WEB_API_URL: bindings.VERY_WEB_API_URL,
    VERY_WEB_VERIFY_URL: bindings.VERY_WEB_VERIFY_URL,
    VERY_WEB_BRIDGE_API_URL: bindings.VERY_WEB_BRIDGE_API_URL,
    VERY_WEB_SEALING_KEY: bindings.VERY_WEB_SEALING_KEY,
    HNS_OWNERSHIP_ENABLED: bindings.HNS_OWNERSHIP_ENABLED,
    HNS_OWNERSHIP_CONFIGURATION_REFERENCE: bindings.HNS_OWNERSHIP_CONFIGURATION_REFERENCE,
    HNS_OWNERSHIP_CONFIGURATION_VERSION: bindings.HNS_OWNERSHIP_CONFIGURATION_VERSION,
    HNS_COMMUNITY_APP_API_ENABLED: bindings.HNS_COMMUNITY_APP_API_ENABLED,
    HNS_COMMUNITY_APP_API_PROTECTED_ORIGIN: bindings.HNS_COMMUNITY_APP_API_PROTECTED_ORIGIN,
    HNS_COMMUNITY_APP_API_ACCESS_ISSUER: bindings.HNS_COMMUNITY_APP_API_ACCESS_ISSUER,
    HNS_COMMUNITY_APP_API_ACCESS_JWKS_URL: bindings.HNS_COMMUNITY_APP_API_ACCESS_JWKS_URL,
    HNS_COMMUNITY_APP_API_ACCESS_AUDIENCE: bindings.HNS_COMMUNITY_APP_API_ACCESS_AUDIENCE,
    HNS_FORWARDER_V3_KEY_REGISTRY_REFERENCE: bindings.HNS_FORWARDER_V3_KEY_REGISTRY_REFERENCE,
    HNS_FORWARDER_V3_KEY_REGISTRY_VERSION: bindings.HNS_FORWARDER_V3_KEY_REGISTRY_VERSION,
    HNS_FORWARDER_V3_HMAC_KEY_REGISTRY: bindings.HNS_FORWARDER_V3_HMAC_KEY_REGISTRY,
    HNS_FORWARDER_V3_FRESHNESS_WINDOW_SECONDS: bindings.HNS_FORWARDER_V3_FRESHNESS_WINDOW_SECONDS,
    HNS_FORWARDER_V3_FUTURE_CLOCK_SKEW_SECONDS: bindings.HNS_FORWARDER_V3_FUTURE_CLOCK_SKEW_SECONDS,
    VERIFICATION_CALLBACK_CREDENTIAL_HEADERS: bindings.VERIFICATION_CALLBACK_CREDENTIAL_HEADERS,
    PIRATE_APP_JWT_PRIVATE_KEY: bindings.PIRATE_APP_JWT_PRIVATE_KEY,
    PIRATE_APP_JWT_PUBLIC_KEY: bindings.PIRATE_APP_JWT_PUBLIC_KEY,
    PIRATE_APP_JWT_ISSUER: bindings.PIRATE_APP_JWT_ISSUER,
    PIRATE_APP_JWT_AUDIENCE: bindings.PIRATE_APP_JWT_AUDIENCE,
    PIRATE_APP_JWT_SCOPE: bindings.PIRATE_APP_JWT_SCOPE,
    PIRATE_APP_JWT_TTL_SECONDS: bindings.PIRATE_APP_JWT_TTL_SECONDS,
    PRIVY_APP_ID: bindings.PRIVY_APP_ID,
    PRIVY_APP_SECRET: bindings.PRIVY_APP_SECRET,
    PRIVY_API_URL: bindings.PRIVY_API_URL,
    PRIVY_JWKS_URL: bindings.PRIVY_JWKS_URL,
    PRIVY_JWT_ISSUER: bindings.PRIVY_JWT_ISSUER,
    PRIVY_JWT_AUDIENCE: bindings.PRIVY_JWT_AUDIENCE,
    COMMUNITY_PURCHASE_FUNDING_RPC_URL: bindings.COMMUNITY_PURCHASE_FUNDING_RPC_URL,
    HANDLE_RECIPIENT_TOKEN_HMAC_KEYS: bindings.HANDLE_RECIPIENT_TOKEN_HMAC_KEYS,
    HANDLE_RECIPIENT_TOKEN_ENVELOPE_KEYS: bindings.HANDLE_RECIPIENT_TOKEN_ENVELOPE_KEYS,
    OPENAI_MODERATION_ENABLED: bindings.OPENAI_MODERATION_ENABLED,
    OPENAI_API_KEY: bindings.OPENAI_API_KEY,
    OPENAI_MODERATION_MODEL: bindings.OPENAI_MODERATION_MODEL,
    OPENAI_MODERATION_BASE_URL: bindings.OPENAI_MODERATION_BASE_URL,
    OPENAI_MODERATION_TIMEOUT_MS: bindings.OPENAI_MODERATION_TIMEOUT_MS,
    MEGAPOT_REWARDS_ENABLED: bindings.MEGAPOT_REWARDS_ENABLED,
    MEGAPOT_CHAIN_ID: bindings.MEGAPOT_CHAIN_ID,
    MEGAPOT_V2_RPC_URL: bindings.MEGAPOT_V2_RPC_URL,
    MEGAPOT_ATTESTATION_ID: bindings.MEGAPOT_ATTESTATION_ID,
    MEGAPOT_REQUIRED_CONFIRMATIONS: bindings.MEGAPOT_REQUIRED_CONFIRMATIONS,
  };
}

const HyperdriveBinding = Schema.Struct({
  connectionString: Schema.NonEmptyString,
});

function loadWorkerConfig(bindings: HttpWorkerBindings): WorkerConfig {
  try {
    const config = loadConfigFrom(HttpWorkerConfig, configSource(bindings));
    assertMegapotRewardRuntimePosture(config);
    if (
      config.MEGAPOT_REWARDS_ENABLED &&
      Redacted.value(config.MEGAPOT_V2_RPC_URL).trim().length === 0
    ) {
      throw new Error("enabled Megapot rewards require an RPC binding");
    }
    const openAiApiKey = Redacted.value(config.OPENAI_API_KEY);
    if (
      (bindings.OPENAI_MODERATION_MODEL !== undefined &&
        bindings.OPENAI_MODERATION_MODEL !== OPENAI_MODERATION_MODEL) ||
      (bindings.OPENAI_MODERATION_BASE_URL !== undefined &&
        bindings.OPENAI_MODERATION_BASE_URL !== OPENAI_MODERATION_BASE_URL) ||
      (bindings.OPENAI_MODERATION_TIMEOUT_MS !== undefined &&
        bindings.OPENAI_MODERATION_TIMEOUT_MS !== String(OPENAI_MODERATION_TIMEOUT_MS)) ||
      (config.OPENAI_MODERATION_ENABLED &&
        (openAiApiKey.length === 0 ||
          openAiApiKey.trim() !== openAiApiKey ||
          config.OPENAI_MODERATION_MODEL !== OPENAI_MODERATION_MODEL ||
          config.OPENAI_MODERATION_BASE_URL !== OPENAI_MODERATION_BASE_URL ||
          config.OPENAI_MODERATION_TIMEOUT_MS !== OPENAI_MODERATION_TIMEOUT_MS))
    ) {
      throw new Error("invalid OpenAI moderation configuration");
    }
    if (config.PIRATE_APP_JWT_TTL_SECONDS <= 0) {
      throw new Error("invalid money-path configuration");
    }
    if (bindings.CONTROL_PLANE === undefined) throw new Error("CONTROL_PLANE is missing");
    return config;
  } catch {
    // Never expose ConfigError details, secret names, or secret values at the
    // Worker boundary.
    throw new Error("HTTP worker configuration is incomplete or invalid");
  }
}

function loadHyperdrive(bindings: HttpWorkerBindings): HyperdriveConnection {
  try {
    return Schema.decodeUnknownSync(HyperdriveBinding)(bindings.CONTROL_PLANE);
  } catch {
    throw new Error("HTTP worker configuration is incomplete or invalid");
  }
}

function principal(session: AuthenticatedSession): Principal {
  return {
    kind: session.kind,
    subject: session.subject,
    ...(session.scopes === undefined ? {} : { scopes: session.scopes }),
    ...(session.walletAddress === undefined ? {} : { walletAddress: session.walletAddress }),
  };
}

function publicHttpsOrigin(value: string): string | undefined {
  if (value === "") return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === ""
      ? parsed.origin
      : undefined;
  } catch {
    return undefined;
  }
}

function callbackCredentialHeaders(value: string): readonly string[] {
  return value
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter((header) => header !== "");
}

function isCanonicalIsoInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isSigningKeyId(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,128}$/.test(value);
}

function decodeVeryOauthSealingKey(value: string): Uint8Array | undefined {
  const bytes = new TextEncoder().encode(value);
  return bytes.byteLength === 32 ? bytes : undefined;
}

function fundingRpcUrl(value: string, environment: WorkerConfig["API_NEXT_ENV"]): string {
  try {
    const parsed = new URL(value);
    const developmentLocal =
      environment === "development" &&
      parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
    if (parsed.protocol !== "https:" && !developmentLocal) throw new Error("invalid RPC URL");
    return parsed.toString();
  } catch {
    throw new Error("HTTP worker configuration is incomplete or invalid");
  }
}

export async function createProductionHttpWorker(
  bindings: HttpWorkerBindings,
  dependencies: HttpWorkerCompositionDependencies = {},
) {
  const config = loadWorkerConfig(bindings);
  const zkPassportBearerSecret = Redacted.value(config.ZKPASSPORT_VERIFIER_SHARED_SECRET);
  const zkPassportSigningSecret = Redacted.value(
    config.ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_SECRET,
  );
  const zkPassportPreviousSigningSecret = Redacted.value(
    config.ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_SECRET,
  );
  const veryOauthClientSecret = Redacted.value(config.VERY_OAUTH_CLIENT_SECRET);
  const veryOauthSealingKey = decodeVeryOauthSealingKey(
    Redacted.value(config.VERY_OAUTH_SEALING_KEY),
  );
  const veryWebSealingKey = decodeVeryOauthSealingKey(Redacted.value(config.VERY_WEB_SEALING_KEY));
  const previousSigningFields = [
    zkPassportPreviousSigningSecret,
    config.ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_KEY_ID,
    config.ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_VALID_UNTIL,
  ];
  const previousSigningKeyAbsent = previousSigningFields.every((value) => value === "");
  const previousSigningKeyComplete =
    previousSigningFields.every((value) => value !== "" && value.trim() === value) &&
    isSigningKeyId(config.ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_KEY_ID) &&
    config.ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_KEY_ID !==
      config.ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_KEY_ID &&
    zkPassportPreviousSigningSecret !== zkPassportSigningSecret &&
    zkPassportPreviousSigningSecret !== zkPassportBearerSecret &&
    isCanonicalIsoInstant(config.ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_VALID_UNTIL);
  const hnsOwnership = (() => {
    try {
      const hnsConfig = {
        enabled: config.HNS_OWNERSHIP_ENABLED,
        environment: config.API_NEXT_ENV,
        configuration_reference: config.HNS_OWNERSHIP_CONFIGURATION_REFERENCE,
        configuration_version: config.HNS_OWNERSHIP_CONFIGURATION_VERSION,
      } as const;
      if (!hnsConfig.enabled) return makeHnsOwnershipComposition(hnsConfig);
      const transport =
        dependencies.hns_ownership?.transport ??
        (bindings.HNS_OWNER_VERIFIER === undefined
          ? undefined
          : makeHnsOwnerServiceBindingTransport(bindings.HNS_OWNER_VERIFIER));
      return makeHnsOwnershipComposition(hnsConfig, transport === undefined ? {} : { transport });
    } catch {
      throw new Error("HTTP worker configuration is incomplete or invalid");
    }
  })();
  const namespaceOwnershipRegistry = await Effect.runPromise(
    makePlatformNamespaceOwnershipProviderRegistry(hnsOwnership.provider_registry_options),
  ).catch(() => {
    throw new Error("HTTP worker configuration is incomplete or invalid");
  });
  const namespaceBindings = hnsOwnership.namespace_provider_bindings;
  if (
    namespaceBindings.length > 0 &&
    !namespaceBindings.every((binding) =>
      namespaceOwnershipRegistry
        .list()
        .some(
          (manifest) =>
            manifest.provider_id === binding.provider_id &&
            binding.family !== null &&
            manifest.supported_families.includes(binding.family) &&
            manifest.protocol_versions.includes(binding.protocol_version) &&
            manifest.environments.includes(config.API_NEXT_ENV),
        ),
    )
  ) {
    throw new Error("HTTP worker configuration is incomplete or invalid");
  }
  const veryWebOptions = config.VERY_WEB_ENABLED
    ? {
        app_id: config.VERY_WEB_APP_ID,
        api_url: config.VERY_WEB_API_URL,
        verify_url: config.VERY_WEB_VERIFY_URL,
        bridge_api_url: config.VERY_WEB_BRIDGE_API_URL,
        sealing_key: veryWebSealingKey ?? new Uint8Array(),
      }
    : undefined;
  if (
    config.VERY_WEB_ENABLED &&
    (veryWebOptions === undefined || !validVeryWebOptions(veryWebOptions))
  ) {
    throw new Error("HTTP worker configuration is incomplete or invalid");
  }
  const controlPlane = makeHyperdriveControlPlaneLayer(loadHyperdrive(bindings));
  const hnsCommunityAppApi = makeProductionHnsCommunityAppApiComposition({
    config,
    authority_source: makeControlPlaneHnsCommunityAppHostAuthoritySource(controlPlane),
    ...(bindings.HNS_COMMUNITY_APP_API_REPLAY === undefined
      ? {}
      : { replay_namespace: bindings.HNS_COMMUNITY_APP_API_REPLAY }),
  });
  const identityStore = makeControlPlaneIdentityStore(controlPlane);
  const resolvePrivyCredentialAccount = makeControlPlaneCredentialCanonicalResolver(controlPlane, {
    provider: "privy",
    providerAppId: config.PRIVY_APP_ID,
  });
  const publicProfileStore = makeControlPlanePublicProfileStore(controlPlane, identityStore);
  const communityStore = makeControlPlaneCommunityStore(controlPlane);
  const communityCreationStore = makeControlPlaneCommunityCreationStore(controlPlane, {
    namespace_provider_bindings: namespaceBindings,
  });
  const personaStore = makeControlPlanePersonaStore(controlPlane);
  const mediaServices = (() => {
    if (dependencies.media_services !== undefined) return dependencies.media_services;
    if (bindings.MEDIA_UPLOADS_ENABLED !== "true") return null;
    const accountId = bindings.MEDIA_INGRESS_R2_ACCOUNT_ID;
    const bucket = bindings.MEDIA_INGRESS_R2_BUCKET_NAME;
    const accessKeyId = bindings.MEDIA_INGRESS_R2_PRESIGN_ACCESS_KEY_ID;
    const secretAccessKey = bindings.MEDIA_INGRESS_R2_PRESIGN_SECRET_ACCESS_KEY;
    const ingress = bindings.MEDIA_INGRESS;
    const immutableOriginals = bindings.MEDIA_IMMUTABLE_ORIGINALS;
    if (
      accountId === undefined ||
      bucket === undefined ||
      accessKeyId === undefined ||
      secretAccessKey === undefined ||
      ingress === undefined ||
      immutableOriginals === undefined
    ) {
      throw new Error("HTTP worker configuration is incomplete or invalid");
    }
    return {
      store: makeMediaUploadStore(controlPlane),
      personaStore,
      presigner: makeR2MediaIngressPresigner({
        accountId,
        bucket,
        accessKeyId,
        secretAccessKey,
      }),
      sealer: makeR2MediaSealer({ ingress, immutableOriginals }),
      nowIso: () => new Date().toISOString(),
    } satisfies MediaSubmissionServices;
  })();
  const mediaHandlers =
    mediaServices === null
      ? {}
      : makeMediaUploadHandlers(makeMediaUploadApplicationCommands(mediaServices));
  const contentStore = makeControlPlaneContentStore(controlPlane);
  const textPostStore = makeControlPlaneTextSubmissionStore(controlPlane);
  const moderationStore = makeControlPlaneCommunityModerationStore(controlPlane);
  const ageAccessStore = makeControlPlaneAgeAccessStore(controlPlane);
  // The runtime is installed even when no provider credentials are enabled.
  // Unavailability is a durable manual-review result, never an allow fallback.
  const textModeration: TextModeration["Service"] = {
    evaluate: () => Effect.fail(new TextModerationProviderError({ reason: "unavailable" })),
  };
  const textModerationProvider = config.OPENAI_MODERATION_ENABLED
    ? makeOpenAiTextModerationProvider({
        apiKey: Redacted.value(config.OPENAI_API_KEY),
        model: config.OPENAI_MODERATION_MODEL,
        baseUrl: config.OPENAI_MODERATION_BASE_URL,
        timeoutMs: config.OPENAI_MODERATION_TIMEOUT_MS,
        ...(dependencies.openai_moderation_transport === undefined
          ? {}
          : { transport: dependencies.openai_moderation_transport }),
      })
    : {
        evaluate: () =>
          Effect.fail(new TextModerationProviderError({ reason: "unavailable" as const })),
      };
  const feedStore = makeControlPlaneFeedStore(controlPlane);
  const fundingJournal = makeControlPlaneCommunityPurchaseFundingStore(controlPlane);
  const fundingProducer = makeControlPlaneCommunityPurchaseFundingProducerStore(controlPlane);
  const fundingInterpreter = makeCommunityPurchaseFundingInterpreter(fundingJournal);
  const fundingQuery = makeControlPlaneCommunityPurchaseFundingQueryStore(controlPlane);
  const fundingObservation = makeCommunityPurchaseFundingObservationUseCase(
    fundingInterpreter,
    makeCommunityPurchaseFundingChainReader({
      rpcUrl: fundingRpcUrl(
        Redacted.value(config.COMMUNITY_PURCHASE_FUNDING_RPC_URL),
        config.API_NEXT_ENV,
      ),
    }),
  );
  const fundingHandlers = {
    ...makeCommunityPurchaseFundingObservationHandlers({
      observation: fundingObservation,
      query: fundingQuery,
    }),
    ...makeCommunityPurchaseFundingQuoteHandlers({ producer: fundingProducer }),
  };
  const callbackCredentialHeaderNames = callbackCredentialHeaders(
    config.VERIFICATION_CALLBACK_CREDENTIAL_HEADERS,
  );
  const selfPassOrigin = publicHttpsOrigin(config.PIRATE_API_PUBLIC_ORIGIN);
  if (
    config.SELF_PASS_ENABLED &&
    (selfPassOrigin === undefined ||
      config.SELF_PASS_APP_NAME.trim() !== config.SELF_PASS_APP_NAME ||
      config.SELF_PASS_APP_NAME === "" ||
      config.SELF_PASS_APP_NAME.length > 128 ||
      (config.API_NEXT_ENV === "production" && config.SELF_PASS_MOCK_PASSPORT))
  ) {
    throw new Error("HTTP worker configuration is incomplete or invalid");
  }
  if (
    (config.API_NEXT_ENV === "production" && config.ZKPASSPORT_DEV_MODE) ||
    (config.ZKPASSPORT_ENABLED &&
      (config.ZKPASSPORT_DOMAIN.trim() === "" ||
        config.ZKPASSPORT_NAME.trim() === "" ||
        config.ZKPASSPORT_NAME.trim() !== config.ZKPASSPORT_NAME ||
        config.ZKPASSPORT_VERIFIER_URL.trim() === "" ||
        zkPassportBearerSecret.trim() === "" ||
        zkPassportBearerSecret.trim() !== zkPassportBearerSecret ||
        zkPassportSigningSecret.trim() === "" ||
        zkPassportSigningSecret.trim() !== zkPassportSigningSecret ||
        zkPassportBearerSecret === zkPassportSigningSecret ||
        !isSigningKeyId(config.ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_KEY_ID) ||
        (!previousSigningKeyAbsent && !previousSigningKeyComplete) ||
        (config.API_NEXT_ENV === "production" && config.ZKPASSPORT_DEV_MODE)))
  ) {
    throw new Error("HTTP worker configuration is incomplete or invalid");
  }
  const veryOauthOptions = config.VERY_OAUTH_ENABLED
    ? {
        authorization_endpoint: config.VERY_OAUTH_AUTHORIZATION_ENDPOINT,
        token_endpoint: config.VERY_OAUTH_TOKEN_ENDPOINT,
        userinfo_endpoint: config.VERY_OAUTH_USERINFO_ENDPOINT,
        issuer: config.VERY_OAUTH_ISSUER,
        jwks_url: config.VERY_OAUTH_JWKS_URL,
        client_id: config.VERY_OAUTH_CLIENT_ID,
        client_secret: veryOauthClientSecret,
        redirect_uri: config.VERY_OAUTH_REDIRECT_URI,
        sealing_key: veryOauthSealingKey ?? new Uint8Array(),
      }
    : undefined;
  if (
    config.VERY_OAUTH_ENABLED &&
    (veryOauthOptions === undefined || !validVeryOauthOptions(veryOauthOptions))
  ) {
    throw new Error("HTTP worker configuration is incomplete or invalid");
  }
  const verificationRegistry = await Effect.runPromise(
    makePlatformVerificationProviderRegistry({
      ...(config.SELF_PASS_ENABLED && selfPassOrigin !== undefined
        ? {
            self_pass: {
              callback_origin: selfPassOrigin,
              app_name: config.SELF_PASS_APP_NAME,
              mock_passport: config.SELF_PASS_MOCK_PASSPORT,
            },
          }
        : {}),
      ...(config.ZKPASSPORT_ENABLED
        ? {
            zkpassport: {
              domain: config.ZKPASSPORT_DOMAIN,
              name: config.ZKPASSPORT_NAME,
              ...(config.ZKPASSPORT_LOGO.trim() === "" ? {} : { logo: config.ZKPASSPORT_LOGO }),
              verifier_url: config.ZKPASSPORT_VERIFIER_URL,
              verifier_shared_secret: zkPassportBearerSecret,
              verifier_response_signing_secret: zkPassportSigningSecret,
              verifier_response_signing_key_id: config.ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_KEY_ID,
              ...(previousSigningKeyComplete
                ? {
                    previous_verifier_response_signing_key: {
                      key_id: config.ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_KEY_ID,
                      secret: zkPassportPreviousSigningSecret,
                      valid_until: config.ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_VALID_UNTIL,
                    },
                  }
                : {}),
              dev_mode: config.ZKPASSPORT_DEV_MODE,
            },
          }
        : {}),
      ...(veryOauthOptions === undefined ? {} : { very_oauth: veryOauthOptions }),
      ...(veryWebOptions === undefined ? {} : { very_web: veryWebOptions }),
      callback_credential_headers: callbackCredentialHeaderNames,
    }),
  );
  const verificationCompletionStore = makeControlPlaneVerificationCompletionStore(controlPlane);
  const verificationIntents: VerificationIntentResolver = makeOrderedVerificationIntentResolver([
    makeControlPlaneCommunityCreationIntentResolver(controlPlane, config.API_NEXT_ENV),
    makeControlPlaneCommunityJoinIntentResolver(controlPlane, config.API_NEXT_ENV),
    makeStaticVerificationIntentResolver(verificationRegistry.list(), config.API_NEXT_ENV),
  ]);
  const verificationHandlers = makeVerificationHandlers({
    start: {
      intents: verificationIntents,
      registry: verificationRegistry,
      store: makeControlPlaneVerificationSessionStartStore(controlPlane),
    },
    completion: {
      registry: verificationRegistry,
      store: verificationCompletionStore,
      hasher: makeSha256VerificationCompletionHasher(),
    },
    callback_credential_headers: callbackCredentialHeaderNames,
  });
  const productHandlers = makeProductHandlers({
    communityStore,
    contentStore,
    textPostStore,
    textModeration,
    textPostStoreV2: textPostStore,
    textModerationProvider,
    personaStore,
    feedStore,
    identityStore,
    moderationStore,
    ageAccessStore,
  });
  const communityCreationHandlers = makeCommunityCreationHandlers({
    communityCreationStore,
    personaStore,
  });
  const canonicalCommunityRouteHandlers = makeCanonicalCommunityRouteHandlers({
    canonicalCommunityRouteStore: makeControlPlaneCanonicalCommunityRouteStore(controlPlane),
  });
  // The route is installed before any provider is enabled so durable terminal
  // replays remain available. The same explicit configuration owns both the
  // creation binding above and this registry; no provider may exist in only
  // one side of the ceremony.
  const namespaceOwnershipHandlers = makeNamespaceOwnershipHandlers({
    start: {
      intents: makeControlPlaneNamespaceOwnershipStartAuthorityResolver(controlPlane),
      registry: namespaceOwnershipRegistry,
      store: makeControlPlaneNamespaceOwnershipStartStore(controlPlane),
      environment: config.API_NEXT_ENV,
    },
    completion: {
      registry: namespaceOwnershipRegistry,
      store: makeControlPlaneNamespaceOwnershipCompletionStore(controlPlane),
    },
  });
  const sessionCrypto = await makeSessionCrypto({
    privateKeyPem: Redacted.value(config.PIRATE_APP_JWT_PRIVATE_KEY),
    publicKeyPem: Redacted.value(config.PIRATE_APP_JWT_PUBLIC_KEY),
    issuer: config.PIRATE_APP_JWT_ISSUER,
    audience: config.PIRATE_APP_JWT_AUDIENCE,
    defaultScope: config.PIRATE_APP_JWT_SCOPE,
    defaultTtlSeconds: config.PIRATE_APP_JWT_TTL_SECONDS,
  });
  const proofVerifier = makeJwksSessionProofVerifier({
    privy: {
      jwksUrl: config.PRIVY_JWKS_URL,
      issuer: config.PRIVY_JWT_ISSUER,
      audience: config.PRIVY_JWT_AUDIENCE,
    },
    privyApi: {
      apiUrl: config.PRIVY_API_URL,
      appId: config.PRIVY_APP_ID,
      appSecret: Redacted.value(config.PRIVY_APP_SECRET),
    },
  });
  const personaHandlers = makePersonaHandlers({
    personas: {
      store: personaStore,
      nextPersonaId: () => Effect.sync(() => `persona_${crypto.randomUUID().replaceAll("-", "")}`),
      nowIso: () => Effect.sync(() => new Date().toISOString()),
    },
    wallets: {
      store: makeControlPlanePersonaWalletStore(controlPlane),
      verifier: proofVerifier,
      accounts: {
        canonicalAccountId: (sourceUserId) =>
          resolvePrivyCredentialAccount(sourceUserId).pipe(
            Effect.map((identity) => identity.canonicalUserId),
          ),
      },
    },
  });
  const activityQualificationHandlers = makeActivityQualificationHandlers({
    clock: { now: Effect.sync(() => Date.now()) },
    ids: { next: Effect.sync(() => crypto.randomUUID().replaceAll("-", "")) },
    store: makeControlPlaneActivityQualificationStore(controlPlane),
    studyItemSource: dependencies.study_item_source ?? {
      getForAcceptedSongRevision: () =>
        Effect.fail(new StudyItemSourceError({ reason: "unavailable" })),
    },
  });
  const studyV2Handlers = makeStudyV2Handlers({
    clock: { now: Effect.sync(() => Date.now()) },
    ids: { next: Effect.sync(() => crypto.randomUUID().replaceAll("-", "")) },
    store: makeControlPlaneStudyV2Store(controlPlane),
    ...(dependencies.study_batch_transcriber === undefined
      ? {}
      : {
          spoken: {
            transcriber: dependencies.study_batch_transcriber,
            archive:
              dependencies.study_audio_archive ?? makeR2StudyAudioArchive(bindings.LEARNER_AUDIO),
          },
        }),
  });
  const karaokeReadinessHandlers = makeKaraokeReadinessHandlers(
    makeControlPlaneKaraokeReadinessStore(controlPlane),
  );
  const karaokeHandlers = (() => {
    if (bindings.KARAOKE_ATTEMPT === undefined) return {};
    const service = makeKaraokeService({
      publicOrigin: config.PIRATE_API_PUBLIC_ORIGIN,
      runtime: makeDurableObjectKaraokeRuntimeGateway(bindings.KARAOKE_ATTEMPT),
      store: makeControlPlaneKaraokeStore(controlPlane),
    });
    const run = <A>(effect: Effect.Effect<A, KaraokeFailure, Clock | IdGen>) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provideService(Clock, { now: Effect.sync(() => Date.now()) }),
          Effect.provideService(IdGen, {
            next: Effect.sync(() => crypto.randomUUID().replaceAll("-", "")),
          }),
          Effect.mapError((failure) => {
            if (failure._tag === "KaraokeStoreFailed") {
              return new InternalError({ message: "Karaoke operation failed" });
            }
            switch (failure.reason) {
              case "not-found":
                return new NotFound({ message: "Karaoke target is unavailable" });
              case "idempotency-conflict":
                return new Conflict({ message: "Karaoke command conflicts" });
              case "provider-unavailable":
                return new ProviderUnavailable({ message: "Karaoke scoring is unavailable" });
              case "invalid-input":
              case "session-expired":
                return new BadRequest({ message: "Karaoke command is invalid" });
            }
          }),
        ),
      );
    return makeKaraokeHandlers({
      createAttempt: (input) =>
        run(
          service.createAttempt({
            accountId: input.userId,
            clientContext: input.clientContext,
            communityId: input.communityId,
            idempotencyKey: input.idempotencyKey,
            personaId: input.personaId,
            postId: input.postId,
            timezone: input.timezone,
          }),
        ),
      getAttempt: (input) =>
        run(
          service.getAttempt({
            accountId: input.userId,
            attemptId: input.attemptId,
            communityId: input.communityId,
          }),
        ),
      getLeaderboard: (input) =>
        run(
          service.getLeaderboard({
            accountId: input.userId,
            communityId: input.communityId,
            limit: input.limit ?? 50,
            postId: input.postId,
          }),
        ),
    });
  })();
  const handleSalesHandlers = makeHandleSalesHandlers({
    store: makeControlPlaneHandleSalesStore(controlPlane),
    ids: { next: Effect.sync(() => crypto.randomUUID().replaceAll("-", "")) },
    tokenVault: makeHandleRecipientTokenVault({
      hmacKeys: Redacted.value(config.HANDLE_RECIPIENT_TOKEN_HMAC_KEYS),
      envelopeKeys: Redacted.value(config.HANDLE_RECIPIENT_TOKEN_ENVELOPE_KEYS),
    }),
  });
  const platformPirateHandleHandlers = makePlatformPirateHandleHandlers(
    makeControlPlanePlatformPirateHandleStore(controlPlane),
  );
  const songRewardOfferHandlers: Readonly<Record<string, EndpointHandler>> =
    config.MEGAPOT_REWARDS_ENABLED
      ? await (async () => {
          try {
            const observationStore = makeControlPlaneMegapotDrawingObservationStore(controlPlane);
            const candidate = await Effect.runPromise(
              observationStore.loadCandidate(config.MEGAPOT_ATTESTATION_ID),
            );
            const rpc = makeMegapotV2RpcClient({
              rpcUrl: fundingRpcUrl(Redacted.value(config.MEGAPOT_V2_RPC_URL), config.API_NEXT_ENV),
              attestation: {
                attestationId: candidate.attestationId,
                environment: candidate.environment,
                chainId: candidate.chainId,
                jackpotAddress: candidate.jackpotAddress,
                ticketNftAddress: candidate.ticketNftAddress,
                usdcAddress: candidate.usdcAddress,
                custodyAddress: candidate.custodyAddress,
                referrerAddress: candidate.referrerAddress,
                jackpotCodeHash: candidate.jackpotCodeHash,
                ticketNftCodeHash: candidate.ticketNftCodeHash,
                usdcCodeHash: candidate.usdcCodeHash,
              },
            });
            const rewardFundingStore = makeControlPlaneRewardFundingStore(controlPlane);
            return makeSongRewardOfferHandlers({
              clock: { now: Effect.sync(() => Date.now()) },
              ids: { next: Effect.sync(() => crypto.randomUUID().replaceAll("-", "")) },
              store: makeControlPlaneSongRewardOfferStore(controlPlane),
              fundingStore: rewardFundingStore,
              projections: makeControlPlaneRewardProjectionStore(controlPlane),
              funding: makeRewardFundingCoordinator({ store: rewardFundingStore, rpc }),
              requiredConfirmations: config.MEGAPOT_REQUIRED_CONFIRMATIONS,
              externalFallbackPolicy: null,
            });
          } catch {
            throw new Error("HTTP worker configuration is incomplete or invalid");
          }
        })()
      : {};
  const tokenMinter = makeRs256SessionTokenMinter(sessionCrypto);
  const sessionExchange = {
    proofVerifier,
    identityStore: makePrivySessionIdentityStore({
      providerAppId: config.PRIVY_APP_ID,
      credentials: makeControlPlanePrivySessionCredentialStore(controlPlane),
      canonicalIdentities: makeSessionIdentityStore(identityStore),
    }),
    tokenMinter,
    productReadiness: makeControlPlaneSessionProductReadiness(controlPlane),
  };
  const identityRegistration = {
    providerAppId: config.PRIVY_APP_ID,
    proofVerifier,
    registration: {
      candidates: makeRandomIdentityRegistrationCandidateSource(),
      store: makeControlPlaneIdentityRegistrationStore(controlPlane),
    },
    tokenMinter,
    productReadiness: makeControlPlaneSessionProductReadiness(controlPlane),
    rateLimiter: makeProductionIdentityRegistrationRateLimiter(bindings, config.API_NEXT_ENV),
  };
  const tokenVerifier = makeRs256SessionTokenVerifier(sessionCrypto, identityStore, {
    additionalUserScopes: [PERSONA_WALLET_SETUP_SESSION_SCOPE],
  });
  const authenticate = ({
    credentials,
  }: {
    readonly credentials: { readonly authorization?: string; readonly sessionCookie?: string };
  }) =>
    Effect.runPromise(
      authenticateSession(
        {
          ...(credentials.authorization === undefined
            ? {}
            : { authorization: credentials.authorization }),
          ...(credentials.sessionCookie === undefined
            ? {}
            : { sessionCookie: credentials.sessionCookie }),
        },
        { verifier: tokenVerifier },
      ).pipe(Effect.map(principal)),
    );
  const profile: EndpointHandler = ({ principal: session }) =>
    Effect.runPromise(getMyProfile({ userId: session?.subject ?? "" }, { identityStore }));
  const publicProfile = makePublicProfileHandler({ publicProfileStore });

  return createHttpWorker({
    config: { corsOrigin: config.CORS_ORIGIN },
    hnsCommunityAppApi,
    handlers: {
      ...productHandlers,
      ...communityCreationHandlers,
      ...canonicalCommunityRouteHandlers,
      ...namespaceOwnershipHandlers,
      ...verificationHandlers,
      ...fundingHandlers,
      ...personaHandlers,
      ...activityQualificationHandlers,
      ...karaokeReadinessHandlers,
      ...karaokeHandlers,
      ...studyV2Handlers,
      ...handleSalesHandlers,
      ...platformPirateHandleHandlers,
      ...songRewardOfferHandlers,
      ...mediaHandlers,
      GetJwks: () => sessionCrypto.jwks(),
      GetPublicProfileByHandle: publicProfile,
    },
    beforeDecode: makeLegacyModerationActionCompatibility(moderationStore),
    sessionExchange,
    identityRegistration,
    profile,
    authenticate,
    authorize: ({ endpoint, input }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* authorizeSession({
            session: {
              subject: input.principal?.subject ?? "",
              kind: input.principal?.kind ?? "device",
              ...(input.principal?.scopes === undefined ? {} : { scopes: input.principal.scopes }),
            },
            allowedKinds: ["user", "admin"],
          });
          if (input.principal?.scopes?.includes(PERSONA_WALLET_SETUP_SESSION_SCOPE)) {
            const setupPath =
              endpoint.method === "POST" &&
              (endpoint.path === "/personas/:personaId/wallets/evm/prepare" ||
                endpoint.path === "/personas/:personaId/wallets/evm/confirm" ||
                endpoint.path === "/personas/:personaId/retire");
            if (!setupPath) return yield* new AuthError({ message: "Authorization failed" });
          }
          const ageAttestationExempt =
            endpoint.path === "/me/minimum-age-attestation" ||
            endpoint.path === "/auth/session/logout";
          if (!ageAttestationExempt) {
            const attested = yield* ageAccessStore.hasMinimumAgeAttestation({
              accountId: input.principal?.subject ?? "",
            });
            if (!attested) {
              return yield* new AuthError({ message: "Minimum age attestation required" });
            }
          }
        }),
      ),
  });
}
