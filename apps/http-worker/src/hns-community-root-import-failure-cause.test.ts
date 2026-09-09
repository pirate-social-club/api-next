import { expect, test } from "bun:test";
import { Effect } from "effect";
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

test("a mapped rejection keeps its declared wire identity", async () => {
  const rejected = { _tag: "HnsCommunityRootImportRejected", reason: "conflict" };

  const failure = await startFailure(rejected);

  expect(failure.code).toBe("conflict");
  expect(failure.message).toBe("HNS root import conflicts with durable state");
});
