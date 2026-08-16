import { NotImplemented } from "@pirate/contracts";
import { Effect } from "effect";

export type AuthenticateSessionInput = Readonly<{
  readonly authorization: string;
}>;

export type AuthenticatedSession = Readonly<{
  readonly subject: string;
  readonly kind: "user" | "admin" | "agent" | "device";
  readonly scopes?: readonly string[];
}>;

export type AuthorizeSessionInput = Readonly<{
  readonly subject: string;
}>;

/** Lane C supplies bounded token verification and canonical identity checks. */
export function authenticateSession(
  _input: AuthenticateSessionInput,
): Effect.Effect<AuthenticatedSession, NotImplemented> {
  return Effect.fail(new NotImplemented({ message: "Session authentication is not implemented" }));
}

/** Lane C supplies endpoint authorization over the verified session principal. */
export function authorizeSession(
  _input: AuthorizeSessionInput,
): Effect.Effect<void, NotImplemented> {
  return Effect.fail(new NotImplemented({ message: "Session authorization is not implemented" }));
}
