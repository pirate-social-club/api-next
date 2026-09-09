import { expect, test } from "bun:test";
import { HnsCommunityRootImportStorageFailed } from "@pirate/application/namespace-ownership";
import { Effect } from "effect";
import { boundaryFailureDiagnostic } from "./failure-diagnostics.ts";
import { makeHnsCommunityRootImportHandlers } from "./hns-community-root-import-handlers.ts";
import type { DecodedRequest } from "./transport.ts";

const request = {
  principal: { kind: "user", subject: "user_1" },
  params: { communityId: "community_1" },
  body: { root_label: "newroot", idempotency_key: "start-key" },
  headers: {},
  query: undefined,
} as unknown as DecodedRequest;

const handlersFailingWith = (failure: unknown) =>
  makeHnsCommunityRootImportHandlers({
    store: { prepare: () => Effect.fail(failure) },
  } as unknown as Parameters<typeof makeHnsCommunityRootImportHandlers>[0]);

/** The handler may reject or throw; the wire failure is what matters here. */
const startFailure = async (failure: unknown) => {
  try {
    await handlersFailingWith(failure).StartHnsCommunityRootImport(request);
  } catch (error) {
    return error as { code?: string; message?: string; cause?: unknown };
  }
  throw new Error("the handler was expected to fail");
};

// The wire message is fixed and says nothing, so the mapped error is the last
// place the reason can be kept. Without a cause the HTTP boundary can only
// record that an import failed, which is what made the production 500s
// undiagnosable from any retained record.
test("a storage failure reaches the boundary as a cause, not as a fixed sentence", async () => {
  const storage = Object.assign(new Error("relation hns_root_import_sessions does not exist"), {
    _tag: "HnsCommunityRootImportStorageFailed",
    code: "42P01",
  });

  const failure = await startFailure(storage);

  expect(failure.code).toBe("internal_error");
  expect(failure.message).toBe("HNS community root import failed");
  expect(failure.cause).toBe(storage);
});

test("an unrecognised failure also keeps its cause", async () => {
  const unknown = { _tag: "SomethingNobodyMapped", detail: "ran out of connections" };

  const failure = await startFailure(unknown);

  expect(failure.cause).toBe(unknown);
});

// The whole point of the chain: a database failure inside the store reaches the
// boundary naming the statement and the constraint, while the caller still sees
// only "HNS community root import failed".
test("a control-plane statement failure survives to the boundary as a cause", async () => {
  const statementFailed = {
    _tag: "ControlPlaneStatementFailed",
    label: "hns.community-root-import.insert-intent",
    sqlState: "23505",
    constraint: "community_route_attachment_intents_one_open_per_community_uidx",
    outcomeCertainty: "completed",
  };
  const storage = new HnsCommunityRootImportStorageFailed({ cause: statementFailed });

  const failure = await startFailure(storage);
  const record = boundaryFailureDiagnostic({
    requestId: "request-1",
    endpoint: "StartHnsCommunityRootImport",
    route: "/communities/:communityId/hns-root-imports",
    method: "POST",
    disposition: "passthrough",
    error: failure,
  });

  expect(failure.message).toBe("HNS community root import failed");
  expect(record.causes).toEqual([
    {
      error_name: "HnsCommunityRootImportStorageFailed",
      error_tag: "HnsCommunityRootImportStorageFailed",
    },
    {
      error_name: "Object",
      error_tag: "ControlPlaneStatementFailed",
      statement: "hns.community-root-import.insert-intent",
      sql_state: "23505",
      constraint: "community_route_attachment_intents_one_open_per_community_uidx",
      outcome_certainty: "completed",
    },
  ]);
});

test("a mapped rejection keeps its declared wire identity", async () => {
  const rejected = { _tag: "HnsCommunityRootImportRejected", reason: "conflict" };

  const failure = await startFailure(rejected);

  expect(failure.code).toBe("conflict");
  expect(failure.message).toBe("HNS root import conflicts with durable state");
});
