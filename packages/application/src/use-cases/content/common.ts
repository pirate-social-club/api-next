import {
  type ApiError,
  BadRequest,
  CommentsLocked,
  InternalError,
  MembershipRequired,
  NotFound,
  PostVoteIdempotencyConflict,
} from "@pirate/contracts";
import { Effect, Schema } from "effect";
import {
  ContentRepositoryError,
  type ContentRepositoryFailure,
  type ContentStore,
  type CreatePostBody,
  type M2Actor,
  type TextModeration,
  type TextPostStore,
} from "../../ports.ts";
import type { PersonaStoreService } from "../personas.ts";

export interface ContentUseCaseServices {
  readonly contentStore: ContentStore["Service"];
  /** The target-owned text runtime; no legacy content fallback is allowed. */
  readonly textPostStore?: TextPostStore["Service"];
  readonly textModeration?: TextModeration["Service"];
  readonly personaStore?: Pick<PersonaStoreService, "findOwned">;
}

/** Decode at the application boundary so unsupported request shapes fail closed. */
export const decodeBody = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
): Effect.Effect<S["Type"], BadRequest> =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input),
    catch: () => new BadRequest({ message: "Invalid request body" }),
  });

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

/** RFC 8785 JCS for decoded request JSON. */
const canonicalJson = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "string") {
    if (hasLoneSurrogate(value)) throw new Error("lone surrogate");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source)
      .sort()
      .map((key) => {
        const child = source[key];
        if (child === undefined) throw new Error("undefined is not JSON");
        return `${JSON.stringify(key)}:${canonicalJson(child)}`;
      })
      .join(",")}}`;
  }
  throw new Error("unsupported JSON value");
};

/** SHA-256 of the RFC 8785-canonical, already-decoded request body. */
export const canonicalBodyHash = (value: unknown): Effect.Effect<string, InternalError> =>
  Effect.tryPromise({
    try: async () => {
      const encoded = new TextEncoder().encode(canonicalJson(value));
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
      return (failure.operation === "cast-vote" || failure.operation === "clear-vote") &&
        failure.actionId !== undefined &&
        failure.actionId.length > 0 &&
        failure.actionId.trim() === failure.actionId
        ? new PostVoteIdempotencyConflict({
            message: "Idempotency key was already used with a different body",
            details: {
              reason_code: "idempotency_conflict",
              action_id: failure.actionId,
            },
          })
        : new InternalError({ message: "Content replay conflict has no action identity" });
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
  (body.identity_mode === undefined || body.identity_mode === "public");

export const validateIdentifier = (
  value: string,
  message = "Invalid identifier",
): Effect.Effect<void, BadRequest> =>
  value.length > 0 && value.trim() === value && !value.includes("\u0000")
    ? Effect.void
    : Effect.fail(new BadRequest({ message }));
