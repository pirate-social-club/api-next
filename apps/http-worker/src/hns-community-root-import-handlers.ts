import {
  activateHnsCommunityRootImport,
  getHnsCommunityRootImport,
  type HnsCommunityRootImportActivationServices,
  type HnsCommunityRootImportPollServices,
  type HnsCommunityRootImportReadStore,
  type HnsCommunityRootImportStartServices,
  pollHnsCommunityRootImport,
  startHnsCommunityRootImport,
} from "@pirate/application/namespace-ownership";
import {
  AuthError,
  BadRequest,
  Conflict,
  InternalError,
  NotFound,
  ProviderUnavailable,
} from "@pirate/contracts";
import { Effect } from "effect";
import { type EndpointHandler, withEndpointResult } from "./transport.ts";

function wireFailure(error: unknown): Error {
  const tagged = error as { readonly _tag?: string; readonly reason?: string };
  if (tagged._tag === "HnsCommunityRootImportStorageFailed")
    return new InternalError({ message: "HNS community root import failed" });
  if (tagged._tag !== "HnsCommunityRootImportRejected")
    return new InternalError({ message: "HNS community root import failed" });
  if (tagged.reason === "not_found")
    return new NotFound({ message: "Community route authority was not found" });
  if (tagged.reason === "conflict")
    return new Conflict({ message: "HNS root import conflicts with durable state" });
  if (tagged.reason === "ownership_unavailable")
    return new ProviderUnavailable({ message: "HNS ownership provider is unavailable" });
  return new BadRequest({ message: "HNS community root import request is invalid" });
}

export function makeHnsCommunityRootImportHandlers(
  services: HnsCommunityRootImportStartServices &
    HnsCommunityRootImportPollServices &
    HnsCommunityRootImportActivationServices &
    Readonly<{
      readonly store: HnsCommunityRootImportStartServices["store"] &
        HnsCommunityRootImportReadStore;
    }>,
): Readonly<{
  StartHnsCommunityRootImport: EndpointHandler;
  GetHnsCommunityRootImport: EndpointHandler;
  PollHnsCommunityRootImport: EndpointHandler;
  ActivateHnsCommunityRootImport: EndpointHandler;
}> {
  return {
    StartHnsCommunityRootImport: (request) => {
      if (
        request.principal === null ||
        (request.principal.kind !== "user" && request.principal.kind !== "admin")
      ) {
        throw new AuthError({ message: "Authentication required" });
      }
      const params = request.params as Readonly<{ communityId: string }>;
      const body = request.body as Readonly<{ root_label: string; idempotency_key: string }>;
      return Effect.runPromise(
        startHnsCommunityRootImport(
          {
            actor_id: request.principal.subject,
            community_id: params.communityId,
            root_label: body.root_label,
            idempotency_key: body.idempotency_key,
          },
          services,
        ).pipe(
          Effect.map((result) => withEndpointResult(result, result.replayed ? 200 : 202)),
          Effect.mapError(wireFailure),
        ),
      );
    },
    GetHnsCommunityRootImport: (request) => {
      if (
        request.principal === null ||
        (request.principal.kind !== "user" && request.principal.kind !== "admin")
      ) {
        throw new AuthError({ message: "Authentication required" });
      }
      const params = request.params as Readonly<{ communityId: string; sessionId: string }>;
      return Effect.runPromise(
        getHnsCommunityRootImport(
          {
            actor_id: request.principal.subject,
            community_id: params.communityId,
            root_import_session_id: params.sessionId,
          },
          services,
        ).pipe(
          Effect.map((result) => withEndpointResult(result, 200)),
          Effect.mapError(wireFailure),
        ),
      );
    },
    PollHnsCommunityRootImport: (request) => {
      if (
        request.principal === null ||
        (request.principal.kind !== "user" && request.principal.kind !== "admin")
      ) {
        throw new AuthError({ message: "Authentication required" });
      }
      const params = request.params as Readonly<{ communityId: string; sessionId: string }>;
      const body = request.body as Readonly<{
        expected_revision: number;
        idempotency_key: string;
        provisioning_name_signature?: string;
      }>;
      return Effect.runPromise(
        pollHnsCommunityRootImport(
          {
            actor_id: request.principal.subject,
            community_id: params.communityId,
            root_import_session_id: params.sessionId,
            expected_revision: body.expected_revision,
            idempotency_key: body.idempotency_key,
            ...(body.provisioning_name_signature === undefined
              ? {}
              : { provisioning_name_signature: body.provisioning_name_signature }),
          },
          services,
        ).pipe(
          Effect.map((result) =>
            withEndpointResult(
              result,
              ["awaiting_ownership", "provisioning", "awaiting_owner_update", "observing"].includes(
                result.status,
              )
                ? 202
                : result.status === "failed" || result.status === "expired"
                  ? 422
                  : 200,
            ),
          ),
          Effect.mapError(wireFailure),
        ),
      );
    },
    ActivateHnsCommunityRootImport: (request) => {
      if (
        request.principal === null ||
        (request.principal.kind !== "user" && request.principal.kind !== "admin")
      ) {
        throw new AuthError({ message: "Authentication required" });
      }
      const params = request.params as Readonly<{ communityId: string; sessionId: string }>;
      const body = request.body as Readonly<{
        expected_revision: number;
        idempotency_key: string;
        publish_plan_sha256: string;
        readiness_result_sha256: string;
        acknowledged_complete_resource_replacement: true;
      }>;
      return Effect.runPromise(
        activateHnsCommunityRootImport(
          {
            actor_id: request.principal.subject,
            actor_kind: request.principal.kind,
            community_id: params.communityId,
            root_import_session_id: params.sessionId,
            ...body,
          },
          services,
        ).pipe(
          Effect.map((result) => withEndpointResult(result, result.replayed ? 200 : 201)),
          Effect.mapError(wireFailure),
        ),
      );
    },
  };
}
