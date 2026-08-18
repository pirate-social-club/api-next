import { getMyProfile } from "@pirate/application/use-cases/profile";
import { makePublicProfileHandler } from "@pirate/application/use-cases/public-profile";
import {
  type AuthenticatedSession,
  authenticateSession,
  authorizeSession,
} from "@pirate/application/use-cases/session-authentication";
import { makeSessionIdentityStore } from "@pirate/application/use-cases/session-exchange";
import type { VerificationIntentResolver } from "@pirate/application/use-cases/verification-start";
import { makeControlPlaneCommunityStore } from "@pirate/platform-cf/community-repository";
import {
  HttpWorkerConfig,
  type HttpWorkerConfigValue,
  loadConfigFrom,
} from "@pirate/platform-cf/config";
import { makeControlPlaneContentStore } from "@pirate/platform-cf/content-repository";
import { makeControlPlaneFeedStore } from "@pirate/platform-cf/feed-repository";
import { makeControlPlaneIdentityStore } from "@pirate/platform-cf/identity-repository";
import {
  type HyperdriveConnection,
  makeHyperdriveControlPlaneLayer,
} from "@pirate/platform-cf/postgres";
import { makeControlPlanePublicProfileStore } from "@pirate/platform-cf/public-profile-repository";
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
import { makeProductHandlers } from "./product-handlers.ts";
import { createHttpWorker, type EndpointHandler, type Principal } from "./transport.ts";
import { makeVerificationHandlers } from "./verification-handlers.ts";

export interface HttpWorkerBindings {
  readonly CONTROL_PLANE?: unknown;
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
  readonly ZKPASSPORT_DEV_MODE?: string;
  readonly VERIFICATION_CALLBACK_CREDENTIAL_HEADERS?: string;
  readonly PIRATE_APP_JWT_PRIVATE_KEY?: string;
  readonly PIRATE_APP_JWT_PUBLIC_KEY?: string;
  readonly PIRATE_APP_JWT_ISSUER?: string;
  readonly PIRATE_APP_JWT_AUDIENCE?: string;
  readonly PIRATE_APP_JWT_TTL_SECONDS?: string;
  readonly PRIVY_APP_ID?: string;
  readonly PRIVY_APP_SECRET?: string;
  readonly PRIVY_API_URL?: string;
  readonly PRIVY_JWKS_URL?: string;
  readonly PRIVY_JWT_ISSUER?: string;
  readonly PRIVY_JWT_AUDIENCE?: string;
}

type WorkerConfig = HttpWorkerConfigValue;

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
    ZKPASSPORT_DEV_MODE: bindings.ZKPASSPORT_DEV_MODE,
    VERIFICATION_CALLBACK_CREDENTIAL_HEADERS: bindings.VERIFICATION_CALLBACK_CREDENTIAL_HEADERS,
    PIRATE_APP_JWT_PRIVATE_KEY: bindings.PIRATE_APP_JWT_PRIVATE_KEY,
    PIRATE_APP_JWT_PUBLIC_KEY: bindings.PIRATE_APP_JWT_PUBLIC_KEY,
    PIRATE_APP_JWT_ISSUER: bindings.PIRATE_APP_JWT_ISSUER,
    PIRATE_APP_JWT_AUDIENCE: bindings.PIRATE_APP_JWT_AUDIENCE,
    PIRATE_APP_JWT_TTL_SECONDS: bindings.PIRATE_APP_JWT_TTL_SECONDS,
    PRIVY_APP_ID: bindings.PRIVY_APP_ID,
    PRIVY_APP_SECRET: bindings.PRIVY_APP_SECRET,
    PRIVY_API_URL: bindings.PRIVY_API_URL,
    PRIVY_JWKS_URL: bindings.PRIVY_JWKS_URL,
    PRIVY_JWT_ISSUER: bindings.PRIVY_JWT_ISSUER,
    PRIVY_JWT_AUDIENCE: bindings.PRIVY_JWT_AUDIENCE,
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

export async function createProductionHttpWorker(bindings: HttpWorkerBindings) {
  const config = loadWorkerConfig(bindings);
  const controlPlane = makeHyperdriveControlPlaneLayer(loadHyperdrive(bindings));
  const identityStore = makeControlPlaneIdentityStore(controlPlane);
  const publicProfileStore = makeControlPlanePublicProfileStore(controlPlane, identityStore);
  const communityStore = makeControlPlaneCommunityStore(controlPlane);
  const contentStore = makeControlPlaneContentStore(controlPlane);
  const feedStore = makeControlPlaneFeedStore(controlPlane);
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
        config.ZKPASSPORT_VERIFIER_SHARED_SECRET.trim() === "" ||
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
              verifier_shared_secret: config.ZKPASSPORT_VERIFIER_SHARED_SECRET,
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
    defaultTtlSeconds: config.PIRATE_APP_JWT_TTL_SECONDS,
  });
  const sessionExchange = {
    proofVerifier: makeJwksSessionProofVerifier({
      privy: {
        jwksUrl: config.PRIVY_JWKS_URL,
        issuer: config.PRIVY_JWT_ISSUER,
        audience: config.PRIVY_JWT_AUDIENCE,
      },
    }),
    identityStore: makeSessionIdentityStore(identityStore),
    tokenMinter: makeRs256SessionTokenMinter(sessionCrypto),
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
      GetJwks: () => sessionCrypto.jwks(),
      GetPublicProfileByHandle: publicProfile,
    },
    sessionExchange,
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
