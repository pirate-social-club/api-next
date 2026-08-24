import { afterEach, describe, expect, test } from "bun:test";
import {
  disabledProductionHnsStaticPlatformGatewayComposition,
  makeHnsStaticPlatformGatewayComposition,
} from "./composition.ts";
import {
  HNS_GATEWAY_EXTERNAL_SCHEME_HEADER,
  HNS_GATEWAY_TLS_SNI_HEADER,
  type HnsStaticPlatformGatewayHeaderField,
  type HnsStaticPlatformGatewayRequest,
} from "./request.ts";
import { startHnsStaticPlatformGatewayServer } from "./server.ts";
import {
  HnsStaticPlatformGatewayCallerAbort,
  makeHnsStaticPlatformGatewayService,
} from "./service.ts";

function request(
  host: string,
  overrides: Partial<HnsStaticPlatformGatewayRequest> = {},
): HnsStaticPlatformGatewayRequest {
  return {
    method: "GET",
    target: "/",
    header_fields: [
      ["Host", host],
      [HNS_GATEWAY_EXTERNAL_SCHEME_HEADER, "https"],
      [HNS_GATEWAY_TLS_SNI_HEADER, host],
    ],
    body_bytes: new Uint8Array(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

const runningServers: Array<{ stop: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.stop()));
});

describe("HNS static platform application gateway", () => {
  test("keeps the production composition disabled and fails partial enablement closed", () => {
    expect(disabledProductionHnsStaticPlatformGatewayComposition).toEqual({
      enabled: false,
      service: null,
    });
    expect(makeHnsStaticPlatformGatewayComposition(false, { upstream_fetch: fetch })).toBe(
      disabledProductionHnsStaticPlatformGatewayComposition,
    );
    expect(() => makeHnsStaticPlatformGatewayComposition(true)).toThrow(
      "HNS static platform gateway composition is incomplete or invalid",
    );
  });

  test("redirects the bare apex byte-for-byte without an upstream call", async () => {
    let calls = 0;
    const service = makeHnsStaticPlatformGatewayService({
      upstream_fetch: () => {
        calls += 1;
        return new Response();
      },
    });
    const response = await service.handle(request("pirate", { target: "/feed?q=%2Bvalue" }));
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("https://app.pirate/feed?q=%2Bvalue");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(calls).toBe(0);
  });

  test("proxies app.pirate only to the closed canonical origin and strips authority", async () => {
    const calls: Request[] = [];
    const service = makeHnsStaticPlatformGatewayService({
      upstream_fetch: (upstream) => {
        calls.push(upstream);
        return new Response("public", {
          status: 200,
          headers: {
            "content-type": "text/plain",
            "set-cookie": "session=forbidden",
            "cf-access-jwt-assertion": "forbidden",
            "x-pirate-hns-forwarder-signature": "forbidden",
          },
        });
      },
    });
    const fields: readonly HnsStaticPlatformGatewayHeaderField[] = [
      ...request("app.pirate").header_fields,
      ["Cookie", "session=browser"],
      ["Authorization", "Bearer browser"],
      ["Origin", "https://evil.invalid"],
      ["X-CSRF-Token", "browser"],
      ["CF-Access-Client-Secret", "browser"],
      ["X-Pirate-Hns-Forwarder-Key-Id", "browser"],
      ["X-Forwarded-Host", "evil.invalid"],
      ["Accept-Encoding", "br"],
      ["Accept-Language", "en"],
    ];
    const response = await service.handle(
      request("app.pirate", {
        method: "HEAD",
        target: "/c/community?q=%2Bvalue",
        header_fields: fields,
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://pirate.sc/c/community?q=%2Bvalue");
    expect(calls[0]?.method).toBe("HEAD");
    expect(calls[0]?.redirect).toBe("manual");
    expect(calls[0]?.headers.get("accept-encoding")).toBe("identity");
    expect(calls[0]?.headers.get("accept-language")).toBe("en");
    for (const name of [
      "cookie",
      "authorization",
      "origin",
      "x-csrf-token",
      "cf-access-client-secret",
      "x-pirate-hns-forwarder-key-id",
      "x-forwarded-host",
      HNS_GATEWAY_EXTERNAL_SCHEME_HEADER,
      HNS_GATEWAY_TLS_SNI_HEADER,
    ]) {
      expect(calls[0]?.headers.get(name)).toBeNull();
    }
    expect(await response.text()).toBe("");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cf-access-jwt-assertion")).toBeNull();
    expect(response.headers.get("x-pirate-hns-forwarder-signature")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("rejects every unowned host and malformed authority before fetch", async () => {
    let calls = 0;
    const service = makeHnsStaticPlatformGatewayService({
      upstream_fetch: () => {
        calls += 1;
        return new Response();
      },
    });
    const cases = [
      request("api.pirate"),
      request("name.pirate"),
      request("app.example"),
      request("app.pirate", {
        header_fields: [...request("app.pirate").header_fields, ["Host", "app.pirate"]],
      }),
      request("app.pirate", {
        header_fields: [
          ["Host", "app.pirate"],
          [HNS_GATEWAY_EXTERNAL_SCHEME_HEADER, "https"],
          [HNS_GATEWAY_TLS_SNI_HEADER, "pirate"],
        ],
      }),
      request("app.pirate", {
        header_fields: [
          ["Host", "app.pirate"],
          [HNS_GATEWAY_EXTERNAL_SCHEME_HEADER, "http"],
          [HNS_GATEWAY_TLS_SNI_HEADER, "app.pirate"],
        ],
      }),
    ];
    for (const candidate of cases)
      expect((await service.handle(candidate)).status).toBeGreaterThanOrEqual(400);
    expect(calls).toBe(0);
  });

  test("rejects unsafe methods, bodies, ambiguous targets, and request bounds", async () => {
    const service = makeHnsStaticPlatformGatewayService({ upstream_fetch: () => new Response() });
    expect((await service.handle(request("app.pirate", { method: "POST" }))).status).toBe(405);
    expect(
      (await service.handle(request("app.pirate", { body_bytes: new Uint8Array([1]) }))).status,
    ).toBe(413);
    expect(
      (
        await service.handle(
          request("app.pirate", {
            header_fields: [
              ...request("app.pirate").header_fields,
              ["Transfer-Encoding", "chunked"],
            ],
          }),
        )
      ).status,
    ).toBe(413);
    for (const target of [
      "https://evil.invalid/",
      "//evil",
      "/a//b",
      "/a/../b",
      "/a/%2F/b",
      "/a#b",
      "/a\\b",
      "/%zz",
    ]) {
      expect((await service.handle(request("app.pirate", { target }))).status).toBe(400);
    }
    expect(
      (
        await service.handle(
          request("app.pirate", {
            header_fields: [
              ...request("app.pirate").header_fields,
              ["x-large", "x".repeat(32_768)],
            ],
          }),
        )
      ).status,
    ).toBe(413);
    expect(
      (
        await service.handle(
          request("app.pirate", {
            header_fields: Array.from({ length: 129 }, (_, index) => [`x-${index}`, "v"] as const),
          }),
        )
      ).status,
    ).toBe(400);
  });

  test("passes only safe redirects and rejects invalid or oversized upstream responses", async () => {
    const responses = [
      new Response(null, { status: 302, headers: { location: "/login" } }),
      new Response(null, { status: 302, headers: { location: "https://app.pirate/login" } }),
      new Response(null, { status: 302, headers: { location: "https://evil.invalid/login" } }),
      new Response(null, { status: 302, headers: { location: "//pirate.sc/login" } }),
      new Response(null, { status: 302, headers: { location: "\\evil.invalid/login" } }),
      new Response(null, { status: 200, headers: { "content-length": "16777217" } }),
      new Response("x", { status: 200, headers: { "content-length": "2" } }),
    ];
    const service = makeHnsStaticPlatformGatewayService({
      upstream_fetch: () => responses.shift() ?? new Response(),
    });
    expect((await service.handle(request("app.pirate"))).status).toBe(302);
    expect((await service.handle(request("app.pirate"))).status).toBe(302);
    expect((await service.handle(request("app.pirate"))).status).toBe(502);
    expect((await service.handle(request("app.pirate"))).status).toBe(502);
    expect((await service.handle(request("app.pirate"))).status).toBe(502);
    expect((await service.handle(request("app.pirate"))).status).toBe(502);
    expect((await service.handle(request("app.pirate"))).status).toBe(502);
  });

  test("accepts the exact observed response bound and rejects the next byte", async () => {
    const chunk = new Uint8Array(1_048_576);
    const streamed = (count: number) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let index = 0; index < count; index += 1) controller.enqueue(chunk);
            controller.close();
          },
        }),
      );
    const responses = [streamed(16), streamed(17)];
    const service = makeHnsStaticPlatformGatewayService({
      upstream_fetch: () => responses.shift() ?? new Response(),
    });
    const exact = await service.handle(request("app.pirate"));
    expect(exact.status).toBe(200);
    expect(exact.headers.get("content-length")).toBe("16777216");
    expect((await service.handle(request("app.pirate"))).status).toBe(502);
  });

  test("maps network and deadline failures and propagates caller abort", async () => {
    const unavailable = makeHnsStaticPlatformGatewayService({
      upstream_fetch: () => Promise.reject(new Error("unavailable")),
    });
    expect((await unavailable.handle(request("app.pirate"))).status).toBe(503);

    const deadline = makeHnsStaticPlatformGatewayService({
      upstream_fetch: (upstream) =>
        upstream.signal.aborted
          ? Promise.reject(new Error("aborted"))
          : new Promise((_, reject) =>
              upstream.signal.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              }),
            ),
      set_timeout: (callback: () => void) => {
        callback();
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clear_timeout: () => undefined,
    });
    expect((await deadline.handle(request("app.pirate"))).status).toBe(504);

    const abort = new AbortController();
    abort.abort();
    await expect(
      unavailable.handle(request("app.pirate", { signal: abort.signal })),
    ).rejects.toBeInstanceOf(HnsStaticPlatformGatewayCallerAbort);
  });

  test("retains the first terminal across caller-abort and deadline races", async () => {
    let fireDeadline: () => void = () => undefined;
    const service = makeHnsStaticPlatformGatewayService({
      upstream_fetch: (upstream) =>
        upstream.signal.aborted
          ? Promise.reject(new Error("aborted"))
          : new Promise((_, reject) =>
              upstream.signal.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              }),
            ),
      set_timeout: (callback: () => void) => {
        fireDeadline = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clear_timeout: () => undefined,
    });

    const callerFirst = new AbortController();
    const callerFirstResult = service.handle(request("app.pirate", { signal: callerFirst.signal }));
    callerFirst.abort();
    fireDeadline();
    await expect(callerFirstResult).rejects.toBeInstanceOf(HnsStaticPlatformGatewayCallerAbort);

    const deadlineFirst = new AbortController();
    const deadlineFirstResult = service.handle(
      request("app.pirate", { signal: deadlineFirst.signal }),
    );
    fireDeadline();
    deadlineFirst.abort();
    expect((await deadlineFirstResult).status).toBe(504);
  });

  test("applies the deadline while buffering the upstream response", async () => {
    let fireDeadline: () => void = () => undefined;
    const service = makeHnsStaticPlatformGatewayService({
      upstream_fetch: (upstream) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              upstream.signal.addEventListener(
                "abort",
                () => controller.error(new Error("aborted")),
                { once: true },
              );
            },
          }),
        ),
      set_timeout: (callback: () => void) => {
        fireDeadline = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clear_timeout: () => undefined,
    });
    const result = service.handle(request("app.pirate"));
    await Promise.resolve();
    fireDeadline();
    expect((await result).status).toBe(504);
  });

  test("starts distinct loopback gateway and health listeners and stops cleanly", async () => {
    const composition = makeHnsStaticPlatformGatewayComposition(true, {
      upstream_fetch: () => new Response("ok"),
    });
    const server = await startHnsStaticPlatformGatewayServer({
      composition,
      gateway_host: "127.0.0.1",
      gateway_port: 0,
      health_host: "127.0.0.1",
      health_port: 0,
      ready: () => true,
    });
    runningServers.push(server);
    const health = await fetch(`http://127.0.0.1:${server.health_address.port}/readyz`);
    expect(health.status).toBe(204);
    const gateway = await fetch(`http://127.0.0.1:${server.gateway_address.port}/path?q=1`, {
      redirect: "manual",
      headers: {
        Host: "pirate",
        [HNS_GATEWAY_EXTERNAL_SCHEME_HEADER]: "https",
        [HNS_GATEWAY_TLS_SNI_HEADER]: "pirate",
      },
    });
    expect(gateway.status).toBe(301);
    expect(gateway.headers.get("location")).toBe("https://app.pirate/path?q=1");

    await expect(
      startHnsStaticPlatformGatewayServer({
        composition,
        gateway_host: "0.0.0.0",
        gateway_port: 0,
        health_host: "127.0.0.1",
        health_port: 0,
        ready: () => true,
      }),
    ).rejects.toThrow("configuration is incomplete or invalid");
  });
});
