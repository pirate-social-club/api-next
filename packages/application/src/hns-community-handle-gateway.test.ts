import { describe, expect, test } from "bun:test";
import {
  decodeHnsCommunityHandlePersonaGatewayProfileV2,
  encodeHnsCommunityHandlePersonaGatewayProfileV2,
  HnsCommunityHandlePersonaGatewayProfileError,
  verifyHnsCommunityHandlePersonaGatewayProfileV2,
} from "./hns-community-handle-gateway.ts";

describe("HNS community handle-persona gateway profile", () => {
  test("reproduces the immutable 447-byte profile", async () => {
    const bytes = encodeHnsCommunityHandlePersonaGatewayProfileV2();
    expect(bytes.byteLength).toBe(447);
    expect(decodeHnsCommunityHandlePersonaGatewayProfileV2(bytes)[0]).toBe(
      "pirate-hns-community-handle-persona-public-gateway-v2",
    );
    await expect(verifyHnsCommunityHandlePersonaGatewayProfileV2()).resolves.toBeUndefined();
  });

  test("rejects every changed profile byte", () => {
    const bytes = encodeHnsCommunityHandlePersonaGatewayProfileV2();
    for (let index = 0; index < bytes.byteLength; index += 1) {
      const changed = bytes.slice();
      changed[index] = (changed[index] ?? 0) ^ 1;
      expect(() => decodeHnsCommunityHandlePersonaGatewayProfileV2(changed)).toThrow(
        HnsCommunityHandlePersonaGatewayProfileError,
      );
    }
  });
});
