import {
  activateHnsRootImport,
  getHnsRootImport,
  type HnsRootImportServices,
  pollHnsRootImport,
  startHnsRootImport,
} from "@pirate/application/namespace-ownership";
import {
  AuthError,
  BadRequest,
  Conflict,
  InternalError,
  NotFound,
  ProviderMisconfigured,
  ProviderUnavailable,
} from "@pirate/contracts";
import { Effect } from "effect";
import {
  type DecodedRequest,
  type EndpointHandler,
  type Principal,
  withEndpointResult,
} from "./transport.ts";

export type HnsRootImportHandlers = Readonly<{
  readonly StartHnsRootImport: EndpointHandler;
  readonly GetHnsRootImport: EndpointHandler;
  readonly PollHnsRootImport: EndpointHandler;
  readonly ActivateHnsRootImport: EndpointHandler;
}>;

function actor(principal: Principal | null): Readonly<{
  actor_id: string;
  actor_kind: "user" | "admin";
}> {
  if (principal === null || (principal.kind !== "user" && principal.kind !== "admin")) {
    throw new AuthError({ message: "Authentication required" });
  }
  return { actor_id: principal.subject, actor_kind: principal.kind };
}

function pathParameters(request: DecodedRequest): Readonly<{
  intentId: string;
  sessionId?: string;
}> {
  return request.params as Readonly<{ intentId: string; sessionId?: string }>;
}

function wireFailure(error: unknown): Error {
  const tagged = error as { readonly _tag?: string; readonly reason?: string };
  if (tagged._tag === "HnsRootImportStorageFailed") {
    return new InternalError({ message: "HNS root import operation failed" });
  }
  if (tagged._tag !== "HnsRootImportRejected") {
    return new InternalError({ message: "HNS root import operation failed" });
  }
  switch (tagged.reason) {
    case "not_found":
      return new NotFound({ message: "HNS root import session not found" });
    case "conflict":
      return new Conflict({ message: "HNS root import conflicts with durable state" });
    case "ownership_unavailable":
      return new ProviderUnavailable({ message: "HNS ownership provider is unavailable" });
    case "ownership_rejected":
      return new BadRequest({ message: "HNS name signature did not verify" });
    case "ownership_source_unsupported":
      return new ProviderMisconfigured({
        message: "HNS root import requires parent-chain ownership proof",
      });
    default:
      return new BadRequest({ message: "HNS root import request is invalid" });
  }
}

export function makeHnsRootImportHandlers(services: HnsRootImportServices): HnsRootImportHandlers {
  return {
    StartHnsRootImport: (request) => {
      const body = request.body as Readonly<{
        ceremony_intent_id: string;
        expected_revision: number;
        idempotency_key: string;
      }>;
      return Effect.runPromise(
        startHnsRootImport(
          {
            actor_id: actor(request.principal).actor_id,
            creation_intent_id: pathParameters(request).intentId,
            ceremony_intent_id: body.ceremony_intent_id,
            expected_revision: body.expected_revision,
            idempotency_key: body.idempotency_key,
          },
          services,
        ).pipe(
          Effect.map((result) => withEndpointResult(result, result.replayed ? 200 : 202)),
          Effect.mapError(wireFailure),
        ),
      );
    },
    GetHnsRootImport: (request) => {
      const parameters = pathParameters(request);
      return Effect.runPromise(
        getHnsRootImport(
          {
            actor_id: actor(request.principal).actor_id,
            creation_intent_id: parameters.intentId,
            root_import_session_id: parameters.sessionId ?? "",
          },
          services,
        ).pipe(Effect.mapError(wireFailure)),
      );
    },
    PollHnsRootImport: (request) => {
      const parameters = pathParameters(request);
      const body = request.body as Readonly<{
        expected_revision: number;
        idempotency_key: string;
        provisioning_name_signature?: string;
      }>;
      return Effect.runPromise(
        pollHnsRootImport(
          {
            actor_id: actor(request.principal).actor_id,
            creation_intent_id: parameters.intentId,
            root_import_session_id: parameters.sessionId ?? "",
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
              result.status === "awaiting_ownership" ||
                result.status === "provisioning" ||
                result.status === "awaiting_owner_update" ||
                result.status === "observing"
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
    ActivateHnsRootImport: (request) => {
      const parameters = pathParameters(request);
      const identity = actor(request.principal);
      const body = request.body as Readonly<{
        expected_revision: number;
        idempotency_key: string;
        publish_plan_sha256: string;
        readiness_result_sha256: string;
        acknowledged_complete_resource_replacement: true;
      }>;
      return Effect.runPromise(
        activateHnsRootImport(
          {
            ...identity,
            creation_intent_id: parameters.intentId,
            root_import_session_id: parameters.sessionId ?? "",
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
