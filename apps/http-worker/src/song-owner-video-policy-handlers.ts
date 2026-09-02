import {
  getPublicSongOwnerPolicy,
  getSongOwnerPolicy,
  type SongOwnerPolicyStoreService,
  updateSongOwnerPolicy,
} from "@pirate/application/use-cases/song-owner-video-policy";
import { AuthError } from "@pirate/contracts";
import { Effect } from "effect";
import type { DecodedRequest, EndpointHandler, Principal } from "./transport.ts";

export type SongOwnerVideoPolicyHandlers = Readonly<{
  readonly GetSongOwnerPolicy: EndpointHandler;
  readonly UpdateSongOwnerPolicy: EndpointHandler;
  readonly GetPublicSongOwnerPolicy: EndpointHandler;
}>;

const ownerAccount = (principal: Principal | null): string => {
  if (principal === null || principal.kind !== "user") {
    throw new AuthError({ message: "Authentication required" });
  }
  return principal.subject;
};

const optionalViewerAccount = (principal: Principal | null): string | null => {
  if (principal === null) return null;
  if (principal.kind !== "user" && principal.kind !== "admin") {
    throw new AuthError({ message: "Authorization failed" });
  }
  return principal.subject;
};

const pathOf = (request: DecodedRequest): { communityId: string; postId: string } => {
  const path = request.params as { readonly communityId: string; readonly postId: string };
  return { communityId: path.communityId, postId: path.postId };
};

export function makeSongOwnerVideoPolicyHandlers(services: {
  readonly store: SongOwnerPolicyStoreService;
}): SongOwnerVideoPolicyHandlers {
  return {
    GetSongOwnerPolicy: (request) => {
      const path = pathOf(request);
      const query = request.query as { readonly persona_id: string };
      return Effect.runPromise(
        getSongOwnerPolicy(
          {
            ...path,
            accountId: ownerAccount(request.principal),
            personaId: query.persona_id,
          },
          services,
        ),
      );
    },
    UpdateSongOwnerPolicy: (request) => {
      const path = pathOf(request);
      return Effect.runPromise(
        updateSongOwnerPolicy(
          {
            ...path,
            accountId: ownerAccount(request.principal),
            update: request.body as Parameters<SongOwnerPolicyStoreService["update"]>[0]["update"],
          },
          services,
        ),
      );
    },
    GetPublicSongOwnerPolicy: (request) => {
      const path = pathOf(request);
      const query = (request.query ?? {}) as { readonly persona_id?: string };
      return Effect.runPromise(
        getPublicSongOwnerPolicy(
          {
            ...path,
            accountId: optionalViewerAccount(request.principal),
            personaId: query.persona_id ?? null,
          },
          services,
        ),
      );
    },
  };
}
