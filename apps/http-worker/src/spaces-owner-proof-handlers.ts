import {
  AuthError,
  BadRequest,
  Conflict,
  InternalError,
  NotFound,
  ProviderUnavailable,
  SpacesOwnerProofRefused,
  VerificationRequired,
} from "@pirate/contracts";
import type { SpacesOwnerProofStore } from "@pirate/platform-cf/spaces-owner-proof-repository";
import type { EndpointHandler, Principal } from "./transport.ts";
import { withEndpointResult } from "./transport.ts";

const accountId = (principal: Principal | null): string => {
  if (principal?.kind !== "user" && principal?.kind !== "admin") {
    throw new AuthError({ message: "Authentication required" });
  }
  return principal.subject;
};

const wireError = (error: unknown): never => {
  if (error instanceof SpacesOwnerProofRefused) {
    switch (error.reason) {
      case "invalid":
        throw new BadRequest({ message: "Invalid Spaces owner proof" });
      case "forbidden":
        throw new VerificationRequired({ message: "Spaces owner authority required" });
      case "conflict":
        throw new Conflict({ message: "Spaces owner proof conflict" });
      case "not_found":
        throw new NotFound({ message: "Spaces owner proof not found" });
      case "pending":
      case "unavailable":
        throw new ProviderUnavailable({ message: "Spaces verification unavailable" });
    }
  }
  throw new InternalError({ message: "Spaces owner proof failed", cause: error });
};

export function makeSpacesOwnerProofHandlers(
  store: SpacesOwnerProofStore,
): Readonly<Record<string, EndpointHandler>> {
  return {
    StartSpacesOwnership: async (request) => {
      const body = request.body as { idempotency_key: string; canonical_root: string };
      const path = request.params as { communityId: string };
      try {
        const result = await store.start({
          accountId: accountId(request.principal),
          communityId: path.communityId,
          canonicalRoot: body.canonical_root,
          idempotencyKey: body.idempotency_key,
        });
        const status = result as { status?: string; replayed?: boolean };
        return withEndpointResult(
          result,
          status.status === "verification_pending" ? 202 : status.replayed ? 200 : 201,
        );
      } catch (error) {
        return wireError(error);
      }
    },
    PollSpacesOwnership: async (request) => {
      const body = request.body as {
        ceremony_id: string;
        idempotency_key: string;
        signature_hex: string;
      };
      const path = request.params as { communityId: string };
      try {
        const result = await store.poll({
          accountId: accountId(request.principal),
          communityId: path.communityId,
          ceremonyId: body.ceremony_id,
          idempotencyKey: body.idempotency_key,
          signatureHex: body.signature_hex,
        });
        return withEndpointResult(
          result,
          (result as { status?: string }).status === "verification_pending" ? 202 : 200,
        );
      } catch (error) {
        return wireError(error);
      }
    },
  };
}
