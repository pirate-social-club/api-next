import {
  AuthError,
  BadRequest,
  Conflict,
  InternalError,
  NotFound,
  ProviderUnavailable,
  VerificationRequired,
} from "@pirate/contracts";
import {
  SpacesOperatorAssignmentRefused,
  type SpacesOperatorAssignmentStore,
} from "@pirate/platform-cf/spaces-operator-assignment-repository";
import type { EndpointHandler, Principal } from "./transport.ts";
import { withEndpointResult } from "./transport.ts";

const account = (principal: Principal | null): string => {
  if (principal?.kind !== "user" && principal?.kind !== "admin") {
    throw new AuthError({ message: "Authentication required" });
  }
  return principal.subject;
};

const refused = (error: unknown): never => {
  if (error instanceof SpacesOperatorAssignmentRefused) {
    switch (error.reason) {
      case "invalid":
        throw new BadRequest({ message: "Invalid Spaces operator assignment" });
      case "unauthorized":
        throw new AuthError({ message: "Authentication required" });
      case "forbidden":
        throw new VerificationRequired({ message: "Spaces owner authority required" });
      case "conflict":
        throw new Conflict({ message: "Spaces operator assignment conflict" });
      case "not_found":
        throw new NotFound({ message: "Spaces operator assignment not found" });
      case "unavailable":
        throw new ProviderUnavailable({ message: "Spaces verification unavailable" });
    }
  }
  throw new InternalError({ message: "Spaces operator assignment failed", cause: error });
};

export function makeSpacesOperatorAssignmentHandlers(
  store: SpacesOperatorAssignmentStore,
): Readonly<Record<string, EndpointHandler>> {
  return {
    GetSpacesOperatorAssignments: async (request) => {
      const path = request.params as { communityId: string };
      const query = request.query as { root: string };
      try {
        return await store.list({
          accountId: account(request.principal),
          communityId: path.communityId,
          canonicalRoot: query.root,
        });
      } catch (error) {
        return refused(error);
      }
    },
    ConfirmSpacesOperatorAssignment: async (request) => {
      const path = request.params as { communityId: string };
      const body = request.body as {
        idempotency_key: string;
        operator_assignment_id: string;
        expected_generation: number;
        namespace_authority_reference: string;
        expected_authority_generation: number;
      };
      try {
        const result = await store.confirm({
          accountId: account(request.principal),
          communityId: path.communityId,
          idempotencyKey: body.idempotency_key,
          assignmentId: body.operator_assignment_id,
          expectedGeneration: body.expected_generation,
          authorityReference: body.namespace_authority_reference,
          expectedAuthorityGeneration: body.expected_authority_generation,
        });
        return withEndpointResult(result, result.replayed ? 200 : 201);
      } catch (error) {
        return refused(error);
      }
    },
  };
}
