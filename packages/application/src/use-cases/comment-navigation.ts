import {
  AuthError,
  BadRequest,
  type InternalError,
  type NotFound,
  type ResolveCommentNavigationV1,
} from "@pirate/contracts";
import { Effect, Schema } from "effect";

export interface CommentNavigationStore {
  readonly resolve: (input: {
    viewerUserId: string;
    commentId: string;
  }) => Effect.Effect<
    Schema.Schema.Type<typeof ResolveCommentNavigationV1.response>,
    NotFound | InternalError
  >;
}
const Input = Schema.Struct({
  viewerUserId: Schema.NonEmptyString,
  commentId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
});
export const resolveCommentNavigation = Effect.fn("resolveCommentNavigation")(function* (
  input: { viewerUserId: string; commentId: string },
  store: CommentNavigationStore,
) {
  if (!input.viewerUserId.trim())
    return yield* new AuthError({ message: "Authentication required" });
  yield* Schema.decodeUnknownEffect(Input)(input).pipe(
    Effect.mapError(() => new BadRequest({ message: "Invalid comment navigation request" })),
  );
  return yield* store.resolve(input);
});
