import { Effect } from "effect";
import type { VerificationProviderPlanInput, VerificationProviderPlanResult } from "./adapter.ts";
import type { VerificationProviderRegistryService } from "./registry.ts";

export interface VerificationProviderPlanningCandidate {
  readonly provider_id: string;
  readonly input: VerificationProviderPlanInput;
}

export type PlannedVerificationProvider = Readonly<
  { readonly provider_id: string } & VerificationProviderPlanResult
>;

/**
 * Plans every configured provider deterministically. One unavailable provider
 * never hides another supported option; callers may offer all supported
 * candidates and let the user choose a document-compatible ceremony.
 */
export function planVerificationProviderCandidates(
  registry: VerificationProviderRegistryService,
  candidates: readonly VerificationProviderPlanningCandidate[],
): Effect.Effect<readonly PlannedVerificationProvider[]> {
  return Effect.gen(function* () {
    const planned: PlannedVerificationProvider[] = [];
    for (const candidate of [...candidates].sort((left, right) =>
      left.provider_id.localeCompare(right.provider_id),
    )) {
      const result = yield* registry.resolve(candidate.provider_id).pipe(
        Effect.flatMap((provider) => provider.plan(candidate.input)),
        Effect.catch((error) =>
          Effect.succeed({
            status: error._tag === "VerificationProviderRejected" ? "unsupported" : "unknown",
          } as const),
        ),
      );
      planned.push({ provider_id: candidate.provider_id, ...result });
    }
    return planned;
  });
}
