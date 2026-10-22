import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { InternalError } from "./errors.ts";
import {
  HNS_NAMESPACE_DISCOVERY_MAX_ROOTS,
  HnsNamespaceDiscoveryV1,
  ListHnsNamespaces,
} from "./hns-namespace-discovery.ts";
import { registry } from "./registry.ts";

const valid = {
  version: 1,
  generated_at: "2026-10-22T07:00:00.000Z",
  roots: [
    { root: "8s28", expires_at: "2026-10-27T07:00:00.000Z" },
    { root: "a18n", expires_at: "2026-10-25T07:00:00.000Z" },
  ],
} as const;

const decode = Schema.decodeUnknownSync(HnsNamespaceDiscoveryV1);

describe("HNS namespace discovery contract", () => {
  test("declares one public, private no-store read with only InternalError", () => {
    expect(registry.ListHnsNamespaces).toBe(ListHnsNamespaces);
    expect(ListHnsNamespaces).toMatchObject({
      method: "GET",
      path: "/public/hns/namespaces/v1",
      auth: { policy: { kind: "public" } },
      cacheControl: "private, no-store",
    });
    expect("request" in ListHnsNamespaces).toBe(false);
    expect(ListHnsNamespaces.errors).toEqual([InternalError]);
    expect(decode(valid)).toEqual(valid);
    expect(decode({ ...valid, roots: [] })).toEqual({ ...valid, roots: [] });
  });

  test("admits only unique sorted LDH roots that expire after generation", () => {
    const [first, second] = valid.roots;
    for (const roots of [
      [second, first],
      [first, first],
      [{ ...first, expires_at: valid.generated_at }],
      [{ ...first, expires_at: "2026-10-22T06:59:59.999Z" }],
      [{ ...first, expires_at: "2026-10-27T07:00:00Z" }],
      ...["under_score", "Upper", "-lead", "trail-", "a.b", "", "x".repeat(64)].map((root) => [
        { ...first, root },
      ]),
    ]) {
      expect(() => decode({ ...valid, roots })).toThrow();
    }
    expect(() => decode({ ...valid, version: 2 })).toThrow();
    expect(() => decode({ ...valid, roots: [{ ...first, root: "x".repeat(63) }] })).not.toThrow();
  });

  test("bounds the list at 256 roots", () => {
    const roots = Array.from({ length: HNS_NAMESPACE_DISCOVERY_MAX_ROOTS + 1 }, (_, index) => ({
      root: `root-${index.toString().padStart(3, "0")}`,
      expires_at: "2026-10-27T07:00:00.000Z",
    }));
    expect(HNS_NAMESPACE_DISCOVERY_MAX_ROOTS).toBe(256);
    expect(() => decode({ ...valid, roots: roots.slice(0, 256) })).not.toThrow();
    expect(() => decode({ ...valid, roots })).toThrow();
  });
});
