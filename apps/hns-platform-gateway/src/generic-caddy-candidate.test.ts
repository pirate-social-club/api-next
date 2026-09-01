import { describe, expect, test } from "bun:test";
import { buildHnsGenericCaddyCandidate } from "./generic-caddy-candidate.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function proxyRoute(upstream: string, hosts?: readonly string[], community = false) {
  const route: Record<string, unknown> = {
    handle: [
      {
        handler: "subroute",
        routes: [
          {
            handle: [
              {
                handler: "headers",
                request: {
                  delete: community
                    ? ["CF-Access-*", "X-Pirate-Gateway-*", "X-Pirate-Hns-Forwarder-*"]
                    : ["X-Pirate-Gateway-*", "X-Pirate-Hns-Forwarder-*"],
                },
              },
              {
                handler: "reverse_proxy",
                upstreams: [{ dial: upstream }],
                headers: {
                  request: {
                    set: {
                      "X-Pirate-Gateway-External-Scheme": ["https"],
                      "X-Pirate-Gateway-Tls-Sni": ["{http.request.tls.server_name}"],
                    },
                  },
                },
              },
            ],
          },
        ],
      },
    ],
    terminal: true,
  };
  if (hosts !== undefined) route.match = [{ host: [...hosts] }];
  return route;
}

function fixture() {
  const app = proxyRoute("127.0.0.1:4069", ["app.jazleeuw"], true);
  const wildcard = proxyRoute("127.0.0.1:4069", ["*.jazleeuw"], true);
  const verifier = {
    match: [{ host: ["verifier.pirate.sc"] }],
    handle: [
      { handler: "reverse_proxy", upstreams: [{ dial: "127.0.0.1:4047" }] },
      { handler: "reverse_proxy", upstreams: [{ dial: "127.0.0.1:4048" }] },
    ],
    terminal: true,
  };
  const doh = {
    match: [{ host: ["dns.pirate.sc"] }],
    handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "127.0.0.1:8053" }] }],
    terminal: true,
  };
  return {
    apps: {
      http: {
        servers: {
          srv0: {
            listen: [":443"],
            tls_connection_policies: [
              { match: { sni: ["app.jazleeuw"] }, certificate_selection: { any_tag: ["jaz"] } },
              { certificate_selection: { any_tag: ["general"] } },
            ],
            routes: [app, wildcard, verifier, doh, proxyRoute("127.0.0.1:4049")],
          },
          srv1: { listen: [":80"], routes: [{ handle: [{ handler: "static_response" }] }] },
        },
      },
    },
  };
}

function routeHosts(route: Record<string, unknown>): readonly string[] | null {
  const match = route.match as readonly Readonly<{ host?: readonly string[] }>[] | undefined;
  return match?.[0]?.host ?? null;
}

function dials(value: unknown, output: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) dials(item, output);
  } else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.handler === "reverse_proxy" && Array.isArray(record.upstreams)) {
      for (const upstream of record.upstreams) {
        const dial = (upstream as Record<string, unknown>).dial;
        if (typeof dial === "string") output.push(dial);
      }
    }
    for (const child of Object.values(record)) dials(child, output);
  }
  return output;
}

function nestedProxyHandlers(route: Record<string, unknown>): Record<string, unknown>[] {
  const outer = route.handle;
  if (!Array.isArray(outer) || outer.length !== 1) throw new Error("test route is malformed");
  const subroute = outer[0];
  if (subroute === null || typeof subroute !== "object") throw new Error("test route is malformed");
  const routes = (subroute as Record<string, unknown>).routes;
  if (!Array.isArray(routes) || routes.length !== 1) throw new Error("test route is malformed");
  const nested = routes[0];
  if (nested === null || typeof nested !== "object") throw new Error("test route is malformed");
  const handlers = (nested as Record<string, unknown>).handle;
  if (!Array.isArray(handlers)) throw new Error("test route is malformed");
  return handlers as Record<string, unknown>[];
}

describe("generic HNS Caddy candidate", () => {
  test("retains rollback bytes and moves only the HTTPS fallback behind exact static hosts", () => {
    const source = fixture();
    const sourceBytes = encoder.encode(`${JSON.stringify(source, null, 2)}\n`);
    const verifierBefore = JSON.stringify(source.apps.http.servers.srv0.routes[2]);
    const dohBefore = JSON.stringify(source.apps.http.servers.srv0.routes[3]);
    const tlsBefore = JSON.stringify(source.apps.http.servers.srv0.tls_connection_policies);
    const built = buildHnsGenericCaddyCandidate(sourceBytes);

    expect(built.changed).toBe(true);
    expect(built.rollback_bytes).toEqual(sourceBytes);
    expect(built.general_gateway_spki_sha256).toBe(
      "5c8ddd3dbf63dbab698c726708b06177adda4a21416c675197f97e3b27ab20d8",
    );

    const candidate = JSON.parse(decoder.decode(built.candidate_bytes)) as ReturnType<
      typeof fixture
    >;
    const routes = candidate.apps.http.servers.srv0.routes as Record<string, unknown>[];
    expect(routes.map(routeHosts)).toEqual([
      ["app.jazleeuw"],
      ["*.jazleeuw"],
      ["verifier.pirate.sc"],
      ["dns.pirate.sc"],
      ["pirate", "app.pirate"],
      null,
    ]);
    expect(dials(routes[4])).toEqual(["127.0.0.1:4049"]);
    expect(dials(routes[5])).toEqual(["127.0.0.1:4069"]);
    expect(JSON.stringify(routes[2])).toBe(verifierBefore);
    expect(JSON.stringify(routes[3])).toBe(dohBefore);
    expect(JSON.stringify(candidate.apps.http.servers.srv0.tls_connection_policies)).toBe(
      tlsBefore,
    );
  });

  test("is deterministic and accepts its own generic candidate", () => {
    const first = buildHnsGenericCaddyCandidate(encoder.encode(JSON.stringify(fixture())));
    const second = buildHnsGenericCaddyCandidate(first.candidate_bytes);
    expect(second.changed).toBe(false);
    expect(second.candidate_bytes).toEqual(first.candidate_bytes);
  });

  test("refuses topology, upstream, and trusted-header drift", () => {
    const cases = [
      () => {
        const value = fixture();
        const servers = value.apps.http.servers as Record<string, unknown>;
        servers.srv2 = { listen: [":443"], routes: [] };
        return value;
      },
      () => {
        const value = fixture();
        value.apps.http.servers.srv0.routes.splice(2, 1);
        return value;
      },
      () => {
        const value = fixture();
        const catchall = value.apps.http.servers.srv0.routes[4] as Record<string, unknown>;
        const proxy = nestedProxyHandlers(catchall)[1];
        if (proxy === undefined || !Array.isArray(proxy.upstreams)) {
          throw new Error("test route is malformed");
        }
        proxy.upstreams[0] = { dial: "127.0.0.1:9999" };
        return value;
      },
      () => {
        const value = fixture();
        const app = value.apps.http.servers.srv0.routes[0] as Record<string, unknown>;
        const headers = nestedProxyHandlers(app)[0];
        if (
          headers === undefined ||
          headers.request === null ||
          typeof headers.request !== "object"
        ) {
          throw new Error("test route is malformed");
        }
        (headers.request as Record<string, unknown>).delete = ["CF-Access-*"];
        return value;
      },
    ];
    for (const makeCase of cases) {
      expect(() =>
        buildHnsGenericCaddyCandidate(encoder.encode(JSON.stringify(makeCase()))),
      ).toThrow("Caddy topology refused");
    }
  });
});
