import { AuthError } from "@pirate/contracts";
import { Effect } from "effect";

export type AuthenticateSessionInput = Readonly<{
  /** Machine callers use an explicit bearer credential. */
  readonly authorization?: string;
  /** Browser callers use the host-only session cookie. */
  readonly sessionCookie?: string;
}>;

export type AuthenticatedSession = Readonly<{
  readonly subject: string;
  readonly kind: "user" | "admin" | "agent" | "device";
  readonly scopes?: readonly string[];
  /** Optional wallet authenticated by the session exchange. */
  readonly walletAddress?: string;
}>;

export type AuthorizeSessionInput = Readonly<{
  readonly session: AuthenticatedSession;
  readonly allowedKinds: readonly AuthenticatedSession["kind"][];
}>;

export interface BearerSessionVerifier {
  readonly verify: (input: {
    readonly token: string;
    readonly requiredClassification: "user";
  }) => Effect.Effect<
    {
      readonly userId: string;
      readonly classification: "user" | "device";
      readonly scope: { readonly tokens: readonly string[] };
      readonly walletAddress?: string;
    },
    unknown
  >;
}

export interface SessionAuthenticationServices {
  readonly verifier: BearerSessionVerifier;
}

const bearerToken = (authorization: string | undefined): string | null => {
  if (authorization === undefined) return null;
  const match = /^Bearer ([^\s]+)$/u.exec(authorization);
  return match?.[1] ?? null;
};

export const authenticateSession = Effect.fn("authenticateSession")(function* (
  input: AuthenticateSessionInput,
  services: SessionAuthenticationServices,
): Effect.fn.Return<AuthenticatedSession, AuthError> {
  const token = input.sessionCookie ?? bearerToken(input.authorization);
  if (token === null) return yield* new AuthError({ message: "Authentication failed" });

  const verified = yield* services.verifier
    .verify({ token, requiredClassification: "user" })
    .pipe(Effect.mapError(() => new AuthError({ message: "Authentication failed" })));
  if (verified.classification !== "user") {
    return yield* new AuthError({ message: "Authentication failed" });
  }
  return {
    subject: verified.userId,
    kind: "user",
    scopes: verified.scope.tokens,
    ...(verified.walletAddress === undefined ? {} : { walletAddress: verified.walletAddress }),
  };
});

export const authorizeSession = Effect.fn("authorizeSession")(function* (
  input: AuthorizeSessionInput,
): Effect.fn.Return<void, AuthError> {
  if (
    input.session.subject.length === 0 ||
    input.session.subject.trim() !== input.session.subject ||
    !input.allowedKinds.includes(input.session.kind)
  ) {
    return yield* new AuthError({ message: "Authorization failed" });
  }
});
