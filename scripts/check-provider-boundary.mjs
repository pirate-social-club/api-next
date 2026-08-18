export const PROVIDER_IMPLEMENTATION_PREFIX = "packages/platform-cf/src/verification/providers/";
export const PROVIDER_REGISTRY_ASSEMBLY_FILE =
  "packages/platform-cf/src/verification/provider-registry.ts";
export const PROVIDER_TESTING_PREFIX = "packages/testing/src/verification/";

const PROVIDER_BOUNDARY_IMPORTS = [
  "@pirate/application/verification",
  "@pirate/domain/verification",
  "@pirate/verifier-response-contract",
];
const PROVIDER_TEST_IMPORTS = [...PROVIDER_BOUNDARY_IMPORTS, "@pirate/testing/verification"];

/**
 * Keep provider implementation imports on the stable verification seams.
 * External packages and local helpers are allowed; parent-relative imports
 * are rejected so a provider cannot escape into routes or platform internals.
 */
export function providerBoundaryViolation(relativeFile, spec) {
  const providerFile = relativeFile.startsWith(PROVIDER_IMPLEMENTATION_PREFIX);
  const registryAssembly = relativeFile === PROVIDER_REGISTRY_ASSEMBLY_FILE;
  if (!providerFile && !registryAssembly) return undefined;
  if (spec.split("/").includes("..")) {
    return `${relativeFile}: provider boundary files may not use parent-relative imports (found ${spec})`;
  }
  if (registryAssembly && spec.startsWith("./providers/")) return undefined;
  if (!spec.startsWith("@pirate/")) {
    if (registryAssembly && spec.startsWith(".")) {
      return `${relativeFile}: provider registry may import only provider implementations and stable verification seams (found ${spec})`;
    }
    return undefined;
  }
  const allowed = relativeFile.endsWith(".test.ts")
    ? PROVIDER_TEST_IMPORTS
    : PROVIDER_BOUNDARY_IMPORTS;
  if (allowed.includes(spec)) {
    return undefined;
  }
  return `${relativeFile}: provider boundary files may import only stable verification seams (found ${spec})`;
}
