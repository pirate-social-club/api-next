import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import { AuthError, BadRequest, Conflict, InternalError, NotFound } from "./errors.ts";
import {
  BoundedIdentifier,
  CanonicalInstant,
  PositiveInteger,
  Sha256Hex,
} from "./handle-sales-scalars.ts";

/** A receipt is observable state, never permission to call the wallet. */
export const HnsWalletPublicationAttemptV1 = Schema.Struct({
  attempt_id: BoundedIdentifier,
  root_import_session_id: BoundedIdentifier,
  root_label: Schema.String,
  publish_plan_sha256: Sha256Hex,
  state: Schema.Literals([
    "reserved",
    "dispatch_authorized",
    "sent",
    "confirmed",
    "cancelled",
    "retry_accepted",
  ]),
  txid: Schema.NullOr(Sha256Hex),
  created_at: CanonicalInstant,
  dispatch_authorized_at: Schema.NullOr(CanonicalInstant),
  resolved_at: Schema.NullOr(CanonicalInstant),
});
export type HnsWalletPublicationAttemptV1 = Schema.Schema.Type<
  typeof HnsWalletPublicationAttemptV1
>;

export const HnsWalletPublicationCommandV1 = Schema.Union([
  Schema.Struct({
    command: Schema.Literal("reserve"),
    idempotency_key: BoundedIdentifier,
    expected_revision: PositiveInteger,
    publish_plan_sha256: Sha256Hex,
  }),
  Schema.Struct({
    command: Schema.Literal("authorize_dispatch"),
    attempt_id: BoundedIdentifier,
    expected_revision: PositiveInteger,
    publish_plan_sha256: Sha256Hex,
  }),
  Schema.Struct({ command: Schema.Literal("cancel"), attempt_id: BoundedIdentifier }),
  Schema.Struct({
    command: Schema.Literal("report_txid"),
    attempt_id: BoundedIdentifier,
    txid: Sha256Hex,
    dispatch_secret: Sha256Hex,
  }),
  Schema.Struct({
    command: Schema.Literal("accept_retry"),
    attempt_id: BoundedIdentifier,
    accept_duplicate_or_late_publication: Schema.Literal(true),
  }),
]);
export type HnsWalletPublicationCommandV1 = Schema.Schema.Type<
  typeof HnsWalletPublicationCommandV1
>;

export const HnsWalletPublicationResultV1 = Schema.Struct({
  outcome: Schema.Literals([
    "reserved",
    "replayed",
    "cancelled",
    "dispatch_authorized",
    "already_authorized",
    "reported",
    "retry_accepted",
  ]),
  attempt: HnsWalletPublicationAttemptV1,
  // Returned only by the authorization winner; never part of an observable attempt.
  dispatch_secret: Schema.NullOr(Sha256Hex),
});
export type HnsWalletPublicationResultV1 = Schema.Schema.Type<typeof HnsWalletPublicationResultV1>;

const path = Schema.Struct({ communityId: BoundedIdentifier, sessionId: BoundedIdentifier });
const errors = [AuthError, BadRequest, Conflict, InternalError, NotFound] as const;

export const GetHnsWalletPublication = endpoint({
  method: "GET",
  path: "/communities/:communityId/hns-root-imports/:sessionId/publication-attempts",
  auth: Auth.userOrAdmin(),
  request: { path, exactRawPathParameters: ["communityId", "sessionId"] },
  response: Schema.Struct({ attempt: Schema.NullOr(HnsWalletPublicationAttemptV1) }),
  successStatus: 200,
  errors,
});

export const CommandHnsWalletPublication = endpoint({
  method: "POST",
  path: "/communities/:communityId/hns-root-imports/:sessionId/publication-attempts",
  auth: Auth.userOrAdmin(),
  request: {
    path,
    exactRawPathParameters: ["communityId", "sessionId"],
    body: HnsWalletPublicationCommandV1,
    maxBodyBytes: 2048,
  },
  response: HnsWalletPublicationResultV1,
  successStatus: 200,
  errors,
});
