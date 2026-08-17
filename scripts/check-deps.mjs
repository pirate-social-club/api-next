#!/usr/bin/env node
// Dependency-matrix and verification-boundary lint (api-next 000 §4).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROVIDER_IMPLEMENTATION_PREFIX,
  PROVIDER_REGISTRY_ASSEMBLY_FILE,
  PROVIDER_TESTING_PREFIX,
  providerBoundaryViolation,
} from "./check-provider-boundary.mjs";

const INTERNAL = {
  "packages/contracts": "@pirate/contracts",
  "packages/api-client": "@pirate/api-client",
  "packages/domain": "@pirate/domain",
  "packages/application": "@pirate/application",
  "packages/platform-cf": "@pirate/platform-cf",
  "packages/testing": "@pirate/testing",
  "apps/http-worker": "@pirate/http-worker",
  "apps/jobs-worker": "@pirate/jobs-worker",
};

const ALLOWED = {
  "@pirate/contracts": [],
  "@pirate/api-client": [],
  "@pirate/domain": [],
  "@pirate/application": ["@pirate/contracts", "@pirate/domain"],
  "@pirate/platform-cf": ["@pirate/application", "@pirate/contracts", "@pirate/domain"],
  "@pirate/testing": ["@pirate/application", "@pirate/contracts", "@pirate/domain"],
  "@pirate/http-worker": [
    "@pirate/application",
    "@pirate/contracts",
    "@pirate/domain",
    "@pirate/platform-cf",
  ],
  "@pirate/jobs-worker": [
    "@pirate/application",
    "@pirate/contracts",
    "@pirate/domain",
    "@pirate/platform-cf",
  ],
};

const DOMAIN_EFFECT_ALLOWLIST = new Set([
  "effect",
  "effect/Schema",
  "effect/Data",
  "effect/TypeError",
]);

const VERIFICATION_EXPORTS = {
  "packages/domain": {
    "./assets.ts": [
      "AssetCollectionDescriptor",
      "AssetDescriptor",
      "AssetTokenDescriptor",
      "CaipAccountId",
      "CaipAssetId",
      "CaipChainId",
      "MatchSemantics",
    ],
    "./claims.ts": [
      "Assurance",
      "CANONICAL_CLAIM_CATALOG",
      "CanonicalClaimIdentifier",
      "ClaimCatalogEntry",
      "ClaimCategory",
      "HolderLivenessRequirement",
      "NamedIssuerActionScope",
      "NamedIssuerScope",
      "NoSubjectScope",
      "PresentationKind",
      "ProofProviderManifest",
      "ScopeRequirement",
      "SubjectBindingIntent",
      "SubjectKeyScopeSemantics",
      "SubjectScope",
    ],
    "./evidence.ts": [
      "Assertion",
      "BindingGroup",
      "EvidenceBundle",
      "EvidenceReceipt",
      "ProofSession",
      "ProofSessionStatus",
      "SameReceiptBindingGroup",
      "SameSubjectBindingGroup",
      "SubjectKey",
    ],
    "./observations.ts": [
      "AggregationMode",
      "AssetInventoryObservationValue",
      "Completeness",
      "DisclosedPredicateObservationValue",
      "InventoryResolverManifest",
      "Observation",
      "ObservationKind",
      "ObservationValue",
      "SnapshotReference",
      "TrustMode",
      "WalletBalanceObservationValue",
    ],
    "./scalars.ts": [
      "CanonicalIsoInstant",
      "DocumentGenderMarker",
      "Iso3166Alpha2",
      "NonNegativeIntegerString",
      "Sha256Hex",
    ],
  },
  "packages/application": {
    "./adapter.ts": [
      "ProviderPresentation",
      "ProviderSessionStart",
      "VerificationAssurance",
      "VerificationProviderAdapter",
      "VerificationProviderCompleteInput",
      "VerificationProviderFailure",
      "VerificationProviderInvalidResponse",
      "VerificationProviderMisconfigured",
      "VerificationProviderOperation",
      "VerificationProviderRejected",
      "VerificationProviderStartInput",
      "VerificationProviderUnavailable",
    ],
    "./completion.ts": [
      "CompleteVerificationInput",
      "CompleteVerificationResult",
      "StoredVerificationCompletion",
      "VerificationCompletionCommitOutcome",
      "VerificationCompletionFailure",
      "VerificationCompletionHashFailed",
      "VerificationCompletionHasher",
      "VerificationCompletionRejected",
      "VerificationCompletionServices",
      "VerificationCompletionStorageFailed",
      "VerificationCompletionStore",
      "completeVerification",
    ],
    "./registry.ts": [
      "makeVerificationProviderRegistry",
      "makeVerificationProviderRegistryLayer",
      "validateProofProviderManifest",
      "VerificationProviderDuplicate",
      "VerificationProviderManifestField",
      "VerificationProviderManifestInvalid",
      "VerificationProviderRegistry",
      "VerificationProviderRegistryError",
      "VerificationProviderRegistryOptions",
      "VerificationProviderRegistryService",
      "VerificationProviderUnknown",
    ],
  },
  "packages/testing": {
    "./fake-provider.ts": [
      "FAKE_PROVIDER_MANIFEST",
      "FakeProviderMode",
      "FakeProviderOptions",
      "FakeProviderTransport",
      "makeFakeVerificationProvider",
      "makeFakeVerificationTransport",
      "NO_SUBJECT_FAKE_PROVIDER_MANIFEST",
    ],
    "./provider-conformance.ts": [
      "ProviderConformanceHarness",
      "ProviderTransportConformanceCase",
      "runProviderConformance",
      "runProviderTransportConformance",
    ],
  },
};

function isTestFile(file) {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file);
}

export function walkTypeScriptFiles(directory, files = []) {
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules") continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      walkTypeScriptFiles(full, files);
    } else if (/\.[cm]?[jt]sx?$/u.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

export function analyzeTypeScript(text, _fileName = "fixture.ts") {
  const imports = [];
  const exported = [];
  const referenceNamesBySpec = new Map();
  const namedImportPattern = /\bimport\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+["']([^"']+)["']/gu;
  for (const match of text.matchAll(namedImportPattern)) {
    const names = match[1]
      .split(",")
      .map(
        (entry) =>
          entry
            .trim()
            .replace(/^type\s+/u, "")
            .split(/\s+as\s+/u)[0],
      )
      .filter(Boolean);
    referenceNamesBySpec.set(match[2], [...(referenceNamesBySpec.get(match[2]) ?? []), ...names]);
  }
  const namespaceImportPattern = /\bimport\s+\*\s+as\s+\w+\s+from\s+["']([^"']+)["']/gu;
  for (const match of text.matchAll(namespaceImportPattern)) {
    referenceNamesBySpec.set(match[1], [...(referenceNamesBySpec.get(match[1]) ?? []), "*"]);
  }
  const exportPattern = /\bexport\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+["']([^"']+)["']/gu;
  for (const match of text.matchAll(exportPattern)) {
    for (const entry of match[1].split(",")) {
      const parts = entry
        .trim()
        .replace(/^type\s+/u, "")
        .split(/\s+as\s+/u);
      const importedName = parts[0];
      const exportedName = parts.at(-1);
      if (importedName) {
        referenceNamesBySpec.set(match[2], [
          ...(referenceNamesBySpec.get(match[2]) ?? []),
          importedName,
        ]);
      }
      if (exportedName) exported.push({ spec: match[2], name: exportedName });
    }
  }
  const starExportPattern = /\bexport\s+\*\s+from\s+["']([^"']+)["']/gu;
  for (const match of text.matchAll(starExportPattern)) {
    exported.push({ spec: match[1], name: "*" });
    referenceNamesBySpec.set(match[1], [...(referenceNamesBySpec.get(match[1]) ?? []), "*"]);
  }
  const modulePattern = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/gu;
  for (const match of text.matchAll(modulePattern)) {
    imports.push({
      spec: match[1],
      names: [...new Set(referenceNamesBySpec.get(match[1]) ?? [])],
      kind: "module-reference",
    });
  }
  const withoutLiteralDynamicImports = text.replace(/\bimport\s*\(\s*["'][^"']+["']\s*\)/gu, "");
  const hasComputedDynamicImport = /\bimport\s*\(/u.test(withoutLiteralDynamicImports);
  const withoutReexports = text.replace(exportPattern, "").replace(starExportPattern, "");
  const hasLocalExport = /\bexport\b/u.test(withoutReexports);
  return { imports, exported, hasComputedDynamicImport, hasLocalExport };
}

function isAllowedPackageDependency(pkg, spec) {
  if (!spec.startsWith("@pirate/")) return true;
  if (spec === pkg) return true;
  if (spec === "@pirate/http-worker" || spec === "@pirate/jobs-worker") return false;
  return ALLOWED[pkg].some(
    (dependency) => spec === dependency || spec.startsWith(`${dependency}/`),
  );
}

function adapterPlacementAllowed(relativeFile) {
  return (
    relativeFile === PROVIDER_REGISTRY_ASSEMBLY_FILE ||
    relativeFile.startsWith(PROVIDER_IMPLEMENTATION_PREFIX) ||
    relativeFile.startsWith(PROVIDER_TESTING_PREFIX)
  );
}

function registryPlacementAllowed(relativeFile) {
  return (
    relativeFile === PROVIDER_REGISTRY_ASSEMBLY_FILE ||
    relativeFile.startsWith(PROVIDER_TESTING_PREFIX) ||
    relativeFile === "packages/application/src/verification/index.ts" ||
    isTestFile(relativeFile)
  );
}

function providerPathImport(spec) {
  return spec.includes("verification/providers") || /^\.\/?providers(?:\/|$)/u.test(spec);
}

function isApplicationVerificationSpec(spec) {
  return (
    spec === "@pirate/application/verification" ||
    spec.startsWith("@pirate/application/verification/")
  );
}

function isApplicationVerificationRegistrySpec(relativeFile, spec) {
  if (isApplicationVerificationSpec(spec)) return true;
  if (!spec.startsWith(".")) return false;
  const target = resolve("/", dirname(relativeFile), spec).replaceAll("\\", "/");
  return /\/packages\/application\/src\/verification\/(?:index|registry)(?:\.[cm]?[jt]s)?$/u.test(
    target,
  );
}

function isDeepVerificationSpec(spec) {
  return ["application", "domain", "testing"].some((packageName) =>
    spec.startsWith(`@pirate/${packageName}/verification/`),
  );
}

function checkVerificationExportSurface(root, violations, checkedFiles) {
  for (const [packageDirectory, expectedBySource] of Object.entries(VERIFICATION_EXPORTS)) {
    const packageJsonPath = join(root, packageDirectory, "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const verificationExports = Object.keys(packageJson.exports ?? {}).filter((key) =>
      key.startsWith("./verification"),
    );
    if (
      verificationExports.length !== 1 ||
      verificationExports[0] !== "./verification" ||
      packageJson.exports["./verification"] !== "./src/verification/index.ts"
    ) {
      violations.push(
        `${packageDirectory}/package.json: verification package export must remain exactly ./verification`,
      );
    }

    const relativeIndex = `${packageDirectory}/src/verification/index.ts`;
    const indexPath = join(root, relativeIndex);
    checkedFiles.push(relativeIndex);
    const analysis = analyzeTypeScript(readFileSync(indexPath, "utf8"), relativeIndex);
    const expected = Object.entries(expectedBySource)
      .flatMap(([spec, names]) => names.map((name) => `${spec}:${name}`))
      .sort();
    const actual = analysis.exported.map(({ spec, name }) => `${spec}:${name}`).sort();
    if (analysis.hasLocalExport || actual.join("\n") !== expected.join("\n")) {
      violations.push(`${relativeIndex}: verification export surface differs from the frozen list`);
    }
  }
}

export function lintDependencies(
  root = process.cwd(),
  options = { checkVerificationExportSurface: true },
) {
  const violations = [];
  const checkedFiles = [];

  for (const [directory, pkg] of Object.entries(INTERNAL)) {
    const absoluteDirectory = join(root, directory);
    for (const file of walkTypeScriptFiles(absoluteDirectory)) {
      const relativeFile = relative(root, file).replaceAll("\\", "/");
      checkedFiles.push(relativeFile);
      const analysis = analyzeTypeScript(readFileSync(file, "utf8"), relativeFile);
      const providerFile = relativeFile.startsWith(PROVIDER_IMPLEMENTATION_PREFIX);

      if (!isTestFile(relativeFile) && analysis.hasComputedDynamicImport) {
        violations.push(
          `${relativeFile}: computed dynamic imports are forbidden in production package code`,
        );
      }

      for (const imported of analysis.imports) {
        const { spec } = imported;
        if (isDeepVerificationSpec(spec)) {
          violations.push(
            `${relativeFile}: deep verification imports are forbidden; use the exact verification package seam (found ${spec})`,
          );
        }
        if (!isTestFile(relativeFile)) {
          const providerViolation = providerBoundaryViolation(relativeFile, spec);
          if (providerViolation !== undefined) violations.push(providerViolation);
          if (!isAllowedPackageDependency(pkg, spec)) {
            violations.push(
              spec === "@pirate/http-worker" || spec === "@pirate/jobs-worker"
                ? `${relativeFile}: nothing imports apps (found ${spec})`
                : `${relativeFile}: ${pkg} may not import ${spec}`,
            );
          }
          if (
            pkg === "@pirate/domain" &&
            spec.startsWith("effect") &&
            !DOMAIN_EFFECT_ALLOWLIST.has(spec)
          ) {
            violations.push(
              `${relativeFile}: domain may use only Schema/Data effect modules (found ${spec})`,
            );
          }
        } else if (providerFile) {
          const providerViolation = providerBoundaryViolation(relativeFile, spec);
          if (providerViolation !== undefined) violations.push(providerViolation);
        }

        if (
          isApplicationVerificationSpec(spec) &&
          (imported.names.includes("VerificationProviderAdapter") ||
            imported.names.includes("*")) &&
          !adapterPlacementAllowed(relativeFile)
        ) {
          violations.push(
            `${relativeFile}: provider adapter implementations belong under ${PROVIDER_IMPLEMENTATION_PREFIX}`,
          );
        }
        if (
          (imported.names.includes("makeVerificationProviderRegistry") ||
            (isApplicationVerificationRegistrySpec(relativeFile, spec) &&
              imported.names.includes("*"))) &&
          !registryPlacementAllowed(relativeFile)
        ) {
          violations.push(
            `${relativeFile}: production provider registration belongs in ${PROVIDER_REGISTRY_ASSEMBLY_FILE}`,
          );
        }
        if (
          providerPathImport(spec) &&
          !providerFile &&
          relativeFile !== PROVIDER_REGISTRY_ASSEMBLY_FILE
        ) {
          violations.push(
            `${relativeFile}: platform provider implementations may be imported only by ${PROVIDER_REGISTRY_ASSEMBLY_FILE}`,
          );
        }
      }
    }
  }

  const providerFiles = checkedFiles.filter(
    (file) => file.startsWith(PROVIDER_IMPLEMENTATION_PREFIX) && !isTestFile(file),
  );
  if (providerFiles.length === 0) {
    violations.push(
      `${PROVIDER_IMPLEMENTATION_PREFIX}: no production provider-boundary fixture was walked`,
    );
  }
  if (options.checkVerificationExportSurface !== false) {
    checkVerificationExportSurface(root, violations, checkedFiles);
  }
  return { violations, checkedFiles: [...new Set(checkedFiles)].sort() };
}

export function main(root = process.cwd()) {
  const result = lintDependencies(root);
  if (result.violations.length > 0) {
    console.error(`lint:deps — ${result.violations.length} dependency-matrix violation(s):`);
    for (const violation of result.violations) console.error(`  ${violation}`);
    return 1;
  }
  console.log(`lint:deps — dependency matrix clean (${result.checkedFiles.length} files walked)`);
  return 0;
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
