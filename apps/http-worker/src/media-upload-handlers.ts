import { AuthError } from "@pirate/contracts";
import type { EndpointHandler, Principal } from "./transport.ts";
import { withEndpointResult } from "./transport.ts";

type MediaHandlerActor = Readonly<{
  readonly kind: "user" | "admin";
  readonly userId: string;
  readonly scopes?: readonly string[];
}>;

type MediaHandlerCommand = Readonly<{
  readonly submissionId: string;
  readonly actor: MediaHandlerActor;
  readonly body: unknown;
}>;

export type MediaUploadHandlerServices = Readonly<{
  readonly reserve: (
    input: Readonly<{ communityId: string; actor: MediaHandlerActor; body: unknown }>,
  ) => unknown | Promise<unknown>;
  readonly create: (
    input: Readonly<{ communityId: string; actor: MediaHandlerActor; body: unknown }>,
  ) => unknown | Promise<unknown>;
  readonly bindTerms: (input: MediaHandlerCommand) => unknown | Promise<unknown>;
  readonly bindLyrics: (input: MediaHandlerCommand) => unknown | Promise<unknown>;
  readonly finalize: (input: MediaHandlerCommand) => unknown | Promise<unknown>;
  readonly get: (
    input: Readonly<{ submissionId: string; actor: MediaHandlerActor }>,
  ) => unknown | Promise<unknown>;
  readonly bindReference: (input: MediaHandlerCommand) => unknown | Promise<unknown>;
  readonly retry: (input: MediaHandlerCommand) => unknown | Promise<unknown>;
  readonly cancel: (input: MediaHandlerCommand) => unknown | Promise<unknown>;
  readonly moderate: (input: MediaHandlerCommand) => unknown | Promise<unknown>;
}>;

export type MediaUploadHandlers = Readonly<{
  readonly CreateMediaUploadReservation: EndpointHandler;
  readonly CreateMediaPostSubmission: EndpointHandler;
  readonly BindMediaPostSubmissionTerms: EndpointHandler;
  readonly BindMediaPostSubmissionLyrics: EndpointHandler;
  readonly FinalizeMediaPostSubmission: EndpointHandler;
  readonly GetMediaPostSubmission: EndpointHandler;
  readonly BindMediaPostSubmissionReference: EndpointHandler;
  readonly RetryMediaPostSubmission: EndpointHandler;
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

export function makeMediaUploadHandlers(services: MediaUploadHandlerServices): MediaUploadHandlers {
  return {
    CreateMediaUploadReservation: async (request) => {
      const path = request.params as { readonly communityId: string };
      return withEndpointResult(
        await services.reserve({
          communityId: path.communityId,
          actor: actor(request.principal),
          body: request.body,
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
      });
    },
    BindMediaPostSubmissionLyrics: (request) => {
      const path = request.params as { readonly submissionId: string };
      return services.bindLyrics({
        submissionId: path.submissionId,
        actor: actor(request.principal),
        body: request.body,
      });
    },
    FinalizeMediaPostSubmission: (request) => {
      const path = request.params as { readonly submissionId: string };
      return services.finalize({
        submissionId: path.submissionId,
        actor: actor(request.principal),
        body: request.body,
      });
    },
    GetMediaPostSubmission: (request) => {
      const path = request.params as { readonly submissionId: string };
      return services.get({ submissionId: path.submissionId, actor: actor(request.principal) });
    },
    BindMediaPostSubmissionReference: (request) => {
      const path = request.params as { readonly submissionId: string };
      return services.bindReference({
        submissionId: path.submissionId,
        actor: actor(request.principal),
        body: request.body,
      });
    },
    RetryMediaPostSubmission: (request) => {
      const path = request.params as { readonly submissionId: string };
      return services.retry({
        submissionId: path.submissionId,
        actor: actor(request.principal),
        body: request.body,
      });
    },
    CancelMediaPostSubmission: (request) => {
      const path = request.params as { readonly submissionId: string };
      return services.cancel({
        submissionId: path.submissionId,
        actor: actor(request.principal),
        body: request.body,
      });
    },
    ModerateMediaPostSubmission: (request) => {
      const path = request.params as { readonly submissionId: string };
      return services.moderate({
        submissionId: path.submissionId,
        actor: actor(request.principal),
        body: request.body,
      });
    },
  };
}
