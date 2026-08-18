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

const OperationPath = Schema.Struct({ operationRef: Schema.NonEmptyString });
const TransactionHash = Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{64}$/u));
const Address = Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{40}$/u));
const AtomicAmount = Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/u));
const FundingStatus = Schema.Literals([
  "planned",
  "confirming",
  "confirmed",
  "reverted",
  "reclaimable_failed",
  "reconciliation_required",
]);

const StatusResponse = Schema.Struct({
  operation_ref: Schema.NonEmptyString,
  status: FundingStatus,
  version: Schema.Int,
});

export const BeginCommunityPurchaseFunding = endpoint({
  method: "POST",
  path: "/money/community-purchase-funding",
  auth: Auth.user(),
  request: {
    body: Schema.Struct({
      quote_id: Schema.NonEmptyString,
      client_nonce: Schema.NonEmptyString,
    }),
  },
  response: Schema.Struct({
    operation_ref: Schema.NonEmptyString,
    status: FundingStatus,
    version: Schema.Int,
    replayed: Schema.Boolean,
    funding: Schema.Struct({
      chain_id: Schema.Int,
      token_contract: Address,
      token_decimals: Schema.Literal(6),
      sender: Address,
      recipient: Address,
      amount_atomic: AtomicAmount,
      required_confirmations: Schema.Int,
    }),
  }),
  successStatus: [200, 201],
  errors: [AuthError, BadRequest, Conflict, InternalError],
});

export const ObserveCommunityPurchaseFunding = endpoint({
  method: "POST",
  path: "/money/community-purchase-funding/:operationRef/observations",
  auth: Auth.user(),
  request: {
    path: OperationPath,
    body: Schema.Struct({ transaction_hash: TransactionHash }),
  },
  response: Schema.Struct({ ...StatusResponse.fields, replayed: Schema.Boolean }),
  errors: [
    AuthError,
    BadRequest,
    Conflict,
    RetryableConflict,
    NotFound,
    ProviderUnavailable,
    InternalError,
  ],
});

export const GetCommunityPurchaseFundingStatus = endpoint({
  method: "GET",
  path: "/money/community-purchase-funding/:operationRef",
  auth: Auth.user(),
  request: { path: OperationPath },
  response: StatusResponse,
  errors: [AuthError, BadRequest, NotFound, InternalError],
});
