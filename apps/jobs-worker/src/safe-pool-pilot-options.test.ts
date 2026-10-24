import { expect, mock, test } from "bun:test";
import type { JobsWorkerConfigValue } from "@pirate/platform-cf/config";
import { Redacted } from "effect";
import type { JobsWorkerEnv } from "./index.ts";

mock.module("cloudflare:workers", () => ({ DurableObject: class DurableObject {} }));
const { makeSafePoolPilotOptions } = await import("./index.ts");

const config = (overrides: Partial<JobsWorkerConfigValue>) =>
  ({
    API_NEXT_ENV: "staging",
    MEGAPOT_REWARDS_ENABLED: false,
    MEGAPOT_REQUIRED_CONFIRMATIONS: 3,
    MEGAPOT_OBSERVATION_TTL_SECONDS: 300,
    SAFE_POOL_PILOT_ENABLED: true,
    SAFE_POOL_PRODUCTION_ENABLED: false,
    SAFE_POOL_ATTESTATION_ID: "megapot-base-sepolia-v2-safe-pilot",
    SAFE_POOL_RPC_URL: Redacted.make("https://rpc.invalid/"),
    SAFE_POOL_COMMITMENT_PUBLIC_ORIGIN: Redacted.make("https://commitments.invalid/"),
    SAFE_POOL_MINIMUM_ENTRY_SECONDS: 3_600,
    ...overrides,
  }) as JobsWorkerConfigValue;
const env = { MEGAPOT_COMMITMENTS: {} } as unknown as JobsWorkerEnv;

test("the pilot cycle admits by the worker's own environment, with the switch only in production", () => {
  expect(makeSafePoolPilotOptions(env, config({}))).toMatchObject({
    environment: "staging",
    productionEnabled: false,
  });
  expect(
    makeSafePoolPilotOptions(
      env,
      config({
        API_NEXT_ENV: "production",
        SAFE_POOL_PRODUCTION_ENABLED: true,
        SAFE_POOL_ATTESTATION_ID: "megapot-base-v2-safe-pilot",
      }),
    ),
  ).toMatchObject({ environment: "production", productionEnabled: true });
  expect(makeSafePoolPilotOptions(env, config({ SAFE_POOL_PILOT_ENABLED: false }))).toBeNull();
  for (const API_NEXT_ENV of ["development", "staging"] as const) {
    for (const SAFE_POOL_PILOT_ENABLED of [false, true]) {
      expect(() =>
        makeSafePoolPilotOptions(
          env,
          config({ API_NEXT_ENV, SAFE_POOL_PILOT_ENABLED, SAFE_POOL_PRODUCTION_ENABLED: true }),
        ),
      ).toThrow("Jobs worker configuration is incomplete or invalid");
    }
  }
});
