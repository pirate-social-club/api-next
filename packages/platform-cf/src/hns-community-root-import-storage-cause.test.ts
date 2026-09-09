import { expect, test } from "bun:test";
import {
  ControlPlaneDb,
  ControlPlaneStatementFailed,
  HnsCommunityRootImportStorageFailed,
  HnsRootImportStorageFailed,
} from "@pirate/application";
import { Effect, Layer } from "effect";
import { boundaryFailureDiagnostic } from "../../../apps/http-worker/src/failure-diagnostics.ts";
import { makeControlPlaneHnsCommunityRootImportStartStore } from "./hns-community-root-import-repository.ts";

const binding = {
  requirement: "namespace_ownership" as const,
  family: "hns" as const,
  provider_id: "hns.owner.v1",
  provider_configuration: { kind: "managed" as const, reference: "hns-owner-test", version: "1" },
  protocol_version: "hns-txt-v1",
};

// Effect v4 has no `Layer.fail`; a failing layer is an effect layer that fails.
const failingLayer = (error: unknown) => Layer.effect(ControlPlaneDb)(Effect.fail(error)) as never;

const storeFailingWith = (error: unknown) =>
  makeControlPlaneHnsCommunityRootImportStartStore(failingLayer(error), {
    environment: "test",
    provider_binding: binding,
  });

// The store port exposes one opaque storage failure by design. Discarding the
// control-plane error while narrowing to it removed the only description of what
// actually failed, one layer below the handler that then replaced the domain
// failure with a fixed sentence.
test("a control-plane failure is carried as the cause of the opaque storage failure", async () => {
  const statementFailed = new ControlPlaneStatementFailed({
    label: "hns.community-root-import.insert-intent",
    sqlState: "23505",
    constraint: "community_route_attachment_intents_one_open_per_community_uidx",
    outcomeCertainty: "completed",
  });

  const failure = await Effect.runPromise(
    storeFailingWith(statementFailed)
      .getCurrent({ actor_id: "user_1", community_id: "community_1" })
      .pipe(Effect.flip),
  );

  expect(failure).toBeInstanceOf(HnsCommunityRootImportStorageFailed);
  expect(failure.cause).toBe(statementFailed);
});

test("an already-opaque failure is not wrapped a second time", async () => {
  const storage = new HnsCommunityRootImportStorageFailed({});

  const failure = await Effect.runPromise(
    storeFailingWith(storage)
      .getCurrent({ actor_id: "user_1", community_id: "community_1" })
      .pipe(Effect.flip),
  );

  expect(failure).toBe(storage);
  expect(failure.cause).toBeUndefined();
});

// Activation is delegated to the shared root-import store, which narrows the
// control-plane error before the community wrapper ever sees it. Preserving the
// cause only on the community wrapper would leave this path opaque.
test("the delegated activation path preserves the control-plane error too", async () => {
  const statementFailed = new ControlPlaneStatementFailed({
    label: "hns-root-import.activate",
    sqlState: "40001",
    constraint: null,
    outcomeCertainty: "unknown",
  });

  const failure = await Effect.runPromise(
    storeFailingWith(statementFailed)
      .activate({
        input: {
          actor_id: "user_1",
          community_id: "community_1",
          root_import_session_id: "session_1",
          creation_intent_id: "attachment_1",
        },
        attachment_intent_id: "attachment_1",
        request_sha256: "a".repeat(64),
        community_id: "community_1",
        dns_zone_activation_id: "zone_1",
        app_host_activation_id: "host_1",
        sale_namespace_activation_id: "sale_1",
        operation_id: "operation_1",
      } as never)
      .pipe(Effect.flip),
  );

  // Two opaque wrappers sit between the boundary and the database error, so the
  // chain is two links deep. The diagnostic cause walk follows three.
  const delegated = (failure as { readonly cause?: unknown }).cause;
  expect(failure).toBeInstanceOf(HnsCommunityRootImportStorageFailed);
  expect(delegated).toBeInstanceOf(HnsRootImportStorageFailed);
  expect((delegated as { readonly cause?: unknown }).cause).toBe(statementFailed);

  expect(
    boundaryFailureDiagnostic({
      requestId: "request-1",
      endpoint: "ActivateHnsCommunityRootImport",
      route: "/communities/:communityId/hns-root-imports/:sessionId/activate",
      method: "POST",
      disposition: "passthrough",
      error: failure,
    }).causes,
  ).toEqual([
    { error_name: "HnsRootImportStorageFailed", error_tag: "HnsRootImportStorageFailed" },
    {
      error_name: "ControlPlaneStatementFailed",
      error_tag: "ControlPlaneStatementFailed",
      statement: "hns-root-import.activate",
      sql_state: "40001",
      outcome_certainty: "unknown",
    },
  ]);
});
