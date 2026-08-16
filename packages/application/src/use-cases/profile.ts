import { type GetMyProfile, NotImplemented } from "@pirate/contracts";
import { Effect, type Schema } from "effect";

export type GetMyProfileInput = Readonly<{
  readonly userId: string;
}>;

export type MyProfile = Schema.Schema.Type<typeof GetMyProfile.response>;

/**
 * The integration checkpoint supplies Lane B's retained serializer and Lane
 * C's identity repository behind this application boundary. Lane A keeps the
 * HTTP composition usable while that coordinator-mediated wiring is pending.
 */
export function getMyProfile(_input: GetMyProfileInput): Effect.Effect<MyProfile, NotImplemented> {
  return Effect.fail(new NotImplemented({ message: "GetMyProfile is not implemented" }));
}
