import { getMyProfile } from "@pirate/application/use-cases/profile";
import {
  type AuthenticatedSession,
  authenticateSession,
  authorizeSession,
} from "@pirate/application/use-cases/session-authentication";
import { makeNotImplementedSessionExchangeServices } from "@pirate/application/use-cases/session-exchange";
import {
  HttpWorkerConfig,
  type HttpWorkerConfigValue,
  loadConfigFrom,
} from "@pirate/platform-cf/config";
import { Effect } from "effect";
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
  };
}

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

function principal(session: AuthenticatedSession): Principal {
  return {
    kind: session.kind,
    subject: session.subject,
    ...(session.scopes === undefined ? {} : { scopes: session.scopes }),
  };
}

export async function createProductionHttpWorker(bindings: HttpWorkerBindings) {
  const config = loadWorkerConfig(bindings);
  const sessionExchange = makeNotImplementedSessionExchangeServices();
  const authenticate = ({
    credentials,
  }: {
    readonly credentials: { readonly authorization: string };
  }) =>
    Effect.runPromise(
      authenticateSession({ authorization: credentials.authorization }).pipe(Effect.map(principal)),
    );
  const profile: EndpointHandler = ({ principal: session }) =>
    Effect.runPromise(getMyProfile({ userId: session?.subject ?? "" }));

  return createHttpWorker({
    config: { corsOrigin: config.CORS_ORIGIN },
    sessionExchange,
    profile,
    authenticate,
    authorize: ({ input }) =>
      Effect.runPromise(authorizeSession({ subject: input.principal?.subject ?? "" })),
  });
}
