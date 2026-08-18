import { AuthError, type GetCurrentUser, InternalError } from "@pirate/contracts";
import { Effect, type Schema } from "effect";
import type { IdentityStore } from "../ports.ts";
import { loadIdentityAccount } from "./identity-account.ts";

export type GetCurrentUserInput = Readonly<{
  readonly userId: string;
}>;

export type CurrentUser = Schema.Schema.Type<typeof GetCurrentUser.response>;

export interface CurrentUserServices {
  readonly identityStore: IdentityStore["Service"];
}

/**
 * Return the validated identity projection used by session exchange and
 * profile. Current-user identity is independent of community context.
 */
export const getCurrentUser = Effect.fn("getCurrentUser")(function* (
  input: GetCurrentUserInput,
  services: CurrentUserServices,
): Effect.fn.Return<CurrentUser, AuthError | InternalError> {
  if (input.userId.length === 0 || input.userId.trim() !== input.userId) {
    return yield* new AuthError({ message: "Authentication failed" });
  }

  const account = yield* loadIdentityAccount(input.userId, services).pipe(
    Effect.mapError(() => new InternalError({ message: "Current user lookup failed" })),
  );
  if (account === null) {
    return yield* new AuthError({ message: "Authentication failed" });
  }
  return account.user;
});

export const makeCurrentUserHandler =
  (services: CurrentUserServices) =>
  async (input: GetCurrentUserInput): Promise<CurrentUser> =>
    Effect.runPromise(getCurrentUser(input, services));
