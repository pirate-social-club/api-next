import { describe, expect, test } from "bun:test";
import { HnsNamespaceDiscoveryV1, InternalError } from "@pirate/contracts";
import { Effect, Schema } from "effect";
import {
  type HnsNamespaceDiscoveryStore,
  type HnsServedRootsV1,
  listHnsNamespaces,
} from "./hns-namespace-discovery.ts";

const generatedAt = "2026-10-22T07:00:00.000Z";
const expiresAt = "2026-10-27T07:00:00.000Z";

const storeOf = (served: HnsServedRootsV1): HnsNamespaceDiscoveryStore => ({
  servedRoots: () => Effect.succeed(served),
});

const servedRoots = (roots: readonly string[]): HnsServedRootsV1 => ({
  generated_at: generatedAt,
  roots: [...roots].sort().map((root) => ({ root, expires_at: expiresAt })),
});

/** 63-octet LDH labels that sort in index order and collide with no reserved root. */
const longRoot = (index: number) => `r${index.toString().padStart(4, "0")}${"x".repeat(58)}`;

describe("HNS namespace discovery", () => {
  test("returns the served roots under version 1 at the store's instant", async () => {
    const served = servedRoots(["8s28", "a18n"]);
    expect(await Effect.runPromise(listHnsNamespaces(storeOf(served)))).toEqual({
      version: 1,
      generated_at: generatedAt,
      roots: [...served.roots],
    });
  });

  test("never lists a reserved root, whatever the store returns", async () => {
    const response = await Effect.runPromise(
      listHnsNamespaces(
        storeOf(servedRoots(["8s28", "com", "box", "eth", "onion", "alt", "corp", "lan", "a18n"])),
      ),
    );
    expect(response.roots.map((entry) => entry.root)).toEqual(["8s28", "a18n"]);
  });

  test("answers more than 256 qualifying roots with InternalError instead of truncating", async () => {
    const bound = Array.from({ length: 256 }, (_, index) => longRoot(index));
    const atBound = await Effect.runPromise(
      // Reserved roots are removed before the bound is applied.
      listHnsNamespaces(storeOf(servedRoots([...bound, "com", "eth"]))),
    );
    expect(atBound.roots).toHaveLength(256);
    expect(Schema.decodeUnknownSync(HnsNamespaceDiscoveryV1)(atBound)).toEqual(atBound);
    expect(new TextEncoder().encode(JSON.stringify(atBound)).byteLength).toBeLessThan(32 * 1_024);

    const failure = await Effect.runPromise(
      Effect.flip(listHnsNamespaces(storeOf(servedRoots([...bound, longRoot(256)])))),
    );
    expect(failure).toBeInstanceOf(InternalError);
  });

  test("propagates a store failure and never succeeds with an empty list", async () => {
    const store: HnsNamespaceDiscoveryStore = {
      servedRoots: () => Effect.fail(new InternalError({ message: "database unavailable" })),
    };
    const failure = await Effect.runPromise(Effect.flip(listHnsNamespaces(store)));
    expect(failure).toBeInstanceOf(InternalError);
  });
});
