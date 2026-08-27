import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeTypeScript,
  lintDependencies,
  verificationPackageExportViolations,
} from "./check-deps.mjs";
import { providerBoundaryViolation } from "./check-provider-boundary.mjs";

const providerFile = "packages/platform-cf/src/verification/providers/fake.ts";
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryDirectories: string[] = [];
const dependencyRoots = [
  "packages/contracts",
  "packages/api-client",
  "packages/domain",
  "packages/route-label-codec",
  "packages/application",
  "packages/platform-cf",
  "packages/testing",
  "packages/zkpassport-verifier-runtime",
  "packages/verifier-response-contract",
  "apps/http-worker",
  "apps/jobs-worker",
  "apps/media-processor-worker",
  "apps/data-registration-worker",
  "apps/hns-owner-verifier",
  "apps/hns-observer-driver",
  "apps/hns-platform-gateway",
] as const;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function fixtureRoot(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp("/tmp/api-next-dependency-fixture-");
  temporaryDirectories.push(root);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ workspaces: ["packages/*", "apps/*"] }),
  );
  for (const directory of dependencyRoots) {
    await mkdir(join(root, directory), { recursive: true });
  }
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return root;
}

describe("provider dependency boundary", () => {
  test("allows only the stable verification seams for internal imports", () => {
    expect(providerBoundaryViolation(providerFile, "@pirate/application/verification")).toBe(
      undefined,
    );
    expect(providerBoundaryViolation(providerFile, "@pirate/domain/verification")).toBe(undefined);
    expect(providerBoundaryViolation(providerFile, "@pirate/verifier-response-contract")).toBe(
      undefined,
    );
    expect(providerBoundaryViolation(providerFile, "effect")).toBe(undefined);
    expect(providerBoundaryViolation(providerFile, "./local-helper.ts")).toBe(undefined);
  });

  test("rejects contracts, use cases, routes, generated modules, and other internal packages", () => {
    for (const spec of [
      "@pirate/contracts",
      "@pirate/application/use-cases/identity",
      "@pirate/http-worker/routes",
      "@pirate/domain/generated",
      "@pirate/platform-cf",
      "@pirate/domain/gates/verification-eligibility",
      "@pirate/application/verification/internal",
    ]) {
      expect(providerBoundaryViolation(providerFile, spec)).toContain(
        "provider boundary files may import",
      );
    }
    expect(providerBoundaryViolation(providerFile, "../routes/generated.ts")).toContain(
      "provider boundary files may not use parent-relative imports",
    );
    expect(providerBoundaryViolation(providerFile, "./../routes/generated.ts")).toContain(
      "provider boundary files may not use parent-relative imports",
    );
    expect(
      providerBoundaryViolation(
        providerFile,
        "@pirate/application/verification/../use-cases/content",
      ),
    ).toContain("provider boundary files may not use parent-relative imports");
    expect(
      providerBoundaryViolation(providerFile, "@pirate/domain/verification/../generated"),
    ).toContain("provider boundary files may not use parent-relative imports");
  });

  test("does not impose provider rules on unrelated files", () => {
    expect(
      providerBoundaryViolation("packages/platform-cf/src/feed-repository.ts", "@pirate/contracts"),
    ).toBe(undefined);
  });

  test("walks the real provider fixture and frozen verification exports end to end", () => {
    const result = lintDependencies(repositoryRoot);
    expect(result.violations).toEqual([]);
    expect(result.checkedFiles).toContain(
      "packages/platform-cf/src/verification/providers/contract-fixture.ts",
    );
    expect(result.checkedFiles).toContain(
      "packages/platform-cf/src/verification/provider-registry.ts",
    );
    expect(result.checkedFiles).toContain("packages/domain/src/gates-v2/index.ts");
    expect(result.checkedFiles).toContain("apps/media-processor-worker/src/index.ts");
    expect(result.checkedFiles).toContain("apps/data-registration-worker/src/index.ts");
  });

  test("keeps the media processor Worker on application and platform seams", async () => {
    const allowedRoot = await fixtureRoot({
      "apps/media-processor-worker/src/index.ts":
        'import "@pirate/application"; import "@pirate/platform-cf";',
      "packages/platform-cf/src/verification/providers/contract-fixture.ts": "",
    });
    expect(
      lintDependencies(allowedRoot, { checkVerificationExportSurface: false }).violations,
    ).toEqual([]);

    const forbiddenRoot = await fixtureRoot({
      "apps/media-processor-worker/src/index.ts": 'import "@pirate/domain";',
      "packages/platform-cf/src/verification/providers/contract-fixture.ts": "",
    });
    expect(
      lintDependencies(forbiddenRoot, { checkVerificationExportSurface: false }).violations,
    ).toContain(
      "apps/media-processor-worker/src/index.ts: @pirate/media-processor-worker may not import @pirate/domain",
    );
  });

  test("keeps the DATA registration Worker on application and platform seams", async () => {
    const allowedRoot = await fixtureRoot({
      "apps/data-registration-worker/src/index.ts":
        'import "@pirate/application"; import "@pirate/platform-cf";',
      "packages/platform-cf/src/verification/providers/contract-fixture.ts": "",
    });
    expect(
      lintDependencies(allowedRoot, { checkVerificationExportSurface: false }).violations,
    ).toEqual([]);

    const forbiddenRoot = await fixtureRoot({
      "apps/data-registration-worker/src/index.ts": 'import "@pirate/domain";',
      "packages/platform-cf/src/verification/providers/contract-fixture.ts": "",
    });
    expect(
      lintDependencies(forbiddenRoot, { checkVerificationExportSurface: false }).violations,
    ).toContain(
      "apps/data-registration-worker/src/index.ts: @pirate/data-registration-worker may not import @pirate/domain",
    );
  });

  test("recognizes re-exported boundary symbols and local export-surface widening", () => {
    const reexport = analyzeTypeScript(
      'export { makeVerificationProviderRegistry as registry } from "@pirate/application/verification";',
    );
    expect(reexport.imports).toEqual([
      expect.objectContaining({
        spec: "@pirate/application/verification",
        names: ["makeVerificationProviderRegistry"],
      }),
    ]);
    for (const source of [
      "export const rogue = true;",
      "export async function rogue() {}",
      "export abstract class Rogue {}",
      "export namespace Rogue {}",
      "export default async function rogue() {}",
    ]) {
      expect(analyzeTypeScript(source).hasLocalExport).toBe(true);
    }
  });

  test("distinguishes literal dynamic imports from every computed form", () => {
    expect(
      analyzeTypeScript('export const load = () => import("pg");').hasComputedDynamicImport,
    ).toBe(false);
    for (const source of [
      "export const load = (name: string) => import(name);",
      'export const load = (suffix: string) => import("provider-" + suffix);',
      "export const load = (suffix: string) => import(`provider-$" + "{suffix}`);",
    ]) {
      expect(analyzeTypeScript(source).hasComputedDynamicImport).toBe(true);
    }
  });

  test("rejects CommonJS loaders and alternate verification export keys", async () => {
    for (const source of [
      "export const load = (name: string) => require(name);",
      "export const load = require;",
      "export const load = (name: string) => `loaded $" + "{require(name)}`;",
      'import { createRequire as create } from "node:module"; export const load = create(import.meta.url);',
    ]) {
      expect(analyzeTypeScript(source).hasCommonJsLoader).toBe(true);
    }
    expect(
      analyzeTypeScript('export const message = "handlers require an adapter";').hasCommonJsLoader,
    ).toBe(false);
    const domainPackage = await Bun.file(
      join(repositoryRoot, "packages/domain/package.json"),
    ).json();
    expect(
      verificationPackageExportViolations("packages/domain", {
        ...domainPackage.exports,
        "./proofs": "./src/verification/internal.ts",
      }),
    ).toContain("packages/domain/package.json: ./proofs may not export verification internals");
  });

  test("rejects a workspace package omitted from the dependency matrix", async () => {
    const root = await fixtureRoot({
      "packages/platform-cf/src/verification/providers/contract-fixture.ts":
        'import type { VerificationProviderAdapter } from "@pirate/application/verification";\nexport type Fixture = VerificationProviderAdapter;\n',
      "packages/rogue/src/provider.ts":
        'import type { VerificationProviderAdapter } from "@pirate/application/verification";\nexport type Rogue = VerificationProviderAdapter;\n',
    });
    const result = lintDependencies(root, { checkVerificationExportSurface: false });
    expect(result.violations).toContain(
      "packages/rogue: workspace package is missing from the dependency matrix",
    );
  });

  test("keeps the HNS verifier on its two frozen application protocol seams", async () => {
    const root = await fixtureRoot({
      "packages/platform-cf/src/verification/providers/contract-fixture.ts":
        'import type { VerificationProviderAdapter } from "@pirate/application/verification";\nexport type Fixture = VerificationProviderAdapter;\n',
      "apps/hns-owner-verifier/src/allowed.ts":
        'import type { HnsControlObservationRequestV1 } from "@pirate/application/namespace-ownership";\nimport type { HnsOwnerRecoveryPersistedSessionV1 } from "@pirate/application/route-revalidation";\nexport type Allowed = HnsControlObservationRequestV1 | HnsOwnerRecoveryPersistedSessionV1;\n',
      "apps/hns-owner-verifier/src/forbidden.ts":
        'import { getMyProfile } from "@pirate/application/use-cases/profile";\nexport const forbidden = getMyProfile;\n',
    });
    const result = lintDependencies(root, { checkVerificationExportSurface: false });
    expect(result.violations).toContain(
      "apps/hns-owner-verifier/src/forbidden.ts: @pirate/hns-owner-verifier may not import @pirate/application/use-cases/profile",
    );
    expect(result.violations.some((violation) => violation.includes("allowed.ts"))).toBe(false);
  });

  test("keeps the Node HNS gateway on the exact forwarder adapter seam", async () => {
    const root = await fixtureRoot({
      "packages/platform-cf/src/verification/providers/contract-fixture.ts":
        'import type { VerificationProviderAdapter } from "@pirate/application/verification";\nexport type Fixture = VerificationProviderAdapter;\n',
      "apps/hns-platform-gateway/src/allowed.ts":
        'import { makeHnsForwarderV3Gateway } from "@pirate/platform-cf/hns-forwarder-v3";\nimport { makePostgresHnsCommunityAppGatewayAuthorityV1 } from "@pirate/platform-cf/hns-community-app-gateway-authority-postgres";\nexport const allowed = [makeHnsForwarderV3Gateway, makePostgresHnsCommunityAppGatewayAuthorityV1];\n',
      "apps/hns-platform-gateway/src/forbidden.ts":
        'import { makeControlPlanePostgres } from "@pirate/platform-cf/postgres";\nexport const forbidden = makeControlPlanePostgres;\n',
    });
    const result = lintDependencies(root, { checkVerificationExportSurface: false });
    expect(result.violations).toContain(
      "apps/hns-platform-gateway/src/forbidden.ts: @pirate/hns-platform-gateway may not import @pirate/platform-cf/postgres",
    );
    expect(result.violations.some((violation) => violation.includes("allowed.ts"))).toBe(false);
  });

  test("fails closed for unsupported workspace entries", async () => {
    const root = await fixtureRoot({
      "packages/platform-cf/src/verification/providers/contract-fixture.ts":
        'import type { VerificationProviderAdapter } from "@pirate/application/verification";\nexport type Fixture = VerificationProviderAdapter;\n',
    });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ workspaces: ["packages/*", "apps", "../not-a-workspace"] }),
    );
    const result = lintDependencies(root, { checkVerificationExportSurface: false });
    expect(result.violations).toEqual(
      expect.arrayContaining([
        "package.json: unsupported workspace entry apps",
        "package.json: unsupported workspace entry ../not-a-workspace",
      ]),
    );
  });

  test("the actual walker rejects a widened frozen verification export", async () => {
    const root = await fixtureRoot({
      "packages/platform-cf/src/verification/providers/contract-fixture.ts":
        'import type { VerificationProviderAdapter } from "@pirate/application/verification";\nexport type Fixture = VerificationProviderAdapter;\n',
    });
    for (const directory of [
      "packages/domain",
      "packages/application",
      "packages/testing",
    ] as const) {
      await writeFile(
        join(root, directory, "package.json"),
        await Bun.file(join(repositoryRoot, directory, "package.json")).text(),
      );
      const relativeIndex = join(directory, "src/verification/index.ts");
      await mkdir(dirname(join(root, relativeIndex)), { recursive: true });
      await writeFile(
        join(root, relativeIndex),
        await Bun.file(join(repositoryRoot, relativeIndex)).text(),
      );
    }
    const gatesIndex = "packages/domain/src/gates-v2/index.ts";
    await mkdir(dirname(join(root, gatesIndex)), { recursive: true });
    await writeFile(
      join(root, gatesIndex),
      await Bun.file(join(repositoryRoot, gatesIndex)).text(),
    );
    const domainIndex = join(root, "packages/domain/src/verification/index.ts");
    await writeFile(
      domainIndex,
      `${await Bun.file(domainIndex).text()}\nexport const widened = true;\n`,
    );
    await writeFile(
      join(root, gatesIndex),
      `${await Bun.file(join(root, gatesIndex)).text()}\nexport const widened = true;\n`,
    );
    const result = lintDependencies(root);
    expect(result.violations).toContain(
      "packages/domain/src/verification/index.ts: verification export surface differs from the frozen list",
    );
    expect(result.violations).toContain(
      "packages/domain/src/gates-v2/index.ts: gates-v2 export surface differs from the frozen list",
    );
  });

  test("the actual walker rejects forbidden, computed, misplaced, and registry imports", async () => {
    const root = await fixtureRoot({
      "packages/platform-cf/src/verification/providers/contract-fixture.ts":
        'import type { VerificationProviderAdapter } from "@pirate/application/verification";\nexport type Fixture = VerificationProviderAdapter;\n',
      "packages/platform-cf/src/verification/providers/forbidden.ts":
        'import { endpoint } from "@pirate/contracts";\nexport const value = endpoint;\n',
      "packages/platform-cf/src/verification/providers/computed.ts":
        "export const load = (moduleName: string) => import(moduleName);\n",
      "packages/platform-cf/src/verification/providers/concatenated.ts":
        'export const load = (suffix: string) => import("provider-" + suffix);\n',
      "packages/platform-cf/src/verification/providers/template.ts":
        "export const load = (suffix: string) => import(`provider-$" + "{suffix}`);\n",
      "packages/platform-cf/src/outside-adapter.ts":
        'import type { VerificationProviderAdapter as Adapter } from "@pirate/application/verification";\nexport type Outside = Adapter;\n',
      "packages/platform-cf/src/outside-reexport.ts":
        'export { makeVerificationProviderRegistry as registry } from "@pirate/application/verification";\n',
      "packages/platform-cf/src/deep-adapter.ts":
        'import type { VerificationProviderAdapter } from "@pirate/application/verification/adapter";\nexport type Deep = VerificationProviderAdapter;\n',
      "packages/platform-cf/src/computed-outside.ts":
        "export const load = (moduleName: string) => import(moduleName);\n",
      "packages/platform-cf/src/required-outside.ts":
        "export const load = (moduleName: string) => require(moduleName);\n",
      "packages/platform-cf/src/verification/provider-registry.ts":
        'import { endpoint } from "@pirate/contracts";\nexport const value = endpoint;\n',
      "apps/http-worker/src/outside-registry.ts":
        'import { makeVerificationProviderRegistry as makeRegistry } from "@pirate/application/verification";\nexport const outside = makeRegistry;\n',
      "apps/http-worker/src/outside-registry-layer.ts":
        'import { makeVerificationProviderRegistryLayer as makeLayer } from "@pirate/application/verification";\nexport const outside = makeLayer;\n',
      "packages/application/src/verification/outside-registry.ts":
        'import { makeVerificationProviderRegistry } from "./registry.ts";\nexport const outside = makeVerificationProviderRegistry;\n',
      "packages/application/src/verification/outside-registry-namespace.ts":
        'import * as Registry from "./registry";\nexport const outside = Registry;\n',
      "packages/application/src/verification/outside-registry-star.ts":
        'export * from "./registry.js";\n',
      "packages/testing/src/verification/fake.ts":
        'import type { VerificationProviderAdapter } from "@pirate/application/verification";\nexport type Fake = VerificationProviderAdapter;\n',
    });
    const result = lintDependencies(root, { checkVerificationExportSurface: false });
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("provider boundary files may import only"),
        expect.stringContaining("computed dynamic imports are forbidden in production"),
        expect.stringContaining("require()/createRequire are forbidden in production"),
        expect.stringContaining("provider adapter implementations belong under"),
        expect.stringContaining("production provider registration belongs in"),
        expect.stringContaining("deep verification imports are forbidden"),
      ]),
    );
    expect(result.violations.some((violation) => violation.includes("packages/testing"))).toBe(
      false,
    );
    for (const relativePath of [
      "packages/application/src/verification/outside-registry.ts",
      "packages/application/src/verification/outside-registry-namespace.ts",
      "packages/application/src/verification/outside-registry-star.ts",
      "apps/http-worker/src/outside-registry-layer.ts",
    ]) {
      expect(result.violations.some((violation) => violation.startsWith(relativePath))).toBe(true);
    }
  });
});
