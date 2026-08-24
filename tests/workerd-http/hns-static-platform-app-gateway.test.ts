import { describe, expect, test } from "vitest";
import {
  disabledProductionHnsStaticPlatformGatewayComposition,
  makeHnsStaticPlatformGatewayComposition,
} from "../../apps/hns-platform-gateway/src/composition.ts";
import {
  HNS_GATEWAY_EXTERNAL_SCHEME_HEADER,
  HNS_GATEWAY_TLS_SNI_HEADER,
} from "../../apps/hns-platform-gateway/src/request.ts";

function gatewayRequest(host: string, target: string) {
  return {
    method: "GET",
    target,
    header_fields: [
      ["host", host],
      [HNS_GATEWAY_EXTERNAL_SCHEME_HEADER, "https"],
      [HNS_GATEWAY_TLS_SNI_HEADER, host],
    ] as const,
    body_bytes: new Uint8Array(),
    signal: new AbortController().signal,
  };
}

describe("HNS static platform application gateway in Workerd", () => {
  test("retains a source-closed disabled production graph", () => {
    expect(disabledProductionHnsStaticPlatformGatewayComposition).toEqual({
      enabled: false,
      service: null,
    });
  });

  test("redirects pirate and proxies only app.pirate without a forwarder envelope", async () => {
    const upstream: Request[] = [];
    const composition = makeHnsStaticPlatformGatewayComposition(true, {
      upstream_fetch: (request) => {
        upstream.push(request);
        return new Response("platform", { headers: { "content-type": "text/plain" } });
      },
    });
    if (!composition.enabled) throw new Error("test composition did not enable");

    const apex = await composition.service.handle(gatewayRequest("pirate", "/discover?q=music"));
    expect(apex.status).toBe(301);
    expect(apex.headers.get("location")).toBe("https://app.pirate/discover?q=music");
    expect(upstream).toHaveLength(0);

    const app = await composition.service.handle(gatewayRequest("app.pirate", "/discover?q=music"));
    expect(app.status).toBe(200);
    expect(await app.text()).toBe("platform");
    expect(upstream).toHaveLength(1);
    expect(upstream[0]?.url).toBe("https://pirate.sc/discover?q=music");
    expect(
      [...(upstream[0]?.headers.keys() ?? [])].some((name) =>
        name.startsWith("x-pirate-hns-forwarder-"),
      ),
    ).toBe(false);
  });

  test("keeps every other hostname unavailable without upstream work", async () => {
    let calls = 0;
    const composition = makeHnsStaticPlatformGatewayComposition(true, {
      upstream_fetch: () => {
        calls += 1;
        return new Response();
      },
    });
    if (!composition.enabled) throw new Error("test composition did not enable");
    for (const host of ["api.pirate", "name.pirate", "app.example", "pirate.sc"]) {
      expect((await composition.service.handle(gatewayRequest(host, "/"))).status).toBe(421);
    }
    expect(calls).toBe(0);
  });
});
