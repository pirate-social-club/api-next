import { expect, test } from "bun:test";
import type { HnsCommunityRootImportPollServices } from "@pirate/application/namespace-ownership";
import {
  GetCurrentHnsCommunityRootImport,
  HnsCommunityRootImportSessionResponseV1,
} from "@pirate/contracts";
import { Effect, Schema } from "effect";
import { makeHnsCommunityRootImportHandlers } from "./hns-community-root-import-handlers.ts";
import type { DecodedRequest, EndpointHandlerResult } from "./transport.ts";
import { createHttpWorker } from "./transport.ts";

const awaiting = {
  community_id: "community-panel",
  attachment_intent_id: "attachment-panel",
  root_import_session_id: "import-panel",
  root_label: "newroot",
  revision: 3,
  expires_at: "2099-01-01T00:00:00.000Z",
  replayed: false,
  status: "awaiting_owner_update" as const,
  publish_plan: {
    version: "pirate-hns-root-import-publish-plan-v1" as const,
    replacement_semantics: "complete_resource" as const,
    current_records: [],
    preserved_records: [],
    removed_conflicts: [],
    added_records: [],
    replacement_records: [],
    preserved_unknown_record_types: [],
    acknowledgement_required: true as const,
  },
  publish_plan_sha256: "a".repeat(64),
  readiness_result_sha256: null,
  retry_after_seconds: 5,
};

const request: DecodedRequest = {
  principal: { kind: "user", subject: "actor-panel" },
  params: { communityId: awaiting.community_id, sessionId: awaiting.root_import_session_id },
  body: { expected_revision: 3, idempotency_key: "poll-panel" },
  query: undefined,
};

test("the generated discovery route requires credentials and disables caching", async () => {
  const app = createHttpWorker({
    handlers: {
      GetCurrentHnsCommunityRootImport: async () => ({
        community_id: awaiting.community_id,
        attachment: null,
        session: null,
      }),
    },
    authenticate: ({ credentials }) => ({ kind: "user", subject: credentials.authorization ?? "" }),
    authorize: ({ input }) => {
      if (input.principal === null) throw new Error("Missing principal");
    },
  });
  const url = `https://worker.test/communities/${awaiting.community_id}/hns-root-imports`;
  const absentCredentials = await app.request(url);
  expect(absentCredentials.status).toBe(401);
  const response = await app.request(url, { headers: { authorization: "actor-panel" } });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    community_id: awaiting.community_id,
    attachment: null,
    session: null,
  });
});

test("community discovery uses authenticated actor and community without a locator", async () => {
  let captured: unknown;
  const handlers = makeHnsCommunityRootImportHandlers({
    store: {
      getCurrent: (input: unknown) => {
        captured = input;
        return Effect.succeed({
          community_id: awaiting.community_id,
          attachment: null,
          session: null,
        });
      },
    },
  } as unknown as Parameters<typeof makeHnsCommunityRootImportHandlers>[0]);
  const discoveryRequest = {
    ...request,
    params: { communityId: awaiting.community_id },
    body: undefined,
  };
  const response = (await handlers.GetCurrentHnsCommunityRootImport(
    discoveryRequest,
  )) as EndpointHandlerResult;
  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    community_id: awaiting.community_id,
    attachment: null,
    session: null,
  });
  expect(captured).toEqual({ actor_id: "actor-panel", community_id: awaiting.community_id });
  expect(GetCurrentHnsCommunityRootImport.path).toBe("/communities/:communityId/hns-root-imports");
  expect(() =>
    handlers.GetCurrentHnsCommunityRootImport({ ...discoveryRequest, principal: null }),
  ).toThrow("Authentication required");
  await expect(
    handlers.GetCurrentHnsCommunityRootImport({
      ...discoveryRequest,
      params: { communityId: " padded " },
    }),
  ).rejects.toThrow("HNS community root import request is invalid");
});

test("discovery hides unauthorized communities instead of returning absence", async () => {
  const handlers = makeHnsCommunityRootImportHandlers({
    store: { getCurrent: () => Effect.succeed(null) },
  } as unknown as Parameters<typeof makeHnsCommunityRootImportHandlers>[0]);
  await expect(handlers.GetCurrentHnsCommunityRootImport(request)).rejects.toThrow(
    "Community route authority was not found",
  );
});

test("publication checks remain pollable through pending, unavailable, and confirmed results", async () => {
  let status: "pending" | "unavailable" | "verified" | "rejected" | "expired" = "pending";
  let observationCalls = 0;
  const services: HnsCommunityRootImportPollServices = {
    nameProof: { verify: () => Effect.die("Unexpected name proof") },
    completion: {
      complete: () =>
        Effect.succeed({
          ceremony_intent_id: "ceremony-panel",
          session_id: "namespace-panel",
          revision: 1,
          status,
          replayed: false,
          result_hash: status === "verified" ? "b".repeat(64) : null,
          retry_after_seconds: status === "unavailable" ? 30 : status === "pending" ? 1 : null,
        }),
    },
    store: {
      get: () =>
        Effect.succeed({
          ...awaiting,
          status: status === "expired" ? ("expired" as const) : ("failed" as const),
          retry_after_seconds: null,
        }),
      loadPollAuthority: () =>
        Effect.succeed({
          session: awaiting,
          ceremony_intent_id: "ceremony-panel",
          namespace_session_id: "namespace-panel",
          ownership_expected_revision: 1,
          challenge_txt_value: "pirate-verification=panel",
          provision_job_id: "provision-panel",
          ownership_result_sha256: null,
          provision_result_sha256: "c".repeat(64),
        }),
      beginProvisioning: () => Effect.die("Unexpected provisioning"),
      beginObservation: () => {
        observationCalls++;
        return Effect.succeed({
          kind: "observing",
          session: {
            ...awaiting,
            status: "observing",
            revision: 4,
          },
        });
      },
    },
  };
  const handlers = makeHnsCommunityRootImportHandlers(
    services as Parameters<typeof makeHnsCommunityRootImportHandlers>[0],
  );
  for (const [next, retry] of [
    ["pending", 1],
    ["unavailable", 30],
  ] as const) {
    status = next;
    const response = (await handlers.PollHnsCommunityRootImport(request)) as EndpointHandlerResult;
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      status: "awaiting_owner_update",
      publication_check_pending: true,
      retry_after_seconds: retry,
      revision: 3,
    });
    expect(Schema.is(HnsCommunityRootImportSessionResponseV1)(response.body)).toBe(true);
    expect(observationCalls).toBe(0);
  }
  status = "verified";
  const confirmed = (await handlers.PollHnsCommunityRootImport(request)) as EndpointHandlerResult;
  expect(confirmed.body).toMatchObject({ status: "observing", revision: 4 });
  expect(observationCalls).toBe(1);
  for (const next of ["rejected", "expired"] as const) {
    status = next;
    const terminal = (await handlers.PollHnsCommunityRootImport(request)) as EndpointHandlerResult;
    expect(terminal.status).toBe(422);
    expect(terminal.body).toMatchObject({
      status: next === "rejected" ? "failed" : "expired",
      retry_after_seconds: null,
    });
    expect(Schema.is(HnsCommunityRootImportSessionResponseV1)(terminal.body)).toBe(true);
    expect(observationCalls).toBe(1);
  }
});
