import { describe, expect, test } from "bun:test";
import { hnsGatewayReadinessStatusV1 } from "./live-readiness.ts";

describe("live HNS root readiness", () => {
  test("accepts a routed app host and an unclaimed-label gateway response", () => {
    expect(hnsGatewayReadinessStatusV1("HTTP/1.1 200 OK")).toBe(200);
    expect(hnsGatewayReadinessStatusV1("HTTP/1.1 421 Misdirected Request")).toBe(421);
  });

  test("refuses malformed and unhealthy gateway status lines", () => {
    expect(() => hnsGatewayReadinessStatusV1("HTTP/2 200")).toThrow();
    expect(() => hnsGatewayReadinessStatusV1("HTTP/1.1 503 Service Unavailable")).toThrow();
  });
});
