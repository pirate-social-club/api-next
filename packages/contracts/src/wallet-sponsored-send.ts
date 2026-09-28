import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import {
  AuthError,
  BadRequest,
  Conflict,
  InternalError,
  NotFound,
  ProviderUnavailable,
  RetryableConflict,
} from "./errors.ts";

const Identifier = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const InputAddress = Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{40}$/u));
const Address = Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{40}$/u));
const TransactionHash = Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{64}$/u));
const AtomicAmount = Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/u));
const Errors = [
  AuthError,
  BadRequest,
  Conflict,
  RetryableConflict,
  NotFound,
  InternalError,
  ProviderUnavailable,
] as const;

/** One user-authorized Wallet transfer, independent of how its tokens arrived. */
const WalletSponsoredSendV1 = Schema.Struct({
  object: Schema.Literal("wallet_sponsored_send"),
  send_id: Identifier,
  persona_id: Identifier,
  status: Schema.Literals([
    "reserved",
    "submitting",
    "submitted",
    "held",
    "confirmed",
    "reverted",
    "abandoned",
  ]),
  chain_id: Schema.Literals([8453, 84_532]),
  token_address: Address,
  sender_address: Address,
  recipient_address: Address,
  amount_atomic: AtomicAmount,
  transaction_hash: Schema.NullOr(TransactionHash),
  authorization: Schema.NullOr(
    Schema.Struct({
      wallet_id: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
      payload_base64: Schema.NonEmptyString,
    }),
  ),
});

/** Reserves one eligible token send for the signed-in account's persona. */
export const CreateWalletSponsoredSend = endpoint({
  method: "POST",
  path: "/wallet/personas/:personaId/sponsored-send",
  auth: Auth.user(),
  request: {
    path: Schema.Struct({ personaId: Identifier }),
    body: Schema.Struct({
      chain_id: Schema.Literals([8453, 84_532]),
      recipient: InputAddress,
      amount_atomic: AtomicAmount,
      idempotency_key: Identifier,
    }),
  },
  response: WalletSponsoredSendV1,
  errors: [...Errors],
});

export const SubmitWalletSponsoredSend = endpoint({
  method: "POST",
  path: "/wallet/sponsored-sends/:sendId/submit",
  auth: Auth.user(),
  request: {
    path: Schema.Struct({ sendId: Identifier }),
    body: Schema.Struct({
      authorization_signature: Schema.String.check(
        Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/u),
        Schema.isMaxLength(4096),
      ),
    }),
  },
  response: WalletSponsoredSendV1,
  errors: [...Errors],
});

export const GetWalletSponsoredSend = endpoint({
  method: "GET",
  path: "/wallet/sponsored-sends/:sendId",
  auth: Auth.user(),
  request: { path: Schema.Struct({ sendId: Identifier }) },
  response: WalletSponsoredSendV1,
  errors: [...Errors],
});

/** Finds an open send first, or the latest finished send for the persona. */
export const GetWalletSponsoredSendForPersona = endpoint({
  method: "GET",
  path: "/wallet/personas/:personaId/sponsored-send",
  auth: Auth.user(),
  request: { path: Schema.Struct({ personaId: Identifier }) },
  response: WalletSponsoredSendV1,
  errors: [...Errors],
});
