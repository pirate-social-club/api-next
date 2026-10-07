import type { ContentRatingV1 } from "@pirate/contracts";
import type { Effect } from "effect";

import type {
  TextPostCommitOutcome,
  TextPostRepositoryFailure,
  TextPostStoreService,
} from "./ports.ts";

export type TextPublicationInput = Omit<
  Parameters<TextPostStoreService["commitTerminal"]>[0],
  "evaluation" | "restrictedEvidence"
> & { readonly authorDeclaredRating: ContentRatingV1 };

export type TextPublicationOutcome = Exclude<
  TextPostCommitOutcome,
  { readonly kind: "policy-stale" }
>;

/** New text publication has no provider or moderation-policy prerequisite. */
export interface TextPublicationStoreService
  extends Pick<
    TextPostStoreService,
    "checkAuthority" | "replay" | "getForAuthor" | "resolveCommentTarget"
  > {
  readonly commitPublished: (
    input: TextPublicationInput,
  ) => Effect.Effect<TextPublicationOutcome, TextPostRepositoryFailure>;
}
