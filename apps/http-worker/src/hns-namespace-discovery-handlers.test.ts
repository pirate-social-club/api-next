import { describe, expect, test } from "bun:test";
import type {
  HnsNamespaceDiscoveryStore,
  HnsServedRootsV1,
} from "@pirate/application/use-cases/hns-namespace-discovery";
import { InternalError } from "@pirate/contracts";
import { Effect } from "effect";
import { makeHnsNamespaceDiscoveryHandlers } from "./hns-namespace-discovery-handlers.ts";
import { createHttpWorker } from "./transport.ts";

const url = "https://api-next.pirate.sc/public/hns/namespaces/v1";
const served: HnsServedRootsV1 = {
  generated_at: "2026-10-22T07:00:00.000Z",
  roots: [
    { root: "8s28", expires_at: "2026-10-27T07:00:00.000Z" },
    { root: "a18n", expires_at: "2026-10-25T07:00:00.000Z" },
    { root: "com", expires_at: "2026-10-25T07:00:00.000Z" },
  ],
};

function worker(store: HnsNamespaceDiscoveryStore) {
  return createHttpWorker({ handlers: makeHnsNamespaceDiscoveryHandlers(store) });
}

async function expectInternalError(response: Response) {
  expect(response.status).toBe(500);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toMatchObject({ error: { code: "internal_error" } });
}

describe("HNS namespace discovery endpoint", () => {
  test("serves the current list privately uncached and reads the store on every request", async () => {
    let reads = 0;
    const app = worker({
      servedRoots: () =>
        Effect.sync(() => {
          reads += 1;
          return served;
        }),
    });
    for (const expectedReads of [1, 2]) {
      const response = await app.request(url);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({
        version: 1,
        generated_at: served.generated_at,
        roots: served.roots.slice(0, 2),
      });
      expect(reads).toBe(expectedReads);
    }
  });

  test("answers a database or decoding failure with InternalError, never an empty list", async () => {
    await expectInternalError(
      await worker({
        servedRoots: () =>
          Effect.fail(
            new InternalError({ message: "HNS namespace discovery could not be loaded" }),
          ),
      }).request(url),
    );
  });

  test("answers more than 256 qualifying roots with InternalError", async () => {
    const roots = Array.from({ length: 257 }, (_, index) => ({
      root: `root-${index.toString().padStart(3, "0")}`,
      expires_at: "2026-10-27T07:00:00.000Z",
    }));
    await expectInternalError(
      await worker({ servedRoots: () => Effect.succeed({ ...served, roots }) }).request(url),
    );
  });

  test("refuses to serve an entry that would expire at generation", async () => {
    await expectInternalError(
      await worker({
        servedRoots: () =>
          Effect.succeed({
            ...served,
            roots: [{ root: "8s28", expires_at: served.generated_at }],
          }),
      }).request(url),
    );
  });
});
