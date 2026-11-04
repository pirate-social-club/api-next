import type { VerificationProviderRegistryService } from "@pirate/application/verification";

/** Code injection only: the normal Worker entrypoint never supplies an override. */
export function assertVerificationRegistryOverride(
  environment: string | undefined,
  registry: VerificationProviderRegistryService | undefined,
): void {
  if (registry !== undefined && environment !== "development") {
    throw new Error("Verification registry overrides are restricted to development builds");
  }
}
