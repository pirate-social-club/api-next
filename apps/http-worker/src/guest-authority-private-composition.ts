// Private accepted integration seam: definitions remain disabled.
import { guestParticipationRegistry } from "@pirate/contracts";
import {
  type GuestAuthorityCompositionDependencies,
  guestAccountingNames,
  guestLearningNames,
  makeGuestAuthorityComposition,
} from "./guest-authority-controller-composition.ts";
export type GuestAuthorityPrivateCompositionDependencies = GuestAuthorityCompositionDependencies;
export function makeGuestAuthorityPrivateComposition(
  dependencies: GuestAuthorityPrivateCompositionDependencies,
) {
  for (const name of [...guestLearningNames, ...guestAccountingNames])
    if (guestParticipationRegistry[name].implementation !== "disabled")
      throw new Error("Private authority composition requires disabled declarations");
  return Object.freeze({
    ...makeGuestAuthorityComposition(dependencies),
    disabledLearningDefinitions: Object.freeze(
      Object.fromEntries(guestLearningNames.map((name) => [name, "disabled" as const])),
    ),
    disabledAccountDefinitions: Object.freeze(
      Object.fromEntries(guestAccountingNames.map((name) => [name, "disabled" as const])),
    ),
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
