import { describe, expect, test } from "bun:test";
import {
  decodeHnsCommunityAppInteractiveGatewayProfileV2,
  encodeHnsCommunityAppInteractiveGatewayProfileV2,
  HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PROFILE,
  HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_SHA256,
  verifyHnsCommunityAppInteractiveGatewayProfileV2,
} from "./hns-community-app-gateway.ts";

const exactProfile =
  '["pirate-hns-community-app-interactive-gateway-v2","pirate-hns-forwarder-v3","community_app_v1",["GET","HEAD","POST","PATCH"],["root_to_canonical_community_v2","preserve_other_path_and_query_v1"],["accept","accept-language","cache-control","content-language","content-type","cookie","if-match","if-modified-since","if-none-match","if-unmodified-since","idempotency-key","origin","range","referer","x-csrf-token","x-request-id"],["__Host-pirate_session","__Host-pirate_csrf"],["pirate-hns-solid-host-authority-request-v2","pirate-hns-solid-host-authority-response-v2"],8192,128,32768,1048576,16384,16777216,15000,4096,2000]';

describe("interactive HNS community application gateway profile", () => {
  test("reproduces the ratified exact bytes and digest", async () => {
    const bytes = encodeHnsCommunityAppInteractiveGatewayProfileV2();
    expect(new TextDecoder().decode(bytes)).toBe(exactProfile);
    expect(bytes.byteLength).toBe(622);
    expect(HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_SHA256).toBe(
      "f49ac37bd45da71bdf1e1cc65f184729d85f9d72ce811f0551a70f7785aa8d86",
    );
    await expect(verifyHnsCommunityAppInteractiveGatewayProfileV2()).resolves.toBeUndefined();
    expect(decodeHnsCommunityAppInteractiveGatewayProfileV2(bytes)).toBe(
      HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PROFILE,
    );
  });

  test("retains immutable bytes and rejects every non-exact encoding", () => {
    const bytes = encodeHnsCommunityAppInteractiveGatewayProfileV2();
    bytes[0] = 0;
    expect(encodeHnsCommunityAppInteractiveGatewayProfileV2()[0]).toBe(0x5b);
    for (const changed of [
      new TextEncoder().encode(`${exactProfile}\n`),
      new TextEncoder().encode(exactProfile.replace("15000", "15001")),
      new Uint8Array([0xff]),
    ]) {
      expect(() => decodeHnsCommunityAppInteractiveGatewayProfileV2(changed)).toThrow();
    }
  });
});
