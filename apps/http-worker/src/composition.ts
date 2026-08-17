import { getMyProfile } from "@pirate/application/use-cases/profile";
import { makePublicProfileHandler } from "@pirate/application/use-cases/public-profile";
import {
  type AuthenticatedSession,
  authenticateSession,
  authorizeSession,
} from "@pirate/application/use-cases/session-authentication";
import { makeSessionIdentityStore } from "@pirate/application/use-cases/session-exchange";
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
import { makeSessionBridge } from "@pirate/platform-cf/session-bridge";
import { makeJwksSessionProofVerifier } from "@pirate/platform-cf/session-proof";
import {
  makeRs256SessionTokenMinter,
  makeRs256SessionTokenVerifier,
} from "@pirate/platform-cf/session-tokens";
import { Effect, Redacted, Schema } from "effect";
import { makeProductHandlers } from "./product-handlers.ts";
import { createHttpWorker, type EndpointHandler, type Principal } from "./transport.ts";

export interface HttpWorkerBindings {
  readonly CONTROL_PLANE?: unknown;
  readonly API_NEXT_ENV?: string;
  readonly CORS_ORIGIN?: string;
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
  readonly AUTH_UPSTREAM_JWT_JWKS_URL?: string;
  readonly AUTH_UPSTREAM_JWT_ISSUER?: string;
  readonly AUTH_UPSTREAM_JWT_AUDIENCE?: string;
}

type WorkerConfig = HttpWorkerConfigValue;

function configSource(bindings: HttpWorkerBindings): Record<string, string | undefined> {
  return {
    API_NEXT_ENV: bindings.API_NEXT_ENV,
    CORS_ORIGIN: bindings.CORS_ORIGIN,
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
    AUTH_UPSTREAM_JWT_JWKS_URL: bindings.AUTH_UPSTREAM_JWT_JWKS_URL,
    AUTH_UPSTREAM_JWT_ISSUER: bindings.AUTH_UPSTREAM_JWT_ISSUER,
    AUTH_UPSTREAM_JWT_AUDIENCE: bindings.AUTH_UPSTREAM_JWT_AUDIENCE,
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

export async function createProductionHttpWorker(bindings: HttpWorkerBindings) {
  const config = loadWorkerConfig(bindings);
  const controlPlane = makeHyperdriveControlPlaneLayer(loadHyperdrive(bindings));
  const identityStore = makeControlPlaneIdentityStore(controlPlane);
  const publicProfileStore = makeControlPlanePublicProfileStore(controlPlane, identityStore);
  const communityStore = makeControlPlaneCommunityStore(controlPlane);
  const contentStore = makeControlPlaneContentStore(controlPlane);
  const feedStore = makeControlPlaneFeedStore(controlPlane);
  const productHandlers = makeProductHandlers({
    communityStore,
    contentStore,
    feedStore,
    identityStore,
  });
  const bridge = await makeSessionBridge({
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
      jwt: {
        jwksUrl: config.AUTH_UPSTREAM_JWT_JWKS_URL,
        issuer: config.AUTH_UPSTREAM_JWT_ISSUER,
        audience: config.AUTH_UPSTREAM_JWT_AUDIENCE,
      },
    }),
    identityStore: makeSessionIdentityStore(identityStore),
    tokenMinter: makeRs256SessionTokenMinter(bridge),
  };
  const tokenVerifier = makeRs256SessionTokenVerifier(bridge, identityStore);
  const authenticate = ({
    credentials,
  }: {
    readonly credentials: { readonly authorization: string };
  }) =>
    Effect.runPromise(
      authenticateSession(
        { authorization: credentials.authorization },
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
      GetJwks: () => bridge.jwks(),
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
