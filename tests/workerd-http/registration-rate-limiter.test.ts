/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { runInDurableObject, env as testEnv } from "cloudflare:test";
import {
  type IdentityRegistrationHandlerServices,
  registerIdentityRequest,
} from "@pirate/application/use-cases/identity-registration-handler";
import { RateLimited, toErrorBody } from "@pirate/contracts";
import { Cause, Effect, Exit, Result } from "effect";
import { describe, expect, it } from "vitest";
import { makeUnverifiedIdentityAccount } from "../../packages/application/src/use-cases/identity-registration.ts";
import { makeDurableObjectIdentityRegistrationRateLimiter } from "../../packages/platform-cf/src/registration-rate-limiter.ts";
import type {
  RegistrationApplicationRateLimiterDO,
  RegistrationIpRateLimiterDO,
} from "../../packages/platform-cf/src/registration-rate-limiter-do.ts";

const env = testEnv as unknown as {
  readonly REGISTRATION_IP_LIMITER: DurableObjectNamespace<RegistrationIpRateLimiterDO>;
  readonly REGISTRATION_APPLICATION_LIMITER: DurableObjectNamespace<RegistrationApplicationRateLimiterDO>;
};

const currentWindowStart = (windowMs: number): number =>
  Math.floor(Date.now() / windowMs) * windowMs;

async function setWindow(
  stub: DurableObjectStub<RegistrationIpRateLimiterDO>,
  windowStartMs: number,
  count: number,
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE registration_rate_window SET window_start_ms = ?, count = ? WHERE id = 1",
      windowStartMs,
      count,
    );
  });
}

describe("registration Durable Object limiters", () => {
  it("increments, rejects at the boundary, and rolls to the next fixed window", async () => {
    const stub = env.REGISTRATION_IP_LIMITER.getByName(`rollover-${crypto.randomUUID()}`);
    expect((await stub.check()).allowed).toBe(true);
    await setWindow(stub, currentWindowStart(900_000), 5);

    const rejected = await stub.check();
    expect(rejected).toMatchObject({ allowed: false });
    expect(rejected.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(rejected.retryAfterSeconds).toBeLessThanOrEqual(900);

    await setWindow(stub, currentWindowStart(900_000) - 900_000, 5);
    expect(await stub.check()).toEqual({ allowed: true });
  });

  it("uses one singleton application object for the configured application name", async () => {
    const name = `singleton-${crypto.randomUUID()}`;
    const first = env.REGISTRATION_APPLICATION_LIMITER.getByName(name);
    const second = env.REGISTRATION_APPLICATION_LIMITER.getByName(name);
    await first.check();
    await setWindow(
      first as unknown as DurableObjectStub<RegistrationIpRateLimiterDO>,
      currentWindowStart(60_000),
      100,
    );
    const rejected = await second.check();
    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(env.REGISTRATION_APPLICATION_LIMITER.idFromName(name).toString()).toBe(
      env.REGISTRATION_APPLICATION_LIMITER.idFromName(name).toString(),
    );
  });

  it("carries the DO rejection through registration to Retry-After", async () => {
    const applicationName = `handler-${crypto.randomUUID()}`;
    const rateLimiter = makeDurableObjectIdentityRegistrationRateLimiter({
      namespaces: {
        ip: env.REGISTRATION_IP_LIMITER,
        application: env.REGISTRATION_APPLICATION_LIMITER,
      },
      applicationName,
    });
    const services: IdentityRegistrationHandlerServices = {
      providerAppId: "privy-workerd",
      proofVerifier: {
        verifyPrivy: () =>
          Effect.succeed({ sourceUserId: "did:privy:workerd", classification: "user" as const }),
      },
      registration: {
        candidates: {
          next: () =>
            Effect.succeed({
              credentialId: `credential-${applicationName}`,
              userId: `user-${applicationName}`,
              handleId: `handle-${applicationName}`,
              handleLabel: "workerd-registration.pirate",
              createdAt: new Date().toISOString(),
            }),
        },
        store: {
          registerCredential: () =>
            Effect.succeed({
              kind: "created" as const,
              canonicalUserId: `user-${applicationName}`,
              account: makeUnverifiedIdentityAccount({
                credentialId: `credential-${applicationName}`,
                userId: `user-${applicationName}`,
                handleId: `handle-${applicationName}`,
                handleLabel: "workerd-registration.pirate",
                createdAt: new Date().toISOString(),
              }),
            }),
        },
      },
      tokenMinter: {
        scope: "api-next-browser-session",
        ttlSeconds: 3_600,
        mint: () => Effect.succeed("workerd-session-token"),
      },
      rateLimiter,
    };

    const input = {
      body: { privy_access_token: "workerd-proof" },
      edgeClientIp: "198.51.100.23",
    };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await Effect.runPromise(registerIdentityRequest(input, services));
    }

    const exit = await Effect.runPromiseExit(registerIdentityRequest(input, services));
    if (!Exit.isFailure(exit)) throw new Error("expected registration to be rate limited");
    const failure = Cause.findError(exit.cause);
    if (!Result.isSuccess(failure)) throw new Error("expected typed registration failure");
    expect(failure.success).toBeInstanceOf(RateLimited);
    expect(toErrorBody(failure.success).headers?.["Retry-After"]).toMatch(/^[1-9][0-9]*$/u);
  });
});
