import {
  makeVerificationProviderRegistry,
  type VerificationProviderAdapter,
} from "@pirate/application/verification";

/**
 * The single production assembly point for provider adapters. Real providers
 * are added to this local list only after passing the shared conformance kit.
 */
const platformVerificationProviders: readonly VerificationProviderAdapter[] = [];

export function makePlatformVerificationProviderRegistry() {
  return makeVerificationProviderRegistry(platformVerificationProviders);
}
