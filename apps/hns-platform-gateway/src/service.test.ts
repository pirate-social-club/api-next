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

  test("proxies app.pirate only to the closed canonical origin and filters authority", async () => {
    const calls: Request[] = [];
    const service = makeHnsStaticPlatformGatewayService({
      upstream_fetch: (upstream) => {
        calls.push(upstream);
        const headers = new Headers({
          "content-type": "text/plain",
          "cf-access-jwt-assertion": "forbidden",
          "x-pirate-hns-forwarder-signature": "forbidden",
        });
        headers.append(
          "set-cookie",
          "__Host-pirate_session=session-token; HttpOnly; Path=/; Secure; SameSite=Lax; Max-Age=3600",
        );
        headers.append(
          "set-cookie",
          "__Host-pirate_csrf=csrf-token; Path=/; Secure; SameSite=Lax; Max-Age=3600",
        );
        return new Response("public", {
          status: 200,
          headers,
        });
      },
    });
    const fields: readonly HnsStaticPlatformGatewayHeaderField[] = [
      ...request("app.pirate").header_fields,
      ["Cookie", "__Host-pirate_session=browser; __Host-pirate_csrf=csrf-token"],
      ["Authorization", "Bearer browser"],
      ["Origin", "https://app.pirate"],
      ["X-CSRF-Token", "csrf-token"],
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
    expect(calls[0]?.headers.get("cookie")).toBe(
      "__Host-pirate_session=browser; __Host-pirate_csrf=csrf-token",
    );
    expect(calls[0]?.headers.get("origin")).toBe("https://app.pirate");
    expect(calls[0]?.headers.get("x-csrf-token")).toBe("csrf-token");
    for (const name of [
      "authorization",
      "cf-access-client-secret",
      "x-pirate-hns-forwarder-key-id",
      "x-forwarded-host",
      HNS_GATEWAY_EXTERNAL_SCHEME_HEADER,
      HNS_GATEWAY_TLS_SNI_HEADER,
    ]) {
      expect(calls[0]?.headers.get(name)).toBeNull();
    }
    expect(await response.text()).toBe("");
    expect(response.headers.getSetCookie()).toEqual([
      "__Host-pirate_session=session-token; HttpOnly; Path=/; Secure; SameSite=Lax; Max-Age=3600",
      "__Host-pirate_csrf=csrf-token; Path=/; Secure; SameSite=Lax; Max-Age=3600",
    ]);
    expect(response.headers.get("cf-access-jwt-assertion")).toBeNull();
    expect(response.headers.get("x-pirate-hns-forwarder-signature")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("preserves an exact authenticated POST body, cookies, Origin, and CSRF proof", async () => {
    const body = new TextEncoder().encode('{"identity_token":"provider-token"}');
    const observations: Array<{ readonly request: Request; readonly body: Uint8Array }> = [];
    const service = makeHnsStaticPlatformGatewayService({
      upstream_fetch: async (upstream) => {
        observations.push({
          request: upstream,
          body: new Uint8Array(await upstream.arrayBuffer()),
        });
        return new Response('{"status":"ok"}', {
          headers: { "content-type": "application/json" },
        });
      },
    });
    const response = await service.handle(
      request("app.pirate", {
        method: "POST",
        target: "/api/auth/session/exchange",
        body_bytes: body,
        header_fields: [
          ...request("app.pirate").header_fields,
          ["Content-Length", String(body.byteLength)],
          ["Content-Type", "application/json"],
          ["Cookie", "__Host-pirate_session=session; __Host-pirate_csrf=csrf"],
          ["Origin", "https://app.pirate"],
          ["X-CSRF-Token", "csrf"],
          ["X-Unlisted-Authority", "must-not-pass"],
        ],
      }),
    );

    expect(response.status).toBe(200);
    const observed = observations[0];
    expect(observed?.request.url).toBe("https://pirate.sc/api/auth/session/exchange");
    expect(observed?.request.method).toBe("POST");
    expect(observed?.request.headers.get("content-type")).toBe("application/json");
    expect(observed?.request.headers.get("cookie")).toBe(
      "__Host-pirate_session=session; __Host-pirate_csrf=csrf",
    );
    expect(observed?.request.headers.get("origin")).toBe("https://app.pirate");
    expect(observed?.request.headers.get("x-csrf-token")).toBe("csrf");
    expect(observed?.request.headers.get("x-unlisted-authority")).toBeNull();
    expect(observed?.body).toEqual(body);
  });

  test("rejects missing, duplicate, or foreign unsafe Origin and ambiguous cookies", async () => {
    let calls = 0;
    const service = makeHnsStaticPlatformGatewayService({
      upstream_fetch: () => {
        calls += 1;
        return new Response();
      },
    });
    const unsafe = (additional: readonly HnsStaticPlatformGatewayHeaderField[]) =>
      request("app.pirate", {
        method: "PATCH",
        header_fields: [...request("app.pirate").header_fields, ...additional],
      });
    expect((await service.handle(unsafe([]))).status).toBe(400);
    expect((await service.handle(unsafe([["Origin", "https://pirate.sc"]]))).status).toBe(400);
    expect(
      (
        await service.handle(
          unsafe([
            ["Origin", "https://app.pirate"],
            ["Origin", "https://app.pirate"],
          ]),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await service.handle(
          unsafe([
            ["Origin", "https://app.pirate"],
            ["Cookie", "a=1"],
            ["Cookie", "b=2"],
          ]),
        )
      ).status,
    ).toBe(413);
    expect(calls).toBe(0);
  });

  test("accepts the exact request-body and cookie bounds and rejects the next byte", async () => {
    let calls = 0;
    const service = makeHnsStaticPlatformGatewayService({
      upstream_fetch: () => {
        calls += 1;
        return new Response();
      },
    });
    const post = (body_bytes: Uint8Array, cookie: string) =>
      request("app.pirate", {
        method: "POST",
        body_bytes,
        header_fields: [
          ...request("app.pirate").header_fields,
          ["Content-Length", String(body_bytes.byteLength)],
          ["Origin", "https://app.pirate"],
          ["Cookie", cookie],
        ],
      });
    expect((await service.handle(post(new Uint8Array(1_048_576), "x".repeat(16_384)))).status).toBe(
      200,
    );
    expect((await service.handle(post(new Uint8Array(1_048_577), "x".repeat(16_384)))).status).toBe(
      413,
    );
    expect((await service.handle(post(new Uint8Array(), "x".repeat(16_385)))).status).toBe(413);
    expect(calls).toBe(1);
  });

  test("fails unknown, duplicate, or weakened response cookies closed", async () => {
    const responseWithCookies = (cookies: readonly string[]) => {
      const headers = new Headers();
      for (const cookie of cookies) headers.append("set-cookie", cookie);
      return new Response(null, { headers });
    };
    const responses = [
      responseWithCookies(["other=value; Path=/; Secure; SameSite=Lax"]),
      responseWithCookies([
        "__Host-pirate_session=one; HttpOnly; Path=/; Secure; SameSite=Lax",
        "__Host-pirate_session=two; HttpOnly; Path=/; Secure; SameSite=Lax",
      ]),
      responseWithCookies([
        "__Host-pirate_session=value; HttpOnly; Domain=app.pirate; Path=/; Secure; SameSite=Lax",
      ]),
      responseWithCookies(["__Host-pirate_csrf=value; HttpOnly; Path=/; Secure; SameSite=Lax"]),
      responseWithCookies(["__Host-pirate_session=value; HttpOnly; Path=/; SameSite=Lax"]),
    ];
    const service = makeHnsStaticPlatformGatewayService({
      upstream_fetch: () => responses.shift() ?? new Response(),
    });
    for (let index = 0; index < 5; index += 1) {
      expect((await service.handle(request("app.pirate"))).status).toBe(502);
    }
  });

  test("preserves exact host-only cookie clearing and rejects unsafe response framing", async () => {
    const clearingHeaders = new Headers({ "content-length": "0" });
    clearingHeaders.append(
      "set-cookie",
      "__Host-pirate_session=; Path=/; Secure; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly",
    );
    clearingHeaders.append(
      "set-cookie",
      "__Host-pirate_csrf=; Path=/; Secure; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0",
    );
    const responses = [
      new Response(null, { headers: clearingHeaders }),
      new Response("x", { headers: { "content-length": "2" } }),
    ];
    const service = makeHnsStaticPlatformGatewayService({
      upstream_fetch: () => responses.shift() ?? new Response(),
    });
    const headers: readonly HnsStaticPlatformGatewayHeaderField[] = [
      ...request("app.pirate").header_fields,
      ["Origin", "https://app.pirate"],
    ];
    const cleared = await service.handle(
      request("app.pirate", { method: "POST", header_fields: headers }),
    );
    expect(cleared.status).toBe(200);
    expect(cleared.headers.getSetCookie()).toEqual([
      "__Host-pirate_session=; Path=/; Secure; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly",
      "__Host-pirate_csrf=; Path=/; Secure; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0",
    ]);
    expect(
      (await service.handle(request("app.pirate", { method: "POST", header_fields: headers })))
        .status,
    ).toBe(502);
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

  test("rejects unauthorized unsafe requests, safe-method bodies, ambiguous targets, and bounds", async () => {
    const service = makeHnsStaticPlatformGatewayService({ upstream_fetch: () => new Response() });
    expect((await service.handle(request("app.pirate", { method: "POST" }))).status).toBe(400);
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

  test("the Node listener retains bounded request bodies and separate response cookies", async () => {
    let observedBody = "";
    const composition = makeHnsStaticPlatformGatewayComposition(true, {
      upstream_fetch: async (upstream) => {
        observedBody = await upstream.text();
        const headers = new Headers();
        headers.append(
          "set-cookie",
          "__Host-pirate_session=session; HttpOnly; Path=/; Secure; SameSite=Lax; Max-Age=3600",
        );
        headers.append(
          "set-cookie",
          "__Host-pirate_csrf=csrf; Path=/; Secure; SameSite=Lax; Max-Age=3600",
        );
        return new Response("ok", { headers });
      },
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
    const response = await fetch(`http://127.0.0.1:${server.gateway_address.port}/api/test`, {
      method: "POST",
      body: '{"ok":true}',
      headers: {
        Host: "app.pirate",
        Origin: "https://app.pirate",
        "Content-Type": "application/json",
        [HNS_GATEWAY_EXTERNAL_SCHEME_HEADER]: "https",
        [HNS_GATEWAY_TLS_SNI_HEADER]: "app.pirate",
      },
    });
    expect(response.status).toBe(200);
    expect(observedBody).toBe('{"ok":true}');
    expect(response.headers.getSetCookie()).toEqual([
      "__Host-pirate_session=session; HttpOnly; Path=/; Secure; SameSite=Lax; Max-Age=3600",
      "__Host-pirate_csrf=csrf; Path=/; Secure; SameSite=Lax; Max-Age=3600",
    ]);
  });
});
