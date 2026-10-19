import { expect, test } from "bun:test";
import {
  assertStagingRewardsPreservation,
  preserveStagingRewardsConfiguration,
} from "./staging-rewards-config.ts";
import type { Binding, CandidateBindings, ServingVersion } from "./worker-binding-drift.ts";

const flag = (text: unknown): Binding => ({
  name: "MEGAPOT_REWARDS_ENABLED",
  type: "plain_text",
  text,
});
const context = {
  source_sha: "a".repeat(40),
  environment: "staging",
  config_path: "apps/jobs-worker/wrangler.jsonc",
};
const candidate: CandidateBindings = {
  worker_name: "jobs-staging",
  bindings: [flag("true"), { name: "OTHER", type: "plain_text", text: "keep" }],
  runtime: { compatibility_date: "2026-08-01" },
  required_secrets: ["EXISTING_SECRET"],
};
const serving = (
  bindings: readonly Binding[] = [flag("false")],
  version_id = "v1",
  percentage = 100,
): ServingVersion => ({ version_id, percentage, bindings, runtime: candidate.runtime });

test("disabled serving preserves exact false despite tracked true, without changing unrelated data", () => {
  for (const config_path of [
    "apps/http-worker/wrangler.jsonc",
    "apps/jobs-worker/wrangler.jsonc",
  ]) {
    const result = preserveStagingRewardsConfiguration({ ...context, config_path }, candidate, [
      serving(),
    ]);
    expect(result.disabledRewards).toBe("false");
    expect(result.candidate.bindings).toEqual([flag("false"), ...candidate.bindings.slice(1)]);
    expect(result.candidate.runtime).toBe(candidate.runtime);
    expect(result.candidate.required_secrets).toBe(candidate.required_secrets);
    expect(candidate.bindings[0]).toEqual(flag("true"));
  }
});

test("every traffic allocation must agree; false is preserved across multiple versions", () => {
  const result = preserveStagingRewardsConfiguration(context, candidate, [
    serving([flag("false")], "v1", 30),
    serving([flag("false")], "v2", 70),
  ]);
  expect(result.disabledRewards).toBe("false");
  expect(() =>
    preserveStagingRewardsConfiguration(context, candidate, [
      serving([flag("false")], "v1", 30),
      serving([flag("true")], "v2", 70),
    ]),
  ).toThrow("disagree");
});

test("missing, malformed, duplicated and non-plaintext serving values refuse preservation", () => {
  for (const bindings of [
    [],
    [flag(false)],
    [flag("FALSE")],
    [flag(" false")],
    [flag("false\n")],
    [flag("false"), flag("false")],
    [{ name: "MEGAPOT_REWARDS_ENABLED", type: "secret_text" }],
    [{ name: "MEGAPOT_REWARDS_ENABLED", type: "plain_text" }],
  ])
    expect(() =>
      preserveStagingRewardsConfiguration(context, candidate, [serving(bindings)]),
    ).toThrow("missing or invalid");
  expect(() => preserveStagingRewardsConfiguration(context, candidate, [])).toThrow(
    "serving versions",
  );
});

test("tracked candidate must also contain exactly one valid plaintext declaration", () => {
  for (const bindings of [
    [],
    [flag(true)],
    [flag("false"), flag("true")],
    [{ name: "MEGAPOT_REWARDS_ENABLED", type: "secret_text" }],
  ])
    expect(() =>
      preserveStagingRewardsConfiguration(context, { ...candidate, bindings }, [serving()]),
    ).toThrow("candidate");
});

test("serving true retains normal tracked configuration and creates no new activation path", () => {
  for (const text of ["false", "true"]) {
    const tracked = { ...candidate, bindings: [flag(text)] };
    expect(
      preserveStagingRewardsConfiguration(context, tracked, [serving([flag("true")])]),
    ).toEqual({ candidate: tracked });
  }
});

test("production and non-target Workers do not inherit disabled preservation", () => {
  for (const other of [
    { ...context, environment: "production" },
    { ...context, environment: "prod" },
    { ...context, config_path: "apps/media-worker/wrangler.jsonc" },
  ])
    expect(preserveStagingRewardsConfiguration(other, candidate, [])).toEqual({ candidate });
});

test("effective argument accepts only exact false for staging HTTP/Jobs, never a generic override", () => {
  for (const config of ["apps/http-worker/wrangler.jsonc", "apps/jobs-worker/wrangler.jsonc"]) {
    expect(() => assertStagingRewardsPreservation(config, "staging", "false")).not.toThrow();
    for (const value of ["true", "FALSE", false, null, {}, "false\n"])
      expect(() => assertStagingRewardsPreservation(config, "staging", value)).toThrow(
        "only to staging HTTP/Jobs",
      );
    expect(() => assertStagingRewardsPreservation(config, "prod", "false")).toThrow();
  }
  expect(() =>
    assertStagingRewardsPreservation("apps/media-worker/wrangler.jsonc", "staging", "false"),
  ).toThrow();
  expect(() =>
    assertStagingRewardsPreservation("apps/media-worker/wrangler.jsonc", "prod", undefined),
  ).not.toThrow();
});
