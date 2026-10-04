import { expect, test } from "bun:test";
import {
  baseline,
  hyperdrive,
  releaseBranch,
  validateDependencies,
  validatePinnedSource,
  validateProductionConfig,
} from "./deploy-hns-pinned-production.mjs";

const sha = "a".repeat(40);
const source = () => ({
  receipt: {
    version: 1,
    task: "hns-production-api-security-backport",
    baselineSha: baseline,
    sourceSha: sha,
    hyperdriveId: hyperdrive,
  },
  sha,
  branch: releaseBranch,
  advertisedSha: sha,
  baselineSha: baseline,
  changedPaths: ["package.json"],
});
test("the published historical release is admitted and application/schema drift is refused", () => {
  expect(() => validatePinnedSource(source())).not.toThrow();
  for (const path of [
    "packages/application/src/namespace-ownership/completion.ts",
    "packages/platform-cf/postgres/migrations/0240.sql",
  ])
    expect(() => validatePinnedSource({ ...source(), changedPaths: [path] })).toThrow(
      "scope_changed",
    );
  expect(() => validatePinnedSource({ ...source(), advertisedSha: "b".repeat(40) })).toThrow(
    "source_not_published",
  );
  expect(() => validatePinnedSource({ ...source(), baselineSha: sha })).toThrow(
    "source_not_published",
  );
});
test("only the reviewed production database binding may change", () => {
  const before = {
    env: {
      production: {
        hyperdrive: [{ id: "old", binding: "CONTROL_PLANE" }],
        vars: { SELF_PASS_ENABLED: "false" },
      },
    },
  };
  const after = structuredClone(before);
  after.env.production.hyperdrive[0].id = hyperdrive;
  expect(() => validateProductionConfig(after, before)).not.toThrow();
  after.env.production.vars.SELF_PASS_ENABLED = "true";
  expect(() => validateProductionConfig(after, before)).toThrow("configuration_changed");
});
test("dependency versions cannot be upgraded under the patch exception", () => {
  const before = { devDependencies: { other: "1.0.0" } };
  const after = {
    devDependencies: { other: "1.0.0", "@types/node-forge": "1.3.14" },
    patchedDependencies: {
      "node-forge@1.4.0": "patches/node-forge@1.4.0.patch",
      "node-forge@github:remicolin/forge#17a11a6": "patches/node-forge-sdk-rsa-validation.patch",
    },
  };
  expect(() => validateDependencies(after, before)).not.toThrow();
  after.devDependencies.other = "2.0.0";
  expect(() => validateDependencies(after, before)).toThrow("dependencies_changed");
});
