import { describe, expect, it } from "bun:test";
import * as v1 from "./v1.ts";

const isEndpoint = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  "method" in value &&
  "path" in value &&
  "auth" in value;

describe("v1Registry", () => {
  // The route table, OpenAPI document and generated client are all built from
  // the registry, so an endpoint declared here but left out of it has no route
  // and no client operation even though its handler exists.
  it("registers every endpoint v1 declares", () => {
    const registered = new Set<unknown>(Object.values(v1.v1Registry));
    const unregistered = Object.entries(v1)
      .filter(([name, value]) => name !== "v1Registry" && isEndpoint(value))
      .filter(([, value]) => !registered.has(value))
      .map(([name]) => name);
    expect(unregistered).toEqual([]);
  });
});
