import { AuthError } from "@pirate/contracts";
import type { DecodedRequest, EndpointHandler, Principal } from "./transport.ts";
import { withEndpointResult } from "./transport.ts";

type MediaHandlerActor = Readonly<{
  readonly kind: "user" | "admin";
  readonly userId: string;
  readonly scopes?: readonly string[];
}>;

type MediaRequestLifetime = Readonly<{ readonly signal?: AbortSignal }>;

type MediaHandlerCommand = Readonly<{
  readonly submissionId: string;
  readonly actor: MediaHandlerActor;
  readonly body: unknown;
}> &
  MediaRequestLifetime;

type MediaReservationCommand = Readonly<{
  readonly reservationId: string;
  readonly actor: MediaHandlerActor;
  readonly body: unknown;
}> &
  MediaRequestLifetime;

type MediaCommunityCommand = Readonly<{
  readonly communityId: string;
  readonly actor: MediaHandlerActor;
  readonly body: unknown;
}> &
  MediaRequestLifetime;

export type MediaUploadHandlerServices = Readonly<{
  readonly listActive: (
    input: Readonly<{
      communityId: string;
      actor: MediaHandlerActor;
      query: Readonly<{ cursor?: string; limit?: string }>;
    }> &
      MediaRequestLifetime,
  ) => unknown | Promise<unknown>;
  readonly preflightSongVideo: (input: MediaCommunityCommand) => unknown | Promise<unknown>;
  readonly reserve: (input: MediaCommunityCommand) => unknown | Promise<unknown>;
  readonly create: (input: MediaCommunityCommand) => unknown | Promise<unknown>;
  readonly bindTerms: (input: MediaHandlerCommand) => unknown | Promise<unknown>;
  readonly bindLyrics: (input: MediaHandlerCommand) => unknown | Promise<unknown>;
  readonly finalize: (input: MediaHandlerCommand) => unknown | Promise<unknown>;
  readonly renewParts: (input: MediaReservationCommand) => unknown | Promise<unknown>;
  readonly get: (
    input: Readonly<{ submissionId: string; actor: MediaHandlerActor }> & MediaRequestLifetime,
  ) => unknown | Promise<unknown>;
  readonly bindReference: (input: MediaHandlerCommand) => unknown | Promise<unknown>;
  readonly attachStem: (input: MediaHandlerCommand) => unknown | Promise<unknown>;
  readonly retry: (input: MediaHandlerCommand) => unknown | Promise<unknown>;
  readonly retryPoster: (input: MediaHandlerCommand) => unknown | Promise<unknown>;
  readonly cancel: (input: MediaHandlerCommand) => unknown | Promise<unknown>;
  readonly moderate: (input: MediaHandlerCommand) => unknown | Promise<unknown>;
}>;

export type MediaUploadHandlers = Readonly<{
  readonly ListActiveSongMediaPostSubmissions: EndpointHandler;
  readonly PreflightSongVideoInterval: EndpointHandler;
  readonly CreateMediaUploadReservation: EndpointHandler;
  readonly CreateMediaPostSubmission: EndpointHandler;
  readonly BindMediaPostSubmissionTerms: EndpointHandler;
  readonly BindMediaPostSubmissionLyrics: EndpointHandler;
  readonly FinalizeMediaPostSubmission: EndpointHandler;
  readonly RenewVideoUploadParts: EndpointHandler;
  readonly GetMediaPostSubmission: EndpointHandler;
  readonly BindMediaPostSubmissionReference: EndpointHandler;
  readonly AttachMediaPostSubmissionStem: EndpointHandler;
  readonly RetryMediaPostSubmission: EndpointHandler;
  readonly RetryVideoPostSubmissionPoster: EndpointHandler;
  readonly CancelMediaPostSubmission: EndpointHandler;
  readonly ModerateMediaPostSubmission: EndpointHandler;
}>;

function actor(principal: Principal | null): MediaHandlerActor {
  if (principal === null || (principal.kind !== "user" && principal.kind !== "admin")) {
    throw new AuthError({ message: "Authentication required" });
  }
  return {
    kind: principal.kind,
    userId: principal.subject,
    ...(principal.scopes === undefined ? {} : { scopes: principal.scopes }),
  };
}

const requestLifetime = (request: DecodedRequest): MediaRequestLifetime =>
  request.signal === undefined ? {} : { signal: request.signal };

export function makeMediaUploadHandlers(services: MediaUploadHandlerServices): MediaUploadHandlers {
  return {
    ListActiveSongMediaPostSubmissions: (request) => {
      const path = request.params as { readonly communityId: string };
      return services.listActive({
        communityId: path.communityId,
        actor: actor(request.principal),
        query: request.query as Readonly<{ cursor?: string; limit?: string }>,
        ...requestLifetime(request),
      });
    },
    PreflightSongVideoInterval: (request) => {
      const path = request.params as { readonly communityId: string };
      return services.preflightSongVideo({
        communityId: path.communityId,
        actor: actor(request.principal),
        body: request.body,
        ...requestLifetime(request),
      });
    },
    CreateMediaUploadReservation: async (request) => {
      const path = request.params as { readonly communityId: string };
      return withEndpointResult(
        await services.reserve({
          communityId: path.communityId,
          actor: actor(request.principal),
          body: request.body,
          ...requestLifetime(request),
        }),
        201,
      );
    },
    CreateMediaPostSubmission: async (request) => {
      const path = request.params as { readonly communityId: string };
      return withEndpointResult(
        await services.create({
          communityId: path.communityId,
          actor: actor(request.principal),
          body: request.body,
          ...requestLifetime(request),
        }),
        201,
      );
    },
    BindMediaPostSubmissionTerms: (request) => {
      const path = request.params as { readonly submissionId: string };
      return services.bindTerms({
        submissionId: path.submissionId,
        actor: actor(request.principal),
        body: request.body,
        ...requestLifetime(request),
      });
    },
    BindMediaPostSubmissionLyrics: (request) => {
      const path = request.params as { readonly submissionId: string };
      return services.bindLyrics({
        submissionId: path.submissionId,
        actor: actor(request.principal),
        body: request.body,
        ...requestLifetime(request),
      });
    },
    FinalizeMediaPostSubmission: (request) => {
      const path = request.params as { readonly submissionId: string };
      return services.finalize({
        submissionId: path.submissionId,
        actor: actor(request.principal),
        body: request.body,
        ...requestLifetime(request),
      });
    },
    RenewVideoUploadParts: (request) => {
      const path = request.params as { readonly reservationId: string };
      return services.renewParts({
        reservationId: path.reservationId,
        actor: actor(request.principal),
        body: request.body,
        ...requestLifetime(request),
      });
    },
    GetMediaPostSubmission: (request) => {
      const path = request.params as { readonly submissionId: string };
      return services.get({
        submissionId: path.submissionId,
        actor: actor(request.principal),
        ...requestLifetime(request),
      });
    },
    BindMediaPostSubmissionReference: (request) => {
      const path = request.params as { readonly submissionId: string };
      return services.bindReference({
        submissionId: path.submissionId,
        actor: actor(request.principal),
        body: request.body,
        ...requestLifetime(request),
      });
    },
    AttachMediaPostSubmissionStem: (request) => {
      const path = request.params as { readonly submissionId: string };
      return services.attachStem({
        submissionId: path.submissionId,
        actor: actor(request.principal),
        body: request.body,
        ...requestLifetime(request),
      });
    },
    RetryMediaPostSubmission: (request) => {
      const path = request.params as { readonly submissionId: string };
      return services.retry({
        submissionId: path.submissionId,
        actor: actor(request.principal),
        body: request.body,
        ...requestLifetime(request),
      });
    },
    RetryVideoPostSubmissionPoster: (request) => {
      const path = request.params as { readonly submissionId: string };
      return services.retryPoster({
        submissionId: path.submissionId,
        actor: actor(request.principal),
        body: request.body,
        ...requestLifetime(request),
      });
    },
    CancelMediaPostSubmission: (request) => {
      const path = request.params as { readonly submissionId: string };
      return services.cancel({
        submissionId: path.submissionId,
        actor: actor(request.principal),
        body: request.body,
        ...requestLifetime(request),
      });
    },
    ModerateMediaPostSubmission: (request) => {
      const path = request.params as { readonly submissionId: string };
      return services.moderate({
        submissionId: path.submissionId,
        actor: actor(request.principal),
        body: request.body,
        ...requestLifetime(request),
      });
    },
  };
}
