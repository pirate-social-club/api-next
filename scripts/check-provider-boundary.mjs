const PROVIDER_IMPLEMENTATION_PREFIX = "packages/platform-cf/src/verification/providers/";
const PROVIDER_BOUNDARY_IMPORTS = [
  "@pirate/application/verification",
  "@pirate/domain/verification",
];

/**
 * Keep provider implementation imports on the stable verification seams.
 * External packages and local helpers are allowed; parent-relative imports
 * are rejected so a provider cannot escape into routes or platform internals.
 */
export function providerBoundaryViolation(relativeFile, spec) {
  if (!relativeFile.startsWith(PROVIDER_IMPLEMENTATION_PREFIX)) return undefined;
  if (spec.split("/").includes("..")) {
    return `${relativeFile}: provider adapters may not use parent-relative imports (found ${spec})`;
  }
  if (!spec.startsWith("@pirate/")) return undefined;
  if (PROVIDER_BOUNDARY_IMPORTS.includes(spec)) {
    return undefined;
  }
  return `${relativeFile}: provider adapters may import only @pirate/application/verification or @pirate/domain/verification (found ${spec})`;
}
