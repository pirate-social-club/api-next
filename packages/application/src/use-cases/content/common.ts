import {
  type ApiError,
  BadRequest,
  CommentsLocked,
  Conflict,
  InternalError,
  MembershipRequired,
  NotFound,
} from "@pirate/contracts";
import { Effect, Schema } from "effect";
import {
  ContentRepositoryError,
  type ContentRepositoryFailure,
  type ContentStore,
  type CreateCommentBody,
  type CreatePostBody,
  type M2Actor,
} from "../../ports.ts";

export interface ContentUseCaseServices {
  readonly contentStore: ContentStore["Service"];
}

/** Decode at the application boundary so unsupported request shapes fail closed. */
export const decodeBody = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
): Effect.Effect<S["Type"], BadRequest> =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(input),
    catch: () => new BadRequest({ message: "Invalid request body" }),
  });

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, canonicalValue(source[key])]),
    );
  }
  return value;
};

/** SHA-256 of the recursively key-sorted, already-decoded request body. */
export const canonicalBodyHash = (value: unknown): Effect.Effect<string, InternalError> =>
  Effect.tryPromise({
    try: async () => {
      const encoded = new TextEncoder().encode(JSON.stringify(canonicalValue(value)));
      const digest = await crypto.subtle.digest("SHA-256", encoded);
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    },
    catch: () => new InternalError({ message: "Unable to fingerprint request" }),
  });

export const mapContentFailure = (failure: ContentRepositoryFailure): ApiError => {
  if (!(failure instanceof ContentRepositoryError)) {
    return new InternalError({ message: "Content operation failed" });
  }
  switch (failure.reason) {
    case "not-found":
      return new NotFound({ message: "Content not found" });
    case "idempotency-conflict":
      return new Conflict({ message: "Idempotency key was already used with a different body" });
    case "membership-required":
      return new MembershipRequired({ message: "Community membership is required" });
    case "comments-locked":
      return new CommentsLocked({ message: "Comments are locked for this post" });
    case "constraint":
      return new BadRequest({ message: "Content request violates a resource constraint" });
    case "invalid-row":
      return new InternalError({ message: "Content operation returned an invalid record" });
  }
};

/** M2 content writes are human-direct; delegated agents are deferred. */
export const validateHumanDirectActor = (actor: M2Actor): Effect.Effect<void, BadRequest> =>
  actor.kind === "agent" || actor.userId.length === 0 || actor.userId.trim() !== actor.userId
    ? Effect.fail(new BadRequest({ message: "Only human-direct actors are supported" }))
    : Effect.void;

export const validPublicHumanDirectPost = (body: CreatePostBody): boolean =>
  body.post_type === "text" &&
  (body.authorship_mode === undefined || body.authorship_mode === "human_direct") &&
  (body.identity_mode === undefined || body.identity_mode === "public") &&
  body.agent_id == null &&
  body.agent_action_proof == null &&
  body.anonymous_scope == null &&
  (body.media_refs === undefined || body.media_refs.length === 0) &&
  body.caption == null &&
  body.link_url == null &&
  body.asset_id == null &&
  body.file_upload == null &&
  body.song_artifact_bundle == null &&
  body.song_mode == null &&
  body.source_post == null &&
  body.source_community == null &&
  body.crosspost_source == null &&
  body.lyrics == null;

export const validPublicHumanDirectComment = (body: CreateCommentBody): boolean =>
  (body.authorship_mode === undefined || body.authorship_mode === "human_direct") &&
  (body.identity_mode === undefined || body.identity_mode === "public") &&
  body.agent_id == null &&
  body.agent_action_proof == null &&
  body.anonymous_scope == null &&
  (body.media_refs === undefined || body.media_refs.length === 0);

export const validateIdentifier = (
  value: string,
  message = "Invalid identifier",
): Effect.Effect<void, BadRequest> =>
  value.length > 0 && value.trim() === value && !value.includes("\u0000")
    ? Effect.void
    : Effect.fail(new BadRequest({ message }));
