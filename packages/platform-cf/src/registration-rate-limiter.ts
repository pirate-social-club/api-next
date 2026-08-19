import {
  type IdentityRegistrationRateLimiter,
  RegistrationLimiterRejected,
  RegistrationLimiterUnavailable,
} from "@pirate/application/use-cases/identity-registration-handler";
import { Effect } from "effect";

export interface RegistrationRateLimiterDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds?: number;
}

type RegistrationLimiterStub = {
  readonly check: () => Promise<RegistrationRateLimiterDecision>;
};

type RegistrationRateLimiterNamespace = {
  readonly getByName: (name: string) => unknown;
};

export type RegistrationRateLimiterNamespaces = {
  readonly ip: RegistrationRateLimiterNamespace;
  readonly application: RegistrationRateLimiterNamespace;
};

const toLimiterEffect = (
  invoke: () => Promise<RegistrationRateLimiterDecision>,
): Effect.Effect<void, RegistrationLimiterRejected | RegistrationLimiterUnavailable> =>
  Effect.tryPromise({
    try: invoke,
    catch: () => new RegistrationLimiterUnavailable(),
  }).pipe(
    Effect.flatMap((decision) =>
      decision.allowed
        ? Effect.succeed(undefined)
        : Effect.fail(
            new RegistrationLimiterRejected(
              decision.retryAfterSeconds === undefined
                ? {}
                : { retryAfterSeconds: decision.retryAfterSeconds },
            ),
          ),
    ),
  );

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** Platform adapter for the two mandatory registration limiter namespaces. */
export function makeDurableObjectIdentityRegistrationRateLimiter(input: {
  readonly namespaces: RegistrationRateLimiterNamespaces;
  readonly applicationName: string;
}): IdentityRegistrationRateLimiter {
  if (input.applicationName.trim() === "") {
    throw new Error("Registration application name is required");
  }
  return {
    checkIp: ({ ip }) =>
      Effect.tryPromise({
        try: async () => {
          const name = `ip:${await sha256Hex(ip)}`;
          return input.namespaces.ip.getByName(name) as RegistrationLimiterStub;
        },
        catch: () => new RegistrationLimiterUnavailable(),
      }).pipe(Effect.flatMap((stub) => toLimiterEffect(() => stub.check()))),
    checkApplication: () =>
      toLimiterEffect(() =>
        (
          input.namespaces.application.getByName(
            `application:${input.applicationName}`,
          ) as RegistrationLimiterStub
        ).check(),
      ),
  };
}
