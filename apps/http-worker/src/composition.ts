import {
  makeCommunityPurchaseFundingInterpreter,
  makeCommunityPurchaseFundingObservationUseCase,
} from "@pirate/application/use-cases/community-purchase-funding-observation";
import { makeRandomIdentityRegistrationCandidateSource } from "@pirate/application/use-cases/identity-registration";
import { getMyProfile } from "@pirate/application/use-cases/profile";
import { makePublicProfileHandler } from "@pirate/application/use-cases/public-profile";
import {
  type AuthenticatedSession,
  authenticateSession,
  authorizeSession,
} from "@pirate/application/use-cases/session-authentication";
import { makeSessionIdentityStore } from "@pirate/application/use-cases/session-exchange";
import type { VerificationIntentResolver } from "@pirate/application/use-cases/verification-start";
import { makeCommunityPurchaseFundingChainReader } from "@pirate/platform-cf/community-purchase-funding-chain-reader";
import {
  makeControlPlaneCommunityPurchaseFundingProducerStore,
  makeControlPlaneCommunityPurchaseFundingQueryStore,
  makeControlPlaneCommunityPurchaseFundingStore,
} from "@pirate/platform-cf/community-purchase-funding-repository";
import { makeControlPlaneCommunityStore } from "@pirate/platform-cf/community-repository";
import {
  HttpWorkerConfig,
  type HttpWorkerConfigValue,
  loadConfigFrom,
} from "@pirate/platform-cf/config";
import { makeControlPlaneContentStore } from "@pirate/platform-cf/content-repository";
import { makeControlPlaneFeedStore } from "@pirate/platform-cf/feed-repository";
import {
  makeControlPlaneIdentityRegistrationStore,
  makeControlPlaneIdentityStore,
} from "@pirate/platform-cf/identity-repository";
import {
  type HyperdriveConnection,
  makeHyperdriveControlPlaneLayer,
} from "@pirate/platform-cf/postgres";
import { makeControlPlanePublicProfileStore } from "@pirate/platform-cf/public-profile-repository";
import {
  makeDurableObjectIdentityRegistrationRateLimiter,
  type RegistrationRateLimiterNamespaces,
} from "@pirate/platform-cf/registration-rate-limiter";
import { makeSessionCrypto } from "@pirate/platform-cf/session-crypto";
import { makeJwksSessionProofVerifier } from "@pirate/platform-cf/session-proof";
import {
  makeRs256SessionTokenMinter,
  makeRs256SessionTokenVerifier,
} from "@pirate/platform-cf/session-tokens";
import {
  makeControlPlaneVerificationCompletionStore,
  makeSha256VerificationCompletionHasher,
} from "@pirate/platform-cf/verification-completion-repository";
import { makeStaticVerificationIntentResolver } from "@pirate/platform-cf/verification-intent-resolver";
import { makePlatformVerificationProviderRegistry } from "@pirate/platform-cf/verification-provider-registry";
import { makeControlPlaneVerificationSessionStartStore } from "@pirate/platform-cf/verification-start-repository";
import { Effect, Redacted, Schema } from "effect";
import {
  makeCommunityPurchaseFundingObservationHandlers,
  makeCommunityPurchaseFundingQuoteHandlers,
} from "./community-purchase-funding-handlers.ts";
import { makeProductHandlers } from "./product-handlers.ts";
import { createHttpWorker, type EndpointHandler, type Principal } from "./transport.ts";
import { makeVerificationHandlers } from "./verification-handlers.ts";

export interface HttpWorkerBindings {
  readonly CONTROL_PLANE?: unknown;
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
  };
}

const HyperdriveBinding = Schema.Struct({
  connectionString: Schema.NonEmptyString,
});

function loadWorkerConfig(bindings: HttpWorkerBindings): WorkerConfig {
  try {
    const config = loadConfigFrom(HttpWorkerConfig, configSource(bindings));
    if (config.PIRATE_APP_JWT_TTL_SECONDS <= 0) throw new Error("invalid TTL");
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

export async function createProductionHttpWorker(bindings: HttpWorkerBindings) {
  const config = loadWorkerConfig(bindings);
  const zkPassportBearerSecret = Redacted.value(config.ZKPASSPORT_VERIFIER_SHARED_SECRET);
  const zkPassportSigningSecret = Redacted.value(
    config.ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_SECRET,
  );
  const zkPassportPreviousSigningSecret = Redacted.value(
    config.ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_SECRET,
  );
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
  const controlPlane = makeHyperdriveControlPlaneLayer(loadHyperdrive(bindings));
  const identityStore = makeControlPlaneIdentityStore(controlPlane);
  const publicProfileStore = makeControlPlanePublicProfileStore(controlPlane, identityStore);
  const communityStore = makeControlPlaneCommunityStore(controlPlane);
  const contentStore = makeControlPlaneContentStore(controlPlane);
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
      callback_credential_headers: callbackCredentialHeaderNames,
    }),
  );
  const verificationCompletionStore = makeControlPlaneVerificationCompletionStore(controlPlane);
  const verificationIntents: VerificationIntentResolver = makeStaticVerificationIntentResolver(
    verificationRegistry.list(),
    config.API_NEXT_ENV,
  );
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
    feedStore,
    identityStore,
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
  const tokenMinter = makeRs256SessionTokenMinter(sessionCrypto);
  const sessionExchange = {
    proofVerifier,
    identityStore: makeSessionIdentityStore(identityStore),
    tokenMinter,
  };
  const identityRegistration = {
    providerAppId: config.PRIVY_APP_ID,
    proofVerifier,
    registration: {
      candidates: makeRandomIdentityRegistrationCandidateSource(),
      store: makeControlPlaneIdentityRegistrationStore(controlPlane),
    },
    tokenMinter,
    rateLimiter: makeProductionIdentityRegistrationRateLimiter(bindings, config.API_NEXT_ENV),
  };
  const tokenVerifier = makeRs256SessionTokenVerifier(sessionCrypto, identityStore);
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
    handlers: {
      ...productHandlers,
      ...verificationHandlers,
      ...fundingHandlers,
      GetJwks: () => sessionCrypto.jwks(),
      GetPublicProfileByHandle: publicProfile,
    },
    sessionExchange,
    identityRegistration,
    profile,
    authenticate,
    authorize: ({ input }) =>
      Effect.runPromise(
        authorizeSession({
          session: {
            subject: input.principal?.subject ?? "",
            kind: input.principal?.kind ?? "device",
            ...(input.principal?.scopes === undefined ? {} : { scopes: input.principal.scopes }),
          },
          allowedKinds: ["user", "admin"],
        }),
      ),
  });
}
