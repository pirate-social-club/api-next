import {
  AuthError,
  BadRequest,
  Conflict,
  InternalError,
  NotFound,
  ProviderUnavailable,
  SpacesRouteAttachmentRefused,
  VerificationRequired,
} from "@pirate/contracts";
import type { SpacesRouteAttachmentStore } from "@pirate/platform-cf/spaces-community-route-attachment-repository";
import type { EndpointHandler, Principal } from "./transport.ts";
import { withEndpointResult } from "./transport.ts";

const accountId = (principal: Principal | null): string => {
  if (principal?.kind !== "user" && principal?.kind !== "admin") {
    throw new AuthError({ message: "Authentication required" });
  }
  return principal.subject;
};

const wireError = (error: unknown): never => {
  if (error instanceof SpacesRouteAttachmentRefused) {
    switch (error.reason) {
      case "invalid":
        throw new BadRequest({ message: "Invalid Spaces route attachment" });
      case "forbidden":
        throw new VerificationRequired({ message: "Community route authority required" });
      case "conflict":
        throw new Conflict({ message: "Spaces route attachment conflict" });
      case "not_found":
        throw new NotFound({ message: "Spaces route attachment not found" });
      case "unavailable":
        throw new ProviderUnavailable({ message: "Spaces verification unavailable" });
    }
  }
  throw new InternalError({ message: "Spaces route attachment failed", cause: error });
};

type Status = { status?: string; replayed?: boolean };
const pending = (result: unknown) => (result as Status).status === "verification_pending";

export function makeSpacesRouteAttachmentHandlers(
  store: SpacesRouteAttachmentStore,
): Readonly<Record<string, EndpointHandler>> {
  return {
    StartSpacesRouteAttachment: async (request) => {
      const body = request.body as { idempotency_key: string; canonical_root: string };
      const path = request.params as { communityId: string };
      try {
        const result = await store.start({
          accountId: accountId(request.principal),
          communityId: path.communityId,
          canonicalRoot: body.canonical_root,
          idempotencyKey: body.idempotency_key,
        });
        return withEndpointResult(
          result,
          pending(result) ? 202 : (result as Status).replayed ? 200 : 201,
        );
      } catch (error) {
        return wireError(error);
      }
    },
    GetCurrentSpacesRouteAttachment: async (request) => {
      const path = request.params as { communityId: string };
      try {
        return await store.current({
          accountId: accountId(request.principal),
          communityId: path.communityId,
        });
      } catch (error) {
        return wireError(error);
      }
    },
    ProveSpacesRouteAttachment: async (request) => {
      const body = request.body as { signature_hex: string };
      const path = request.params as { communityId: string; attachmentIntentId: string };
      try {
        const result = await store.prove({
          accountId: accountId(request.principal),
          communityId: path.communityId,
          attachmentIntentId: path.attachmentIntentId,
          signatureHex: body.signature_hex,
        });
        return withEndpointResult(result, pending(result) ? 202 : 200);
      } catch (error) {
        return wireError(error);
      }
    },
    CommitSpacesRouteAttachment: async (request) => {
      const body = request.body as { generation: number };
      const path = request.params as { communityId: string; attachmentIntentId: string };
      try {
        return await store.commit({
          accountId: accountId(request.principal),
          communityId: path.communityId,
          attachmentIntentId: path.attachmentIntentId,
          generation: body.generation,
        });
      } catch (error) {
        return wireError(error);
      }
    },
  };
}
