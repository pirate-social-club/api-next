import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeTypeScript, lintDependencies } from "./check-deps.mjs";
import { providerBoundaryViolation } from "./check-provider-boundary.mjs";

const providerFile = "packages/platform-cf/src/verification/providers/fake.ts";
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryDirectories: string[] = [];
const dependencyRoots = [
  "packages/contracts",
  "packages/api-client",
  "packages/domain",
  "packages/application",
  "packages/platform-cf",
  "packages/testing",
  "apps/http-worker",
  "apps/jobs-worker",
] as const;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function fixtureRoot(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp("/tmp/api-next-dependency-fixture-");
  temporaryDirectories.push(root);
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
      "packages/platform-cf/src/verification/provider-registry.ts":
        'import { endpoint } from "@pirate/contracts";\nexport const value = endpoint;\n',
      "apps/http-worker/src/outside-registry.ts":
        'import { makeVerificationProviderRegistry as makeRegistry } from "@pirate/application/verification";\nexport const outside = makeRegistry;\n',
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
    ]) {
      expect(result.violations.some((violation) => violation.startsWith(relativePath))).toBe(true);
    }
  });
});
