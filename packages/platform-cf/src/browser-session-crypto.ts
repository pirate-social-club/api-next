import {
  type BrowserSessionCrypto,
  BrowserSessionFailure,
} from "@pirate/application/use-cases/browser-sessions";
import { Effect } from "effect";
import { type SessionCrypto, SessionCryptoError } from "./session-crypto.ts";

const hex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export function makeBrowserSessionCrypto(
  session: SessionCrypto,
  now: () => number = () => Math.floor(Date.now() / 1_000),
): BrowserSessionCrypto {
  return {
    now,
    inspect: (token) =>
      Effect.tryPromise({
        try: () => session.verify(token),
        catch: (error) =>
          new BrowserSessionFailure({
            reason:
              error instanceof SessionCryptoError &&
              !["configuration_invalid", "key_import_failed", "key_pair_mismatch"].includes(
                error.code,
              )
                ? "invalid"
                : "unavailable",
          }),
      }),
    mint: (input) =>
      Effect.tryPromise({
        try: () =>
          session.sign({
            sub: input.subject,
            scope: input.scope,
            browserSessionId: input.sessionId,
            exp: input.expiresAt,
            ...(input.walletAddress === undefined ? {} : { walletAddress: input.walletAddress }),
          }),
        catch: () => new BrowserSessionFailure({ reason: "unavailable" }),
      }),
    random: () =>
      Effect.try({
        try: () => hex(crypto.getRandomValues(new Uint8Array(32))),
        catch: () => new BrowserSessionFailure({ reason: "unavailable" }),
      }),
    hash: (value) =>
      Effect.tryPromise({
        try: async () =>
          hex(
            new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
          ),
        catch: () => new BrowserSessionFailure({ reason: "unavailable" }),
      }),
  };
}
