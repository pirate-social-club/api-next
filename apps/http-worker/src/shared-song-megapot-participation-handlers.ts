import { Schema } from "effect";
import {
  AuthError,
  InternalError,
  NotFound,
  ProviderUnavailable,
} from "../../../packages/contracts/src/errors.ts";
import {
  GetSharedSongMegapotParticipationV2,
  type SharedSongMegapotParticipationV2,
} from "../../../packages/contracts/src/shared-song-megapot-participation.ts";
import type { EndpointHandler } from "./transport.ts";

type ParticipantRead = (
  account: string,
  community: string,
  post: string,
) => Promise<
  | { readonly status: "not_found" }
  | { readonly status: "found"; readonly participation: SharedSongMegapotParticipationV2 | null }
>;

export function makeSharedSongMegapotParticipationHandler(
  read: ParticipantRead,
  rewardsEnabled: boolean,
): EndpointHandler {
  return async (ctx) => {
    if (ctx.principal?.kind !== "user") throw new AuthError({ message: "Authentication required" });
    if (!rewardsEnabled)
      throw new ProviderUnavailable({ message: "Reward services are unavailable" });
    const path = Schema.decodeUnknownSync(GetSharedSongMegapotParticipationV2.request.path, {
      onExcessProperty: "error",
    })(ctx.params);
    let result: Awaited<ReturnType<typeof read>>;
    try {
      result = await read(ctx.principal.subject, path.communityId, path.postId);
    } catch {
      throw new InternalError({ message: "Shared pot participation unavailable" });
    }
    if (result.status === "not_found") throw new NotFound({ message: "Song unavailable" });
    return result.participation;
  };
}
