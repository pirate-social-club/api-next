import { describe, expect, test } from "bun:test";
import {
  HNS_STATIC_PLATFORM_GATEWAY_PRODUCTION_LISTENERS,
  HNS_STATIC_PLATFORM_GATEWAY_SHADOW_LISTENERS,
  parseHnsStaticPlatformGatewayMode,
} from "./main.ts";

describe("HNS static platform gateway executable profile", () => {
  test("accepts only the two exact source-closed modes", () => {
    expect(parseHnsStaticPlatformGatewayMode(["--mode", "production"])).toBe("production");
    expect(parseHnsStaticPlatformGatewayMode(["--mode", "shadow"])).toBe("shadow");
    expect(() => parseHnsStaticPlatformGatewayMode([])).toThrow();
    expect(() => parseHnsStaticPlatformGatewayMode(["--mode", "production", "extra"])).toThrow();
    expect(() => parseHnsStaticPlatformGatewayMode(["--mode", "other"])).toThrow();
  });

  test("pins disjoint loopback production and shadow listeners", () => {
    expect(HNS_STATIC_PLATFORM_GATEWAY_PRODUCTION_LISTENERS).toEqual({
      gateway_host: "127.0.0.1",
      gateway_port: 4049,
      health_host: "127.0.0.1",
      health_port: 4051,
    });
    expect(HNS_STATIC_PLATFORM_GATEWAY_SHADOW_LISTENERS).toEqual({
      gateway_host: "127.0.0.1",
      gateway_port: 4149,
      health_host: "127.0.0.1",
      health_port: 4151,
    });
  });
});
