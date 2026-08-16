import { AuthError, type GetMyProfile, InternalError } from "@pirate/contracts";
import { Effect, type Schema } from "effect";
import type { IdentityStore } from "../ports.ts";
import { loadIdentityAccount } from "./identity-account.ts";

export type GetMyProfileInput = Readonly<{
  readonly userId: string;
}>;

export type MyProfile = Schema.Schema.Type<typeof GetMyProfile.response>;

export interface ProfileServices {
  readonly identityStore: IdentityStore["Service"];
}

export const getMyProfile = Effect.fn("getMyProfile")(function* (
  input: GetMyProfileInput,
  services: ProfileServices,
): Effect.fn.Return<MyProfile, AuthError | InternalError> {
  if (input.userId.length === 0 || input.userId.trim() !== input.userId) {
    return yield* new AuthError({ message: "Authentication failed" });
  }
  const account = yield* loadIdentityAccount(input.userId, services).pipe(
    Effect.mapError(() => new InternalError({ message: "Profile lookup failed" })),
  );
  if (account === null) {
    return yield* new AuthError({ message: "Authentication failed" });
  }
  return account.profile;
});

export const makeProfileHandler =
  (services: ProfileServices) =>
  async (input: GetMyProfileInput): Promise<MyProfile> =>
    Effect.runPromise(getMyProfile(input, services));
