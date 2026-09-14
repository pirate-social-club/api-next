import { type AccountAgeVerificationV1, BadRequest, InternalError } from "@pirate/contracts";
import { Data, Effect, type Schema } from "effect";
import type { ControlPlaneError, M2Actor } from "../ports.ts";

export type AccountAgeVerification = Schema.Schema.Type<typeof AccountAgeVerificationV1>;
export class AgeVerificationStoreError extends Data.TaggedError("AgeVerificationStoreError") {}
export interface AgeVerificationStoreService {
  readonly getVerification: (
    input: Readonly<{ accountId: string }>,
  ) => Effect.Effect<AccountAgeVerification, ControlPlaneError | AgeVerificationStoreError>;
}
export const getMyAgeVerification = Effect.fn("getMyAgeVerification")(function* (
  input: Readonly<{ actor: M2Actor }>,
  services: Readonly<{ ageVerificationStore: AgeVerificationStoreService }>,
) {
  if (
    input.actor.kind === "agent" ||
    !input.actor.userId ||
    input.actor.userId !== input.actor.userId.trim()
  ) {
    return yield* new BadRequest({ message: "Invalid account" });
  }
  return yield* services.ageVerificationStore
    .getVerification({ accountId: input.actor.userId })
    .pipe(Effect.mapError(() => new InternalError({ message: "Age verification is unavailable" })));
});
