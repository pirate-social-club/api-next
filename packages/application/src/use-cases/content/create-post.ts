import { Effect } from "effect";
import type { M2Actor } from "../../ports.ts";
import type { ContentUseCaseServices } from "./common.ts";
import { createTextPost } from "./text-post.ts";

export type CreatePostInput = Readonly<{
  readonly communityId: string;
  readonly actor: M2Actor;
  readonly body: unknown;
}>;

/** CreatePost publishes through the target-owned text submission runtime. */
export const createPost = Effect.fn("createPost")(function* (
  input: CreatePostInput,
  services: ContentUseCaseServices,
) {
  return yield* createTextPost(input, {
    ...(services.textPostStore === undefined ? {} : { textPostStore: services.textPostStore }),
    ...(services.textModerationProvider === undefined
      ? {}
      : { textModerationProvider: services.textModerationProvider }),
    ...(services.personaStore === undefined ? {} : { personaStore: services.personaStore }),
  });
});
