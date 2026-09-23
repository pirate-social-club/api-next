import { describe, expect, test } from "bun:test";
import type { SpacesRegistryStore } from "@pirate/application/use-cases/handles/spaces-registry";
import { Effect } from "effect";
import { createHttpWorker } from "./transport.ts";

const basePath = "/internal/spaces/registry/v1";
const credential = {
  credential_id: `srcred_${"a".repeat(32)}`,
  operator_instance_id: "operator-instance-1",
  network: "regtest" as const,
  allowed_roots: ["charizard"],
};

function fakeStore() {
  const calls = { pending: [] as string[], ack: [] as string[], committed: [] as string[] };
  const store: SpacesRegistryStore = {
    authenticate: ({ token, environment }) =>
      Effect.succeed(token === "good-token" && environment === "development" ? credential : null),
    pending: ({ space }) => {
      calls.pending.push(space.kind === "root" ? space.canonical_root : space.raw);
      return Effect.succeed(
        space.kind === "root" && space.canonical_root === "charizard"
          ? {
              kind: "handles" as const,
              handles: [{ handle: "reader@charizard", script_pubkey: `5120${"a".repeat(64)}` }],
            }
          : { kind: "forbidden" as const },
      );
    },
    acknowledge: ({ entry }) => {
      calls.ack.push(entry.kind === "outcome" ? entry.handle : "malformed");
      return Effect.succeed(
        entry.kind === "malformed" ? ("anomaly" as const) : ("applied" as const),
      );
    },
    committed: ({ handles }) => {
      calls.committed.push(...handles);
      return Effect.succeed(handles.map(() => "applied" as const));
    },
    stopClaim: () => Effect.succeed({ kind: "not_found" as const }),
  };
  return { store, calls };
}

const request = (path: string, init: RequestInit = {}) =>
  new Request(`https://api.example.test${basePath}${path}`, {
    ...init,
    headers: { authorization: "Bearer good-token", ...init.headers },
  });

describe("private Spaces registry transport", () => {
  test("is absent by default and authenticates before decoding a body", async () => {
    const disabled = createHttpWorker();
    expect((await disabled.request(request("/health"))).status).toBe(404);
    const { store, calls } = fakeStore();
    const app = createHttpWorker({
      spacesRegistry: { basePath, store, environment: "development", pageCapacity: 10 },
    });
    const missing = await app.request(
      request("/ack", {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
        body: "not-json",
      }),
    );
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe("Bearer");
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(calls.ack).toEqual([]);
    expect((await app.request(request("/health"))).status).toBe(200);
    expect((await app.request(request("/health", { method: "POST" }))).status).toBe(405);
    expect((await app.request(request("/ack", { method: "POST", body: "not-json" }))).status).toBe(
      400,
    );
    expect(calls.ack).toEqual([]);
  });

  test("serves one scoped pending page and reports ack and commit application", async () => {
    const { store, calls } = fakeStore();
    const app = createHttpWorker({
      spacesRegistry: { basePath, store, environment: "development", pageCapacity: 10 },
    });
    const pending = await app.request(request("/pending?space=%40charizard"));
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual({
      handles: [{ handle: "reader@charizard", script_pubkey: `5120${"a".repeat(64)}` }],
    });
    expect((await app.request(request("/pending?space=%232"))).status).toBe(403);
    expect(
      (await app.request(request("/pending?space=%40charizard&space=%40charizard"))).status,
    ).toBe(400);
    expect(calls.pending).toEqual(["charizard", "#2"]);
    const ack = await app.request(
      request("/ack", {
        method: "POST",
        body: JSON.stringify({
          handles: [{ handle: "reader@charizard", outcome: "staged" }, { handle: "bad" }],
        }),
      }),
    );
    expect(ack.status).toBe(200);
    expect(await ack.json()).toEqual({
      status: "ok",
      summary: { applied: 1, unchanged: 0, stale: 0, anomaly: 1 },
    });
    expect(calls.ack).toEqual(["reader@charizard", "malformed"]);
    const committed = await app.request(
      request("/committed", {
        method: "POST",
        body: JSON.stringify({ root: "b".repeat(64), handles: ["reader@charizard"] }),
      }),
    );
    expect(committed.status).toBe(200);
    expect(await committed.json()).toEqual({
      status: "ok",
      summary: { applied: 1, unchanged: 0, stale: 0, anomaly: 0 },
    });
    expect(calls.committed).toEqual(["reader@charizard"]);
  });
});
