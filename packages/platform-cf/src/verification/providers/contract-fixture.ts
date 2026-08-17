import type { VerificationProviderAdapter } from "@pirate/application/verification";
import type { ProofProviderManifest } from "@pirate/domain/verification";

/** Compile-only proof that an adapter needs only the two frozen seams. */
export type ProviderContractFixture = Readonly<{
  adapter: VerificationProviderAdapter;
  manifest: ProofProviderManifest;
}>;
