// Test-owned private controller harness. It installs no production route or runtime.
import { guestParticipationRegistry } from "@pirate/contracts";
import {
  type GuestAuthorityCompositionDependencies,
  guestAccountingNames,
  makeGuestAuthorityComposition,
} from "./guest-authority-controller-composition.ts";
export type GuestAuthorityPrivateCompositionDependencies = GuestAuthorityCompositionDependencies;
export function makeGuestAuthorityPrivateComposition(
  dependencies: GuestAuthorityPrivateCompositionDependencies,
) {
  // Actual canonical metadata is consumed directly. Accounting remains held;
  // this helper neither clones nor rewrites learning declarations.
  for (const name of guestAccountingNames)
    if (guestParticipationRegistry[name].implementation !== "disabled")
      throw new Error("Private authority composition requires disabled accounting declarations");
  return Object.freeze({
    ...makeGuestAuthorityComposition(dependencies),
    pendingLearningInputs: Object.freeze({
      currentResourcePolicy:
        dependencies.currentResourcePolicy === null
          ? null
          : Object.freeze({ ...dependencies.currentResourcePolicy }),
      disclosure:
        dependencies.disclosure === null ? null : Object.freeze({ ...dependencies.disclosure }),
      trustedEdgeForRequest: dependencies.trustedEdgeForRequest,
    }),
  });
}
