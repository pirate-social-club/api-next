import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import { AuthError, BadRequest, InternalError, RateLimited } from "./errors.ts";

const identity = {
  version: Schema.Literal("account-age-verification-v1"),
  minimum_age: Schema.Literal(18),
};
export const AccountAgeVerificationV1 = Schema.Union([
  Schema.Struct({ ...identity, status: Schema.Literal("verified") }),
  Schema.Struct({ ...identity, status: Schema.Literal("unavailable") }),
  Schema.Struct({
    ...identity,
    status: Schema.Literal("verification_required"),
    requirement_hash: Schema.NonEmptyString,
    ceremony_intent_id: Schema.NonEmptyString,
    generation: Schema.Int.check(
      Schema.makeFilter((value) => Number.isSafeInteger(value) && value > 0),
    ),
    provider_id: Schema.Literals(["self.pass", "zkpassport"]),
    accepted_provider_ids: Schema.Tuple([
      Schema.Literal("self.pass"),
      Schema.Literal("zkpassport"),
    ]),
  }),
]);

/** Private authority for an in-place age ceremony; contains no target resource or document facts. */
export const GetMyAgeVerification = endpoint({
  method: "GET",
  path: "/me/age-verification",
  auth: Auth.userOrAdmin(),
  response: AccountAgeVerificationV1,
  successStatus: 200,
  errors: [AuthError, BadRequest, InternalError, RateLimited],
});
