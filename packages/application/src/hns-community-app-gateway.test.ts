import { describe, expect, test } from "bun:test";
import {
  decodeHnsCommunityAppInteractiveGatewayProfileV4,
  encodeHnsCommunityAppInteractiveGatewayProfileV4,
  HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PROFILE,
  HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_SHA256,
  verifyHnsCommunityAppInteractiveGatewayProfileV4,
} from "./hns-community-app-gateway.ts";

const exactProfile =
  '["pirate-hns-community-app-interactive-gateway-v4","pirate-hns-forwarder-v3","community_app_v1",["GET","HEAD","POST","PATCH"],["root_to_canonical_community_v2","preserve_other_path_and_query_v1"],["accept","accept-language","cache-control","content-language","content-type","cookie","if-match","if-modified-since","if-none-match","if-unmodified-since","idempotency-key","origin","range","referer","x-csrf-token","x-request-id"],["__Host-pirate_session","__Host-pirate_renewal","__Host-pirate_csrf"],["pirate-hns-solid-host-authority-request-v2","pirate-hns-solid-host-authority-response-v2"],8192,128,32768,1048576,16384,16777216,15000,4096,4000]';

describe("interactive HNS community application gateway profile", () => {
  test("reproduces the ratified exact bytes and digest", async () => {
    const bytes = encodeHnsCommunityAppInteractiveGatewayProfileV4();
    expect(new TextDecoder().decode(bytes)).toBe(exactProfile);
    expect(bytes.byteLength).toBe(646);
    expect(HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_SHA256).toBe(
      "705350bde58be27bf06a05efcf7dcc811e74f0a99ad7580e9be2de790e9c6561",
    );
    await expect(verifyHnsCommunityAppInteractiveGatewayProfileV4()).resolves.toBeUndefined();
    expect(decodeHnsCommunityAppInteractiveGatewayProfileV4(bytes)).toBe(
      HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PROFILE,
    );
  });

  test("retains immutable bytes and rejects every non-exact encoding", () => {
    const bytes = encodeHnsCommunityAppInteractiveGatewayProfileV4();
    bytes[0] = 0;
    expect(encodeHnsCommunityAppInteractiveGatewayProfileV4()[0]).toBe(0x5b);
    for (const changed of [
      new TextEncoder().encode(`${exactProfile}\n`),
      new TextEncoder().encode(exactProfile.replace("15000", "15001")),
      new Uint8Array([0xff]),
    ]) {
      expect(() => decodeHnsCommunityAppInteractiveGatewayProfileV4(changed)).toThrow();
    }
  });
});
