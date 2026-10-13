// Private accepted integration seam: definitions remain disabled.
import { guestParticipationRegistry } from "@pirate/contracts";
import { makeGuestLearningComposition } from "./guest-learning-controller-composition.ts";
export function makeGuestLearningPrivateComposition(
  dependencies: Parameters<typeof makeGuestLearningComposition>[0],
) {
  for (const declaration of Object.values(guestParticipationRegistry))
    if (declaration.implementation !== "disabled")
      throw new Error("Private guest definitions must stay disabled");
  return Object.freeze({
    ...makeGuestLearningComposition(dependencies),
    disabledDefinitions: Object.freeze(
      Object.fromEntries(
        Object.keys(guestParticipationRegistry).map((name) => [name, "disabled" as const]),
      ),
    ),
  });
}
