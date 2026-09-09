import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Conflict, InternalError, RateLimited } from "@pirate/contracts";
import { createHttpWorker } from "./transport.ts";

const feed = { items: [], top_communities: [], next_cursor: null };

interface Captured {
  readonly event: unknown;
  readonly diagnostic: Record<string, unknown>;
}

const captureBoundaryFailures = () => {
  const captured: Captured[] = [];
  const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    captured.push({ event: args[0], diagnostic: (args[1] ?? {}) as Record<string, unknown> });
  });
  return { captured, restore: () => spy.mockRestore() };
};

let restoreConsole: (() => void) | undefined;

afterEach(() => {
  restoreConsole?.();
  restoreConsole = undefined;
});

const requestPublicFeed = async (handler: () => unknown) => {
  const { captured, restore } = captureBoundaryFailures();
  restoreConsole = restore;
  const response = await createHttpWorker({
    handlers: { GetPublicHomeFeed: handler },
  }).request("http://worker.test/feed/home/public");
  return { captured, response };
};

describe("HTTP boundary failure evidence", () => {
  it("retains the cause of an unknown failure the client never sees", async () => {
    const { captured, response } = await requestPublicFeed(() => {
      throw Object.assign(new Error("relation hns_root_import_sessions does not exist"), {
        code: "42P01",
      });
    });

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { message: string }; request_id: string };
    // The wire contract is unchanged: the client still learns nothing.
    expect(body.error).toMatchObject({ code: "internal_error" });
    expect(body.error.message).not.toContain("hns_root_import_sessions");

    expect(captured).toHaveLength(1);
    expect(captured[0]?.event).toBe("http_boundary_failure");
    expect(captured[0]?.diagnostic).toMatchObject({
      endpoint: "GetPublicHomeFeed",
      route: "/feed/home/public",
      method: "GET",
      // An unknown failure keeps its identity through the boundary and is
      // redacted only when the wire body is built, so nothing replaces it.
      disposition: "passthrough",
      error_code: "42P01",
      error_message: "relation hns_root_import_sessions does not exist",
    });
  });

  it("correlates the record with the reference the client is given", async () => {
    const { captured, response } = await requestPublicFeed(() => {
      throw new Error("boom");
    });
    const body = (await response.json()) as { request_id: string };

    expect(body.request_id).toBeString();
    expect(captured[0]?.diagnostic.request_id).toBe(body.request_id);
    expect(response.headers.get("x-request-id")).toBe(body.request_id);
  });

  it("adopts a caller-supplied reference so one identifier spans both hops", async () => {
    const { captured, restore } = captureBoundaryFailures();
    restoreConsole = restore;
    const response = await createHttpWorker({
      handlers: {
        GetPublicHomeFeed: () => {
          throw new Error("boom");
        },
      },
    }).request("http://worker.test/feed/home/public", {
      headers: { "x-request-id": "proxy-reference-1" },
    });

    expect(response.headers.get("x-request-id")).toBe("proxy-reference-1");
    expect(captured[0]?.diagnostic.request_id).toBe("proxy-reference-1");
  });

  it("records an internal error the handler raised itself as a passthrough", async () => {
    const { captured, response } = await requestPublicFeed(() => {
      throw new InternalError({ message: "handler gave up" });
    });

    expect(response.status).toBe(500);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.diagnostic).toMatchObject({
      disposition: "passthrough",
      error_message: "handler gave up",
    });
  });

  it("records an undeclared typed failure whose identity is replaced", async () => {
    // `Conflict` is not declared by this endpoint, so the transport substitutes
    // a generic internal error and this record is the only surviving trace.
    const { captured, response } = await requestPublicFeed(() => {
      throw new Conflict({ message: "one open parent already exists" });
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "internal_error" } });
    expect(captured[0]?.diagnostic).toMatchObject({
      disposition: "replaced",
      error_tag: "Conflict",
      error_message: "one open parent already exists",
    });
  });

  it("records the cause a handler preserved behind a fixed wire message", async () => {
    const storage = Object.assign(new Error("relation hns_root_import_sessions does not exist"), {
      _tag: "HnsCommunityRootImportStorageFailed",
      code: "42P01",
    });
    const { captured, response } = await requestPublicFeed(() => {
      throw new InternalError({ message: "HNS community root import failed", cause: storage });
    });
    const body = (await response.json()) as { error: { message: string } };

    // The client is told only the fixed sentence; the record holds the reason.
    expect(body.error.message).toBe("HNS community root import failed");
    expect(body.error.message).not.toContain("42P01");
    expect(captured[0]?.diagnostic.causes).toEqual([
      {
        error_name: "Error",
        error_tag: "HnsCommunityRootImportStorageFailed",
        error_code: "42P01",
        error_message: "relation hns_root_import_sessions does not exist",
      },
    ]);
  });

  it("stays silent for a declared failure the wire already describes", async () => {
    const { captured, response } = await requestPublicFeed(() => {
      throw new RateLimited({ message: "slow down" });
    });

    expect(response.status).toBe(429);
    expect(captured).toEqual([]);
  });

  it("stays silent when the handler succeeds", async () => {
    const { captured, response } = await requestPublicFeed(() => feed);

    expect(response.status).toBe(200);
    expect(captured).toEqual([]);
  });

  it("keeps a credential out of the record when a failure carries one", async () => {
    const { captured } = await requestPublicFeed(() => {
      throw Object.assign(
        new Error("connect postgres://reader:hunter2@db.internal:5432/app refused"),
        {
          query: "SELECT * FROM identity_accounts WHERE session_token = $1",
          parameters: ["session-value-1"],
        },
      );
    });
    const serialized = JSON.stringify(captured[0]?.diagnostic);

    expect(serialized).toContain("[redacted]");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("SELECT");
    expect(serialized).not.toContain("session-value-1");
  });
});
