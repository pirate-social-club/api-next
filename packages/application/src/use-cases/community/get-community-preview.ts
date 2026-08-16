import { BadRequest, type GetCommunityPreview, InternalError, NotFound } from "@pirate/contracts";
import { Effect, type Schema } from "effect";
import { type CommunityPreviewDocument, CommunityRepositoryError } from "../../ports.ts";
import { type CommunityServices, isUsableId } from "./services.ts";

export type GetCommunityPreviewInput = Readonly<{
  readonly communityId: string;
  readonly locale?: string;
  readonly viewerUserId?: string;
}>;

export type GetCommunityPreviewDocument = Schema.Schema.Type<typeof GetCommunityPreview.response>;

export const getCommunityPreview = Effect.fn("getCommunityPreview")(function* (
  input: GetCommunityPreviewInput,
  services: CommunityServices,
): Effect.fn.Return<GetCommunityPreviewDocument, BadRequest | InternalError | NotFound> {
  if (
    !isUsableId(input.communityId) ||
    (input.viewerUserId !== undefined && !isUsableId(input.viewerUserId))
  ) {
    return yield* new BadRequest({ message: "Invalid community reference" });
  }

  const preview = yield* services.communityStore
    .getPreview(input)
    .pipe(
      Effect.mapError((error) =>
        error instanceof CommunityRepositoryError && error.reason === "not-found"
          ? new NotFound({ message: "Community not found" })
          : new InternalError({ message: "Community preview lookup failed" }),
      ),
    );
  if (preview === null) return yield* new NotFound({ message: "Community not found" });
  return preview satisfies CommunityPreviewDocument;
});
