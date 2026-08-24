#!/usr/bin/env node
// Dependency-matrix and verification-boundary lint (api-next 000 §4).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
  "packages/route-label-codec": "@pirate/route-label-codec",
  "packages/application": "@pirate/application",
  "packages/platform-cf": "@pirate/platform-cf",
  "packages/testing": "@pirate/testing",
  "packages/zkpassport-verifier-runtime": "@pirate/zkpassport-verifier-runtime",
  "packages/verifier-response-contract": "@pirate/verifier-response-contract",
  "apps/http-worker": "@pirate/http-worker",
  "apps/jobs-worker": "@pirate/jobs-worker",
  "apps/hns-owner-verifier": "@pirate/hns-owner-verifier",
  "apps/hns-observer-driver": "@pirate/hns-observer-driver",
  "apps/hns-platform-gateway": "@pirate/hns-platform-gateway",
};

const ALLOWED = {
  "@pirate/contracts": ["@pirate/route-label-codec"],
  "@pirate/api-client": [],
  "@pirate/domain": ["@pirate/route-label-codec"],
  "@pirate/route-label-codec": [],
  "@pirate/application": ["@pirate/contracts", "@pirate/domain"],
  "@pirate/platform-cf": [
    "@pirate/application",
    "@pirate/contracts",
    "@pirate/domain",
    "@pirate/verifier-response-contract",
  ],
  "@pirate/testing": ["@pirate/application", "@pirate/contracts", "@pirate/domain"],
  "@pirate/zkpassport-verifier-runtime": ["@pirate/verifier-response-contract"],
  "@pirate/verifier-response-contract": [],
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
  "@pirate/hns-owner-verifier": [],
  "@pirate/hns-observer-driver": ["@pirate/application"],
  "@pirate/hns-platform-gateway": ["@pirate/application"],
};

const DOMAIN_EFFECT_ALLOWLIST = new Set([
  "effect",
  "effect/Schema",
  "effect/Data",
  "effect/TypeError",
]);

const HNS_OWNER_VERIFIER_APPLICATION_SEAMS = new Set([
  "@pirate/application/namespace-ownership",
  "@pirate/application/route-revalidation",
]);
const HNS_OWNER_VERIFIER_PLATFORM_SEAMS = new Set([
  "@pirate/platform-cf/postgres",
  "@pirate/platform-cf/namespace-ownership-hns-control-observer-hsd-private-transport",
  "@pirate/platform-cf/namespace-ownership-hns-control-observer-postgres",
  "@pirate/platform-cf/namespace-ownership-hns-private-driver-transport",
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
      "ProviderConfigurationRef",
      "ProviderClaimCapability",
      "ProofProviderManifest",
      "ProviderOperationDeadlines",
      "ScopeRequirement",
      "SubjectBindingIntent",
      "SubjectKeyScopeSemantics",
      "SubjectScope",
      "VerificationCallbackMode",
      "VerificationRequestMode",
    ],
    "./evidence.ts": [
      "Assertion",
      "BindingGroup",
      "EvidenceBundle",
      "EvidenceReceipt",
      "EvidenceReceiptMetadata",
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
    "./requirements.ts": [
      "canonicalizeVerificationRequirements",
      "sameVerificationRequirements",
      "VerificationRequirement",
      "VerificationRequirements",
      "verificationRequirementClaimIds",
    ],
  },
  "packages/application": {
    "./adapter.ts": [
      "ProviderPresentation",
      "ProviderSessionStart",
      "VerificationCallbackHeaders",
      "VerificationCallbackRawBody",
      "VerificationProviderCallbackInput",
      "VerificationProviderCallbackResolution",
      "VerificationAssurance",
      "VerificationProviderAdapter",
      "VerificationProviderCompleteInput",
      "VerificationProviderFailure",
      "VerificationProviderInvalidResponse",
      "VerificationProviderMisconfigured",
      "VerificationProviderOperation",
      "VerificationProviderPlanInput",
      "VerificationProviderPlanResult",
      "VerificationProviderRejected",
      "VerificationProviderStartInput",
      "VerificationProviderUnavailable",
      "VerificationProviderUnboundRejected",
      "VerificationSubmission",
    ],
    "./callback.ts": [
      "HandleVerificationCallbackInput",
      "stripVerificationCallbackCredentialHeaders",
      "VerificationCallbackFailure",
      "VerificationCallbackRejected",
      "VerificationCallbackResult",
      "VerificationCallbackServices",
      "handleVerificationCallback",
    ],
    "./completion.ts": [
      "CompleteVerificationInput",
      "CompleteVerificationResult",
      "StoredVerificationCompletion",
      "VERIFICATION_COMPLETION_ATTEMPT_LEASE_MARGIN_MS",
      "VERIFICATION_COMPLETION_MAX_ATTEMPTS",
      "VerificationCompletionAttemptReservation",
      "VerificationCompletionAttemptReservationOutcome",
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
    "./planning.ts": [
      "PlannedVerificationProvider",
      "planVerificationProviderCandidates",
      "VerificationProviderPlanningCandidate",
    ],
    "./request-hash.ts": ["computeVerificationRequestHash", "VerificationRequestHashInput"],
    "./start.ts": [
      "StartVerificationFailure",
      "StartVerificationInput",
      "StartVerificationResult",
      "StartVerificationServices",
      "startVerification",
      "VerificationIntentResolver",
      "VerificationSessionStartFinalizeOutcome",
      "VerificationSessionStartReservation",
      "VerificationSessionStartReservationInput",
      "VerificationSessionStartReservationOutcome",
      "VerificationSessionStartStore",
      "VerificationStartRejected",
      "VerificationStartStorageFailed",
    ],
  },
  "packages/testing": {
    "./fake-provider.ts": [
      "FAKE_PROVIDER_MANIFEST",
      "FakeProviderMode",
      "FakeProviderOptions",
      "FakeProviderTransport",
      "makeFakeVerificationProvider",
      "makeFakeVerificationProviderRegistry",
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

const GATES_V2_EXPORTS = {
  "./evaluator.ts": [
    "CURATED_AGE_18_POLICY",
    "CURATED_AGE_18_POLICY_CANONICAL_PREIMAGE",
    "CuratedAge18Evaluation",
    "CuratedAge18EvaluatorInput",
    "CuratedAge18Fail",
    "CuratedAge18Indeterminate",
    "CuratedAge18NeedsEvidence",
    "CuratedAge18Pass",
    "CuratedAge18Policy",
    "CuratedAgeEvaluation",
    "CuratedAgeEvaluatorInput",
    "CuratedAgeFail",
    "CuratedAgeIndeterminate",
    "CuratedAgeNeedsEvidence",
    "CuratedAgePass",
    "CuratedAgePolicy",
    "EvaluatorReason",
    "EvaluatorWitness",
    "EvidenceAvailability",
    "EvidenceUnavailableReason",
    "GatesV2EvaluationOutcome",
    "RequiredClaim",
    "evaluateCuratedAge",
    "policyCanonicalPreimage",
  ],
  "./human-membership-evaluator.ts": [
    "CURATED_HUMAN_MEMBERSHIP_POLICY",
    "CURATED_HUMAN_MEMBERSHIP_POLICY_CANONICAL_PREIMAGE",
    "CuratedHumanMembershipEvaluation",
    "CuratedHumanMembershipEvaluatorInput",
    "CuratedHumanMembershipFail",
    "CuratedHumanMembershipIndeterminate",
    "CuratedHumanMembershipNeedsEvidence",
    "CuratedHumanMembershipPass",
    "CuratedHumanMembershipPolicy",
    "HumanMembershipRequiredClaim",
    "evaluateCuratedHumanMembership",
    "humanMembershipPolicyCanonicalPreimage",
  ],
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

function containsCommonJsLoader(text) {
  let state = "code";
  const templateReturns = [];
  const interpolationDepths = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (state === "line-comment") {
      if (character === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        state = "code";
        index += 1;
      }
      continue;
    }
    if (state === "single-quote" || state === "double-quote") {
      if (character === "\\") {
        index += 1;
      } else if (
        (state === "single-quote" && character === "'") ||
        (state === "double-quote" && character === '"')
      ) {
        state = "code";
      }
      continue;
    }
    if (state === "template") {
      if (character === "\\") {
        index += 1;
      } else if (character === "`") {
        state = templateReturns.pop() ?? "code";
      } else if (character === "$" && next === "{") {
        interpolationDepths.push(1);
        state = "code";
        index += 1;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      state = "line-comment";
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      state = "block-comment";
      index += 1;
      continue;
    }
    if (character === "'") {
      state = "single-quote";
      continue;
    }
    if (character === '"') {
      state = "double-quote";
      continue;
    }
    if (character === "`") {
      templateReturns.push("code");
      state = "template";
      continue;
    }
    if (interpolationDepths.length > 0 && character === "{") {
      interpolationDepths[interpolationDepths.length - 1] += 1;
      continue;
    }
    if (interpolationDepths.length > 0 && character === "}") {
      const depthIndex = interpolationDepths.length - 1;
      interpolationDepths[depthIndex] -= 1;
      if (interpolationDepths[depthIndex] === 0) {
        interpolationDepths.pop();
        state = "template";
      }
      continue;
    }
    if (character !== undefined && /[A-Za-z_$]/u.test(character)) {
      let end = index + 1;
      while (end < text.length && /[A-Za-z0-9_$]/u.test(text[end])) end += 1;
      const identifier = text.slice(index, end);
      if (identifier === "require" || identifier === "createRequire") return true;
      index = end - 1;
    }
  }
  return false;
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
  const hasCommonJsLoader = containsCommonJsLoader(text);
  const withoutReexports = text.replace(exportPattern, "").replace(starExportPattern, "");
  const hasLocalExport = /\bexport\b/u.test(withoutReexports);
  return { imports, exported, hasCommonJsLoader, hasComputedDynamicImport, hasLocalExport };
}

function isAllowedPackageDependency(pkg, spec) {
  if (!spec.startsWith("@pirate/")) return true;
  if (spec === pkg) return true;
  if (spec === "@pirate/http-worker" || spec === "@pirate/jobs-worker") return false;
  if (pkg === "@pirate/hns-owner-verifier" && spec.startsWith("@pirate/application")) {
    return HNS_OWNER_VERIFIER_APPLICATION_SEAMS.has(spec);
  }
  if (pkg === "@pirate/hns-owner-verifier" && spec.startsWith("@pirate/platform-cf")) {
    return HNS_OWNER_VERIFIER_PLATFORM_SEAMS.has(spec);
  }
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
    violations.push(...verificationPackageExportViolations(packageDirectory, packageJson.exports));

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

  const gatesPackageJsonPath = join(root, "packages/domain/package.json");
  const gatesPackageJson = JSON.parse(readFileSync(gatesPackageJsonPath, "utf8"));
  const gatesExports = Object.keys(gatesPackageJson.exports ?? {}).filter((key) =>
    key.startsWith("./gates-v2"),
  );
  if (
    gatesExports.length !== 1 ||
    gatesExports[0] !== "./gates-v2" ||
    gatesPackageJson.exports["./gates-v2"] !== "./src/gates-v2/index.ts"
  )
    violations.push(
      "packages/domain/package.json: gates-v2 package export must remain exactly ./gates-v2",
    );

  const gatesRelativeIndex = "packages/domain/src/gates-v2/index.ts";
  const gatesAnalysis = analyzeTypeScript(
    readFileSync(join(root, gatesRelativeIndex), "utf8"),
    gatesRelativeIndex,
  );
  checkedFiles.push(gatesRelativeIndex);
  const expectedGates = Object.entries(GATES_V2_EXPORTS)
    .flatMap(([spec, names]) => names.map((name) => `${spec}:${name}`))
    .sort();
  const actualGates = gatesAnalysis.exported.map(({ spec, name }) => `${spec}:${name}`).sort();
  if (gatesAnalysis.hasLocalExport || actualGates.join("\n") !== expectedGates.join("\n"))
    violations.push(`${gatesRelativeIndex}: gates-v2 export surface differs from the frozen list`);
}

function exportTargetEntersVerification(target) {
  if (typeof target === "string") {
    return target === "./src/verification" || target.startsWith("./src/verification/");
  }
  if (target === null || typeof target !== "object") return false;
  return Object.values(target).some(exportTargetEntersVerification);
}

export function verificationPackageExportViolations(packageDirectory, exportsMap) {
  const violations = [];
  const exports = exportsMap ?? {};
  const verificationExports = Object.keys(exports).filter((key) =>
    key.startsWith("./verification"),
  );
  for (const [key, target] of Object.entries(exports)) {
    if (key !== "./verification" && exportTargetEntersVerification(target)) {
      violations.push(
        `${packageDirectory}/package.json: ${key} may not export verification internals`,
      );
    }
  }
  if (
    verificationExports.length !== 1 ||
    verificationExports[0] !== "./verification" ||
    exports["./verification"] !== "./src/verification/index.ts"
  ) {
    violations.push(
      `${packageDirectory}/package.json: verification package export must remain exactly ./verification`,
    );
  }
  return violations;
}

function workspaceDirectories(root, violations) {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (!Array.isArray(packageJson.workspaces)) {
    violations.push("package.json: workspaces must be an array of supported /* globs");
    return [];
  }
  const directories = [];
  for (const workspace of packageJson.workspaces) {
    if (typeof workspace !== "string" || !workspace.endsWith("/*")) {
      violations.push(`package.json: unsupported workspace entry ${String(workspace)}`);
      continue;
    }
    const parent = workspace.slice(0, -2);
    const absoluteParent = join(root, parent);
    if (!existsSync(absoluteParent) || !statSync(absoluteParent).isDirectory()) {
      violations.push(`package.json: workspace glob parent is missing: ${workspace}`);
      continue;
    }
    for (const entry of readdirSync(absoluteParent)) {
      if (statSync(join(absoluteParent, entry)).isDirectory()) {
        directories.push(`${parent}/${entry}`);
      }
    }
  }
  return directories.sort();
}

function checkWorkspaceCoverage(root, violations) {
  const declared = Object.keys(INTERNAL).sort();
  const discovered = workspaceDirectories(root, violations);
  for (const directory of discovered) {
    if (!declared.includes(directory)) {
      violations.push(`${directory}: workspace package is missing from the dependency matrix`);
    }
  }
  for (const directory of declared) {
    if (!discovered.includes(directory)) {
      violations.push(`${directory}: dependency-matrix root is missing from workspace globs`);
    }
  }
}

export function lintDependencies(
  root = process.cwd(),
  options = { checkVerificationExportSurface: true },
) {
  const violations = [];
  const checkedFiles = [];

  checkWorkspaceCoverage(root, violations);

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
      if (!isTestFile(relativeFile) && analysis.hasCommonJsLoader) {
        violations.push(
          `${relativeFile}: require()/createRequire are forbidden in production package code`,
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
            imported.names.includes("makeVerificationProviderRegistryLayer") ||
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
