import { describe, expect, test } from "bun:test";
import { makeProductionHnsEdgeStatusComposition } from "./hns-edge-status-production-composition.ts";

const config = (enabled: boolean) => ({
  HNS_EDGE_STATUS_ENABLED: enabled,
  HNS_EDGE_STATUS_ACCESS_ISSUER: "https://piratesocialclub.cloudflareaccess.com",
  HNS_EDGE_STATUS_ACCESS_JWKS_URL:
    "https://piratesocialclub.cloudflareaccess.com/cdn-cgi/access/certs",
  HNS_EDGE_STATUS_ACCESS_AUDIENCE: "a".repeat(64),
});

describe("HNS edge status production composition", () => {
  test("keeps the graph inert when disabled", () => {
    expect(makeProductionHnsEdgeStatusComposition({ config: config(false) })).toMatchObject({
      enabled: false,
      access_validator: null,
      store: null,
    });
  });

  test("requires storage and exact Access configuration when enabled", () => {
    expect(() => makeProductionHnsEdgeStatusComposition({ config: config(true) })).toThrow(
      "HNS edge status production configuration is incomplete or invalid",
    );
    const composition = makeProductionHnsEdgeStatusComposition({
      config: config(true),
      namespace: {
        get: async () => null,
        put: async () => undefined,
      },
      clock: { nowUnixSeconds: () => 1_800_000_000 },
    });
    expect(composition.enabled).toBe(true);
  });
});
