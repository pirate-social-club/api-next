import { describe, expect, test } from "bun:test";
import {
  decodeHnsPlatformHostRegistryV1,
  decodeHnsStaticPlatformAppGatewayProfileV1,
  encodeHnsPlatformHostRegistryV1,
  encodeHnsStaticPlatformAppGatewayProfileV1,
  HNS_PLATFORM_HOST_REGISTRY,
  HNS_PLATFORM_HOST_REGISTRY_SHA256,
  HNS_STATIC_PLATFORM_APP_GATEWAY_PROFILE,
  HNS_STATIC_PLATFORM_APP_GATEWAY_SHA256,
  verifyHnsStaticPlatformAppGatewayProfileV1,
} from "./hns-static-platform-app-gateway.ts";

const decoder = new TextDecoder();

describe("HNS static platform application gateway profile", () => {
  test("retains the immutable registry and profile bytes", async () => {
    const registryBytes = encodeHnsPlatformHostRegistryV1();
    const profileBytes = encodeHnsStaticPlatformAppGatewayProfileV1();
    expect(decoder.decode(registryBytes)).toBe(
      '["pirate-hns-platform-host-registry-v1","pirate",["www","api","api-staging","spaces","app","home","admin","assets","static","cdn","dev","staging","profile"]]',
    );
    expect(registryBytes.byteLength).toBe(157);
    expect(decoder.decode(profileBytes)).toBe(
      '["pirate-hns-static-platform-app-gateway-v1",["pirate-hns-platform-host-registry","pirate-hns-platform-host-registry-v1","3825a52e3d6e1c571bb39773aba7bbc250182e36ac3ec04056068ee142aed267"],"pirate","app.pirate","https://pirate.sc",["GET","HEAD"],8192,128,32768,16777216,15000]',
    );
    expect(profileBytes.byteLength).toBe(276);
    expect(HNS_PLATFORM_HOST_REGISTRY_SHA256).toBe(
      "3825a52e3d6e1c571bb39773aba7bbc250182e36ac3ec04056068ee142aed267",
    );
    expect(HNS_STATIC_PLATFORM_APP_GATEWAY_SHA256).toBe(
      "4f9bdb2a451bff45f2ab73fc8b73967d0d6fde35162782d35a18f7d96a95785b",
    );
    await expect(verifyHnsStaticPlatformAppGatewayProfileV1()).resolves.toBeUndefined();

    registryBytes[0] = 0;
    profileBytes[0] = 0;
    expect(encodeHnsPlatformHostRegistryV1()[0]).toBe(0x5b);
    expect(encodeHnsStaticPlatformAppGatewayProfileV1()[0]).toBe(0x5b);
  });

  test("decodes only the exact canonical bytes", () => {
    const registryBytes = encodeHnsPlatformHostRegistryV1();
    const profileBytes = encodeHnsStaticPlatformAppGatewayProfileV1();
    expect(decodeHnsPlatformHostRegistryV1(registryBytes)).toBe(HNS_PLATFORM_HOST_REGISTRY);
    expect(decodeHnsStaticPlatformAppGatewayProfileV1(profileBytes)).toBe(
      HNS_STATIC_PLATFORM_APP_GATEWAY_PROFILE,
    );

    for (const bytes of [
      new TextEncoder().encode(`${decoder.decode(registryBytes)}\n`),
      new TextEncoder().encode(decoder.decode(profileBytes).replace("15000", "15001")),
      new Uint8Array([0xff]),
    ]) {
      expect(() => decodeHnsPlatformHostRegistryV1(bytes)).toThrow();
      expect(() => decodeHnsStaticPlatformAppGatewayProfileV1(bytes)).toThrow();
    }
  });
});
