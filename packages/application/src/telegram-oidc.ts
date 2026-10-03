import { Data, type Effect } from "effect";

/** Closed reasons keep provider bodies, tokens and profiles out of errors. */
export class TelegramOidcRejected extends Data.TaggedError("TelegramOidcRejected")<{
  readonly reason: "invalid_input" | "invalid_proof" | "provider_unavailable";
}> {}

/** Server-only transaction material. Only authorizationUrl goes to the browser. */
export interface TelegramOidcAuthorization {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
}

export interface TelegramOidcCode {
  readonly code: string;
  readonly nonce: string;
  readonly verifier: string;
}

/** Evidence only: this is neither a Pirate session nor a delegated bot grant. */
export interface TelegramOidcIdentity {
  readonly telegramUserId: string;
}

export interface TelegramOidcClient {
  /** Verify key availability before consuming a one-time authorization code. */
  readonly prepare: () => Effect.Effect<void, TelegramOidcRejected>;
  readonly authorize: () => Effect.Effect<TelegramOidcAuthorization, TelegramOidcRejected>;
  /** The caller must atomically claim its browser-bound transaction first. */
  readonly exchange: (
    input: TelegramOidcCode,
  ) => Effect.Effect<TelegramOidcIdentity, TelegramOidcRejected>;
}
