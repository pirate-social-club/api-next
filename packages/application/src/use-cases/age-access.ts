import {
  type AccountAgeCapabilityV1,
  type AgeAttestationProjectionV1,
  BadRequest,
  InternalError,
  type MinimumAgeAttestationV1,
} from "@pirate/contracts";
import { Context, Data, Effect, type Schema } from "effect";
import type { ControlPlaneError, M2Actor } from "../ports.ts";

export type AccountAgeCapability = Schema.Schema.Type<typeof AccountAgeCapabilityV1>;
export type AgeAttestationProjection = Schema.Schema.Type<typeof AgeAttestationProjectionV1>;
export type MinimumAgeAttestation = Schema.Schema.Type<typeof MinimumAgeAttestationV1>;

export class AgeAccessStoreError extends Data.TaggedError("AgeAccessStoreError")<{
  readonly operation: "capability" | "attestation";
  readonly reason: "invalid-row" | "conflict";
}> {}

export type AgeAccessStoreFailure = AgeAccessStoreError | ControlPlaneError;

export interface AgeAccessStoreService {
  readonly hasMinimumAgeAttestation: (input: {
    readonly accountId: string;
  }) => Effect.Effect<boolean, AgeAccessStoreFailure>;
  readonly getCapability: (input: {
    readonly accountId: string;
  }) => Effect.Effect<AccountAgeCapability, AgeAccessStoreFailure>;
  readonly attestMinimumAge: (input: {
    readonly accountId: string;
    readonly attestation: MinimumAgeAttestation;
  }) => Effect.Effect<AgeAttestationProjection, AgeAccessStoreFailure>;
}

export class AgeAccessStore extends Context.Service<AgeAccessStore, AgeAccessStoreService>()(
  "AgeAccessStore",
) {}

const validActor = (actor: M2Actor): boolean =>
  actor.kind !== "agent" && actor.userId.length > 0 && actor.userId === actor.userId.trim();

export const getMyAgeCapability = Effect.fn("getMyAgeCapability")(function* (
  input: { readonly actor: M2Actor },
  services: { readonly ageAccessStore: AgeAccessStoreService },
) {
  if (!validActor(input.actor)) return yield* new BadRequest({ message: "Invalid account" });
  return yield* services.ageAccessStore
    .getCapability({ accountId: input.actor.userId })
    .pipe(Effect.mapError(() => new InternalError({ message: "Age capability is unavailable" })));
});

export const attestMyMinimumAge = Effect.fn("attestMyMinimumAge")(function* (
  input: { readonly actor: M2Actor; readonly attestation: MinimumAgeAttestation },
  services: { readonly ageAccessStore: AgeAccessStoreService },
) {
  if (!validActor(input.actor)) return yield* new BadRequest({ message: "Invalid account" });
  return yield* services.ageAccessStore
    .attestMinimumAge({ accountId: input.actor.userId, attestation: input.attestation })
    .pipe(Effect.mapError(() => new InternalError({ message: "Age attestation failed" })));
});
