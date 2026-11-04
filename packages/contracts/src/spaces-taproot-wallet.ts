import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import { AuthError, BadRequest, Conflict, InternalError, NotFound } from "./errors.ts";

const id = Schema.String.check(
  Schema.makeFilter((value) =>
    value.length > 0 &&
    value.length <= 128 &&
    value === value.trim() &&
    ![...value].some(
      (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
    )
      ? undefined
      : "Expected a bounded identifier",
  ),
);
const token = Schema.String.check(
  Schema.makeFilter((value) =>
    value.length > 0 && value.length <= 16 * 1024 && !/[\r\n]/u.test(value)
      ? undefined
      : "Expected a bounded Privy token",
  ),
);
const hexSignature = Schema.String.check(
  Schema.makeFilter((value) =>
    /^[0-9a-f]{128}$/u.test(value) ? undefined : "Expected a BIP-340 signature",
  ),
);
const proof = Schema.Struct({
  type: Schema.Literal("privy_access_token"),
  privy_access_token: token,
  privy_identity_token: Schema.optional(Schema.NullOr(token)),
});
const path = Schema.Struct({ personaId: id });
const identity = Schema.Struct({ assignment_id: id, network: Schema.Literal("mainnet") });
const status = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("prepared"), ...identity.fields }),
  Schema.Struct({ kind: Schema.Literal("pending"), ...identity.fields }),
  Schema.Struct({ kind: Schema.Literal("ambiguous"), ...identity.fields }),
  Schema.Struct({
    kind: Schema.Literal("candidate"),
    ...identity.fields,
    provider_wallet_id: id,
    address: Schema.String,
    output_script_hex: Schema.String,
    challenge_digest_hex: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("active"),
    ...identity.fields,
    provider_wallet_id: id,
    address: Schema.String,
    output_script_hex: Schema.String,
  }),
]);

/** A successful first prepare is the only browser permission to call provider add. */
export const PreparePersonaSpacesTaproot = endpoint({
  method: "POST",
  path: "/personas/:personaId/wallets/spaces-taproot/prepare",
  auth: Auth.userOrAdmin(),
  request: { path, body: Schema.Struct({ idempotency_key: id, proof }) },
  response: Schema.Struct({ ...identity.fields, may_create: Schema.Boolean }),
  successStatus: 200,
  errors: [AuthError, BadRequest, Conflict, InternalError, NotFound],
});

/** Inventory reconciliation never calls provider add, including after lost responses. */
export const GetPersonaSpacesTaprootStatus = endpoint({
  method: "POST",
  path: "/personas/:personaId/wallets/spaces-taproot/status",
  auth: Auth.userOrAdmin(),
  request: { path, body: Schema.Struct({ proof }) },
  response: status,
  successStatus: 200,
  errors: [AuthError, BadRequest, Conflict, InternalError, NotFound],
});

/** Binds the unique new provider wallet after a BIP-340 challenge signature. */
export const ConfirmPersonaSpacesTaproot = endpoint({
  method: "POST",
  path: "/personas/:personaId/wallets/spaces-taproot/confirm",
  auth: Auth.userOrAdmin(),
  request: {
    path,
    body: Schema.Struct({
      proof,
      assignment_id: id,
      provider_wallet_id: id,
      signature_hex: hexSignature,
    }),
  },
  response: Schema.Struct({
    ...identity.fields,
    address: Schema.String,
    output_script_hex: Schema.String,
    replay: Schema.Boolean,
  }),
  successStatus: 200,
  errors: [AuthError, BadRequest, Conflict, InternalError, NotFound],
});
