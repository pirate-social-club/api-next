// Test-owned private controller harness. It installs no production route or runtime.
import { guestParticipationRegistry } from "@pirate/contracts";
import { guestAccountingNames } from "./guest-authority-controller-composition.ts";
import { makeGuestLearningComposition } from "./guest-learning-controller-composition.ts";
export function makeGuestLearningPrivateComposition(
  dependencies: Parameters<typeof makeGuestLearningComposition>[0],
) {
  for (const name of guestAccountingNames)
    if (guestParticipationRegistry[name].implementation !== "disabled")
      throw new Error("Private learning composition requires disabled accounting declarations");
  return Object.freeze({ ...makeGuestLearningComposition(dependencies) });
}
