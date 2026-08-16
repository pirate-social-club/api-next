import { BadRequest, InternalError } from "@pirate/contracts";
import { Effect } from "effect";
import {
  FeedRepositoryError,
  type FeedStore,
  type HomeFeedDocument,
  type HomeFeedQuery,
} from "../../ports.ts";

export interface HomeFeedServices {
  readonly feedStore: FeedStore["Service"];
}

export type GetHomeFeedInput = Readonly<{
  readonly query: HomeFeedQuery;
  readonly viewerUserId?: string;
}>;

const validOptionalText = (value: string | undefined, maxLength: number): boolean =>
  value === undefined ||
  (value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value &&
    !value.includes("\u0000"));

const mapFeedFailure = (error: unknown): BadRequest | InternalError =>
  error instanceof FeedRepositoryError && error.reason === "invalid-cursor"
    ? new BadRequest({ message: "Invalid home feed cursor" })
    : new InternalError({ message: "Home feed lookup failed" });

export const getHomeFeed = Effect.fn("getHomeFeed")(function* (
  input: GetHomeFeedInput,
  services: HomeFeedServices,
): Effect.fn.Return<HomeFeedDocument, BadRequest | InternalError> {
  if (
    !validOptionalText(input.viewerUserId, 256) ||
    !validOptionalText(input.query.locale, 64) ||
    !validOptionalText(input.query.cursor, 2_048)
  ) {
    return yield* new BadRequest({ message: "Invalid home feed request" });
  }

  return yield* services.feedStore.listHome(input).pipe(Effect.mapError(mapFeedFailure));
});

export const getPublicHomeFeed = (
  query: HomeFeedQuery,
  services: HomeFeedServices,
): Effect.Effect<HomeFeedDocument, BadRequest | InternalError> => getHomeFeed({ query }, services);
