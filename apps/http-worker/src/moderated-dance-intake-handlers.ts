import { AuthError, BadRequest, Conflict, InternalError, NotFound } from "@pirate/contracts";
import { Effect, Schema } from "effect";
import type { DanceReviewServiceFailure } from "../../../packages/application/src/use-cases/dance/moderator-review-services.ts";
import { moderatedDanceContextRegistry } from "../../../packages/contracts/src/dance-moderated-context.ts";
import {
  CreateModeratedDanceReference,
  GetModeratedDanceCaptureOptions,
  GetModeratedDanceReferenceStatus,
  moderatedDanceIntakeRegistry as registry,
} from "../../../packages/contracts/src/dance-moderated-intake.ts";
import type { makeControlPlaneModeratedDanceIntakeStore } from "../../../packages/platform-cf/src/dance-moderated-intake-repository.ts";
import type { EndpointHandler, Principal } from "./transport.ts";

const actor = (p: Principal | null) => {
  if (p === null || (p.kind !== "user" && p.kind !== "admin"))
    throw new AuthError({ message: "Authentication required" });
  return p.subject;
};
const mapped = (e: DanceReviewServiceFailure) =>
  e.reason === "not_found"
    ? new NotFound({ message: "Private Dance session unavailable" })
    : e.reason === "invalid_request"
      ? new BadRequest({ message: "Invalid private capture request" })
      : e.reason === "idempotency_conflict" || e.reason === "revision_conflict"
        ? new Conflict({
            message: "Capture changed; recover the original command or refresh status",
          })
        : new InternalError({
            message:
              e.reason === "outcome_unknown"
                ? "Outcome unknown; recover the same command key"
                : "Private Dance intake unavailable",
          });
const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown) => {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
  } catch {
    throw new BadRequest({ message: "Invalid private capture request" });
  }
};
export function makeModeratedDanceIntakeHandlers(
  forAccount: (account: string) => ReturnType<typeof makeControlPlaneModeratedDanceIntakeStore>,
): Readonly<Record<string, EndpointHandler>> {
  const handlers: Record<string, EndpointHandler> = {};
  for (const name of [
    "CreateModeratedDanceSession",
    "ConsentModeratedDanceSession",
    "ReserveModeratedDanceUpload",
    "FinalizeModeratedDanceUpload",
  ] as const) {
    const endpoint = registry[name];
    handlers[name] = (ctx) => {
      const account = actor(ctx.principal),
        body = decode(endpoint.request.body, ctx.body),
        path = decode(endpoint.request.path, ctx.params);
      if (
        path.communityId !== body.community_id ||
        ("session_id" in body && (!("sessionId" in path) || path.sessionId !== body.session_id))
      )
        throw new BadRequest({ message: "Capture path does not match command" });
      return Effect.runPromise(forAccount(account).command(body).pipe(Effect.mapError(mapped)), {
        signal: ctx.signal,
      });
    };
  }
  handlers.GetModeratedDanceSession = (ctx) => {
    const account = actor(ctx.principal),
      path = decode(registry.GetModeratedDanceSession.request.path, ctx.params);
    return Effect.runPromise(
      forAccount(account)
        .getSession(path.communityId, path.sessionId)
        .pipe(Effect.mapError(mapped)),
      { signal: ctx.signal },
    );
  };
  handlers.GetModeratedDanceCaptureContext = (ctx) => {
    const account = actor(ctx.principal),
      path = decode(
        moderatedDanceContextRegistry.GetModeratedDanceCaptureContext.request.path,
        ctx.params,
      );
    return Effect.runPromise(
      forAccount(account)
        .captureContext(path.communityId, path.sessionId)
        .pipe(Effect.mapError(mapped)),
      { signal: ctx.signal },
    );
  };
  handlers.GetModeratedDanceOwnerRubric = (ctx) => {
    const account = actor(ctx.principal),
      path = decode(
        moderatedDanceContextRegistry.GetModeratedDanceOwnerRubric.request.path,
        ctx.params,
      );
    return Effect.runPromise(
      forAccount(account)
        .ownerRubric(path.communityId, path.reviewId)
        .pipe(Effect.mapError(mapped)),
      { signal: ctx.signal },
    );
  };
  handlers.GetModeratedDanceUploadAccess = (ctx) => {
    const account = actor(ctx.principal),
      path = decode(registry.GetModeratedDanceUploadAccess.request.path, ctx.params),
      body = decode(registry.GetModeratedDanceUploadAccess.request.body, ctx.body);
    return Effect.runPromise(
      forAccount(account)
        .uploadAccess(path.communityId, path.sessionId, body.upload_id, body.terms_hash)
        .pipe(Effect.mapError(mapped)),
      { signal: ctx.signal },
    );
  };
  handlers.GetModeratedDanceCaptureOptions = (ctx) => {
    const account = actor(ctx.principal),
      path = decode(GetModeratedDanceCaptureOptions.request.path, ctx.params),
      query = decode(GetModeratedDanceCaptureOptions.request.query, ctx.query ?? {});
    return Effect.runPromise(
      forAccount(account)
        .captureOptions(path.communityId, path.postId, query.cursor ?? null)
        .pipe(Effect.mapError(mapped)),
      { signal: ctx.signal },
    );
  };
  handlers.CreateModeratedDanceReference = (ctx) => {
    const account = actor(ctx.principal),
      path = decode(CreateModeratedDanceReference.request.path, ctx.params),
      body = decode(CreateModeratedDanceReference.request.body, ctx.body);
    if (path.communityId !== body.community_id || path.postId !== body.song_post_id)
      throw new BadRequest({ message: "Reference path does not match command" });
    return Effect.runPromise(
      forAccount(account).createReference(body).pipe(Effect.mapError(mapped)),
      { signal: ctx.signal },
    );
  };
  handlers.GetModeratedDanceReferenceStatus = (ctx) => {
    const account = actor(ctx.principal),
      path = decode(GetModeratedDanceReferenceStatus.request.path, ctx.params);
    return Effect.runPromise(
      forAccount(account)
        .getReference(path.communityId, path.postId, path.choreographyId)
        .pipe(Effect.mapError(mapped)),
      { signal: ctx.signal },
    );
  };
  return handlers;
}
