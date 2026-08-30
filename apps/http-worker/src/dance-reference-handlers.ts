import {
  type DanceReferenceServices,
  makeDanceReferenceService,
} from "@pirate/application/use-cases/dance/reference-services";
import { AuthError } from "@pirate/contracts";
import { Effect } from "effect";
import type { EndpointHandler, Principal } from "./transport.ts";
import { withEndpointResult } from "./transport.ts";

export type DanceReferenceHandlers = Readonly<{
  readonly CreateDanceChoreography: EndpointHandler;
  readonly GetDanceChoreographyProcessing: EndpointHandler;
  readonly AppendDanceChoreographyRevision: EndpointHandler;
  readonly DisableDanceChoreography: EndpointHandler;
  readonly RetireDanceChoreography: EndpointHandler;
  readonly ListReadyDanceChoreographies: EndpointHandler;
  readonly GetDanceChoreographyRevision: EndpointHandler;
  readonly SetSongDancePresentation: EndpointHandler;
  readonly ClearSongDancePresentation: EndpointHandler;
}>;

function actorAccountId(principal: Principal | null): string {
  if (principal === null || (principal.kind !== "user" && principal.kind !== "admin")) {
    throw new AuthError({ message: "Authentication required" });
  }
  return principal.subject;
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

/**
 * Installs the reference-resource API only. The service boundary contains no
 * processor dependency; authoring commits durable outbox authority and returns.
 */
export function makeDanceReferenceHandlers(
  services: DanceReferenceServices,
): DanceReferenceHandlers {
  const dance = makeDanceReferenceService(services);
  return {
    CreateDanceChoreography: async (request) => {
      const path = request.params as { readonly communityId: string; readonly postId: string };
      const result = await run(
        dance.create({
          actorAccountId: actorAccountId(request.principal),
          communityId: path.communityId,
          songPostId: path.postId,
          body: request.body,
        }),
      );
      return withEndpointResult(result, result.replayed ? 200 : 202);
    },
    GetDanceChoreographyProcessing: (request) => {
      const path = request.params as {
        readonly communityId: string;
        readonly choreographyId: string;
      };
      return run(
        dance.getProcessing({
          actorAccountId: actorAccountId(request.principal),
          communityId: path.communityId,
          choreographyId: path.choreographyId,
        }),
      );
    },
    AppendDanceChoreographyRevision: async (request) => {
      const path = request.params as {
        readonly communityId: string;
        readonly choreographyId: string;
      };
      const result = await run(
        dance.append({
          actorAccountId: actorAccountId(request.principal),
          communityId: path.communityId,
          choreographyId: path.choreographyId,
          body: request.body,
        }),
      );
      return withEndpointResult(result, result.replayed ? 200 : 202);
    },
    DisableDanceChoreography: (request) => {
      const path = request.params as {
        readonly communityId: string;
        readonly choreographyId: string;
      };
      return run(
        dance.disable({
          actorAccountId: actorAccountId(request.principal),
          communityId: path.communityId,
          choreographyId: path.choreographyId,
          body: request.body,
        }),
      );
    },
    RetireDanceChoreography: (request) => {
      const path = request.params as {
        readonly communityId: string;
        readonly choreographyId: string;
      };
      return run(
        dance.retire({
          actorAccountId: actorAccountId(request.principal),
          communityId: path.communityId,
          choreographyId: path.choreographyId,
          body: request.body,
        }),
      );
    },
    ListReadyDanceChoreographies: (request) => {
      const path = request.params as { readonly communityId: string; readonly postId: string };
      const query = request.query as {
        readonly audio_revision: string;
        readonly cursor?: string;
        readonly limit?: string;
      };
      return run(
        dance.listReady({
          communityId: path.communityId,
          songPostId: path.postId,
          audioRevision: query.audio_revision,
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
        }),
      );
    },
    GetDanceChoreographyRevision: (request) => {
      const path = request.params as {
        readonly communityId: string;
        readonly choreographyId: string;
        readonly revision: string;
      };
      return run(
        dance.getRevision({
          communityId: path.communityId,
          choreographyId: path.choreographyId,
          revision: path.revision,
        }),
      );
    },
    SetSongDancePresentation: (request) => {
      const path = request.params as { readonly communityId: string; readonly postId: string };
      return run(
        dance.setPresentation({
          actorAccountId: actorAccountId(request.principal),
          communityId: path.communityId,
          songPostId: path.postId,
          body: request.body,
        }),
      );
    },
    ClearSongDancePresentation: (request) => {
      const path = request.params as { readonly communityId: string; readonly postId: string };
      return run(
        dance.clearPresentation({
          actorAccountId: actorAccountId(request.principal),
          communityId: path.communityId,
          songPostId: path.postId,
          body: request.body,
        }),
      );
    },
  };
}
