import { describe, expect, test } from "bun:test";
import {
  decodeHnsCommunityHandlePersonaGatewayProfileV1,
  encodeHnsCommunityHandlePersonaGatewayProfileV1,
  HnsCommunityHandlePersonaGatewayProfileError,
  verifyHnsCommunityHandlePersonaGatewayProfileV1,
} from "./hns-community-handle-gateway.ts";

describe("HNS community handle-persona gateway profile", () => {
  test("reproduces the immutable 447-byte profile", async () => {
    const bytes = encodeHnsCommunityHandlePersonaGatewayProfileV1();
    expect(bytes.byteLength).toBe(447);
    expect(decodeHnsCommunityHandlePersonaGatewayProfileV1(bytes)[0]).toBe(
      "pirate-hns-community-handle-persona-public-gateway-v1",
    );
    await expect(verifyHnsCommunityHandlePersonaGatewayProfileV1()).resolves.toBeUndefined();
  });

  test("rejects every changed profile byte", () => {
    const bytes = encodeHnsCommunityHandlePersonaGatewayProfileV1();
    for (let index = 0; index < bytes.byteLength; index += 1) {
      const changed = bytes.slice();
      changed[index] = (changed[index] ?? 0) ^ 1;
      expect(() => decodeHnsCommunityHandlePersonaGatewayProfileV1(changed)).toThrow(
        HnsCommunityHandlePersonaGatewayProfileError,
      );
    }
  });
});
