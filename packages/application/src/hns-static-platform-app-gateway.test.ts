import { describe, expect, test } from "bun:test";
import {
  decodeHnsPlatformHostRegistryV1,
  decodeHnsStaticPlatformAppGatewayProfileV1,
  decodeHnsStaticPlatformAppGatewayProfileV2,
  encodeHnsPlatformHostRegistryV1,
  encodeHnsStaticPlatformAppGatewayProfileV1,
  encodeHnsStaticPlatformAppGatewayProfileV2,
  HNS_PLATFORM_HOST_REGISTRY,
  HNS_PLATFORM_HOST_REGISTRY_SHA256,
  HNS_STATIC_PLATFORM_APP_GATEWAY_PROFILE,
  HNS_STATIC_PLATFORM_APP_GATEWAY_PROFILE_V1,
  HNS_STATIC_PLATFORM_APP_GATEWAY_SHA256,
  HNS_STATIC_PLATFORM_APP_GATEWAY_SHA256_V1,
  verifyHnsStaticPlatformAppGatewayProfileV1,
  verifyHnsStaticPlatformAppGatewayProfileV2,
} from "./hns-static-platform-app-gateway.ts";

const decoder = new TextDecoder();

describe("HNS static platform application gateway profile", () => {
  test("retains the immutable registry and profile bytes", async () => {
    const registryBytes = encodeHnsPlatformHostRegistryV1();
    const profileV1Bytes = encodeHnsStaticPlatformAppGatewayProfileV1();
    const profileBytes = encodeHnsStaticPlatformAppGatewayProfileV2();
    expect(decoder.decode(registryBytes)).toBe(
      '["pirate-hns-platform-host-registry-v1","pirate",["www","api","api-staging","spaces","app","home","admin","assets","static","cdn","dev","staging","profile"]]',
    );
    expect(registryBytes.byteLength).toBe(157);
    expect(decoder.decode(profileV1Bytes)).toBe(
      '["pirate-hns-static-platform-app-gateway-v1",["pirate-hns-platform-host-registry","pirate-hns-platform-host-registry-v1","3825a52e3d6e1c571bb39773aba7bbc250182e36ac3ec04056068ee142aed267"],"pirate","app.pirate","https://pirate.sc",["GET","HEAD"],8192,128,32768,16777216,15000]',
    );
    expect(profileV1Bytes.byteLength).toBe(276);
    expect(decoder.decode(profileBytes)).toBe(
      '["pirate-hns-platform-app-gateway-v2",["pirate-hns-platform-host-registry","pirate-hns-platform-host-registry-v1","3825a52e3d6e1c571bb39773aba7bbc250182e36ac3ec04056068ee142aed267"],"pirate","app.pirate","https://pirate.sc",["GET","HEAD","POST","PATCH"],["accept","accept-language","cache-control","content-language","content-type","cookie","if-match","if-modified-since","if-none-match","if-unmodified-since","idempotency-key","origin","range","referer","x-csrf-token","x-request-id"],["__Host-pirate_session","__Host-pirate_csrf"],8192,128,32768,1048576,16384,16777216,15000]',
    );
    expect(profileBytes.byteLength).toBe(577);
    expect(HNS_PLATFORM_HOST_REGISTRY_SHA256).toBe(
      "3825a52e3d6e1c571bb39773aba7bbc250182e36ac3ec04056068ee142aed267",
    );
    expect(HNS_STATIC_PLATFORM_APP_GATEWAY_SHA256_V1).toBe(
      "4f9bdb2a451bff45f2ab73fc8b73967d0d6fde35162782d35a18f7d96a95785b",
    );
    expect(HNS_STATIC_PLATFORM_APP_GATEWAY_SHA256).toBe(
      "d1c7bcc81925f5668f4db7b2c79c9018f8274941d5210988287d5ce328724a76",
    );
    await expect(verifyHnsStaticPlatformAppGatewayProfileV1()).resolves.toBeUndefined();
    await expect(verifyHnsStaticPlatformAppGatewayProfileV2()).resolves.toBeUndefined();

    registryBytes[0] = 0;
    profileV1Bytes[0] = 0;
    profileBytes[0] = 0;
    expect(encodeHnsPlatformHostRegistryV1()[0]).toBe(0x5b);
    expect(encodeHnsStaticPlatformAppGatewayProfileV1()[0]).toBe(0x5b);
    expect(encodeHnsStaticPlatformAppGatewayProfileV2()[0]).toBe(0x5b);
  });

  test("decodes only the exact canonical bytes", () => {
    const registryBytes = encodeHnsPlatformHostRegistryV1();
    const profileV1Bytes = encodeHnsStaticPlatformAppGatewayProfileV1();
    const profileBytes = encodeHnsStaticPlatformAppGatewayProfileV2();
    expect(decodeHnsPlatformHostRegistryV1(registryBytes)).toBe(HNS_PLATFORM_HOST_REGISTRY);
    expect(decodeHnsStaticPlatformAppGatewayProfileV1(profileV1Bytes)).toBe(
      HNS_STATIC_PLATFORM_APP_GATEWAY_PROFILE_V1,
    );
    expect(decodeHnsStaticPlatformAppGatewayProfileV2(profileBytes)).toBe(
      HNS_STATIC_PLATFORM_APP_GATEWAY_PROFILE,
    );

    for (const bytes of [
      new TextEncoder().encode(`${decoder.decode(registryBytes)}\n`),
      new TextEncoder().encode(decoder.decode(profileBytes).replace("15000", "15001")),
      new Uint8Array([0xff]),
    ]) {
      expect(() => decodeHnsPlatformHostRegistryV1(bytes)).toThrow();
      expect(() => decodeHnsStaticPlatformAppGatewayProfileV1(bytes)).toThrow();
      expect(() => decodeHnsStaticPlatformAppGatewayProfileV2(bytes)).toThrow();
    }
    expect(() => decodeHnsStaticPlatformAppGatewayProfileV2(profileV1Bytes)).toThrow();
    expect(() => decodeHnsStaticPlatformAppGatewayProfileV1(profileBytes)).toThrow();
  });
});
