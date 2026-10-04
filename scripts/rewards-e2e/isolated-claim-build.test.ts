import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { makeVerificationProviderRegistry } from "@pirate/application/verification";
import { Effect } from "effect";
import { assertVerificationRegistryOverride } from "../../apps/http-worker/src/verification-registry-override.ts";
import { makeIsolatedRewardClaimProvider } from "../../tests/rewards-e2e/claim-provider.ts";
import { isIsolatedRequest } from "../../tests/rewards-e2e/resource-boundary.ts";
import {
  buildNormalRewardsJobsArtifact,
  buildRewardsHttpArtifact,
} from "./isolated-http-build.mjs";

const marker = "SIMULATED_REWARDS_CLAIM_VERIFICATION";
const digest = createHash("sha256").update("isolated_fixture_role").digest("hex");
const readRole = async () => "isolated_fixture_role";
const bindings = {
  API_NEXT_ENV: "development",
  CONTROL_PLANE: { connectionString: "postgres://isolated_fixture_role:fixture@localhost/db" },
};

test("normal staging and production Worker artifacts exclude simulated claim verification", async () => {
  for (const mode of ["staging", "production"]) {
    const build = await buildRewardsHttpArtifact(mode);
    expect(build.source).not.toContain(marker);
    expect(build.source).not.toContain("claim-ceremony-subject-");
    expect(build.inputPaths.some((path: string) => path.includes("reward-claim-stub"))).toBe(false);
  }
}, 30_000);

test("normal jobs Worker artifact excludes simulated claim verification", async () => {
  const build = await buildNormalRewardsJobsArtifact();
  expect(build.source).not.toContain(marker);
  expect(build.inputPaths.some((path: string) => path.includes("reward-claim-stub"))).toBe(false);
}, 30_000);

test("the separate isolated build includes the labelled adapter and compiled database pin", async () => {
  const build = await buildRewardsHttpArtifact("isolated", digest);
  expect(build.source).toContain(marker);
  expect(build.source).toContain(digest);
  expect(build.inputPaths.some((path: string) => path.includes("reward-claim-stub"))).toBe(true);
}, 30_000);

test("the isolated build requires a resource pin before compiling", async () => {
  await expect(buildRewardsHttpArtifact("isolated")).rejects.toThrow("role pin");
});

test("staging and production reject even a directly supplied registry override", async () => {
  const registry = await Effect.runPromise(
    makeVerificationProviderRegistry([makeIsolatedRewardClaimProvider()], { now: Date.now }),
  );
  for (const environment of ["staging", "production", undefined]) {
    expect(() => assertVerificationRegistryOverride(environment, registry)).toThrow("restricted");
  }
});

test("the adapter declares only the isolated development environment", () => {
  expect(makeIsolatedRewardClaimProvider().manifest.environments).toEqual(["development"]);
});

test("a copied test artifact cannot admit a shared origin or database role", async () => {
  const isolated = new Request("https://api-megapot-e2e-staging.pirate.sc/rewards/claim");
  expect(await isIsolatedRequest(isolated, bindings, digest, readRole)).toBe(true);
  expect(
    await isIsolatedRequest(
      new Request("https://api-next-staging.pirate.sc/rewards/claim"),
      bindings,
      digest,
      readRole,
    ),
  ).toBe(false);
  expect(
    await isIsolatedRequest(isolated, { ...bindings, API_NEXT_ENV: "staging" }, digest, readRole),
  ).toBe(false);
  expect(await isIsolatedRequest(isolated, bindings, "f".repeat(64), readRole)).toBe(false);
});

test("the pool username cannot substitute for a mismatched actual SQL role", async () => {
  const isolated = new Request("https://api-megapot-e2e-staging.pirate.sc/rewards/claim");
  expect(await isIsolatedRequest(isolated, bindings, digest, async () => "shared_role")).toBe(
    false,
  );
  const pooled = {
    ...bindings,
    CONTROL_PLANE: {
      connectionString: "postgres://provider_pool:fixture@localhost/db",
    },
  };
  expect(await isIsolatedRequest(isolated, pooled, digest, readRole)).toBe(true);
  expect(await isIsolatedRequest(isolated, pooled, digest, async () => "retargeted_role")).toBe(
    false,
  );
});

test("SQL identity failure never admits the adapter and shared origins never read the database", async () => {
  let reads = 0;
  const read = async () => {
    reads++;
    throw new Error("Private provider diagnostic");
  };
  expect(
    await isIsolatedRequest(
      new Request("https://api-next-staging.pirate.sc/"),
      bindings,
      digest,
      read,
    ),
  ).toBe(false);
  expect(reads).toBe(0);
  expect(
    await isIsolatedRequest(
      new Request("https://api-megapot-e2e-staging.pirate.sc/"),
      bindings,
      digest,
      read,
    ),
  ).toBe(false);
  expect(reads).toBe(1);
});
