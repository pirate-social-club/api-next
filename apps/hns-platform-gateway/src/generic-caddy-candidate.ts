import { Predicate } from "effect";

const HNS_GENERIC_COMMUNITY_UPSTREAM = "127.0.0.1:4069" as const;
const HNS_STATIC_PLATFORM_UPSTREAM = "127.0.0.1:4049" as const;
const HNS_GENERIC_GATEWAY_SPKI_SHA256 =
  "5c8ddd3dbf63dbab698c726708b06177adda4a21416c675197f97e3b27ab20d8" as const;

const MAX_CADDY_CONFIG_BYTES = 1_048_576;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const staticHosts = ["pirate", "app.pirate"] as const;
const gatewayHeaders = ["X-Pirate-Gateway-*", "X-Pirate-Hns-Forwarder-*"] as const;
const communityHeaders = ["CF-Access-*", ...gatewayHeaders] as const;

type JsonObject = { [key: string]: unknown };

class HnsGenericCaddyCandidateError extends Error {
  readonly name = "HnsGenericCaddyCandidateError";
}

type HnsGenericCaddyCandidate = Readonly<{
  candidate_bytes: Uint8Array;
  rollback_bytes: Uint8Array;
  changed: boolean;
  https_server: string;
  general_gateway_spki_sha256: typeof HNS_GENERIC_GATEWAY_SPKI_SHA256;
}>;

function rejected(reason: string): never {
  throw new HnsGenericCaddyCandidateError(`Caddy topology refused: ${reason}`);
}

function object(value: unknown, reason: string): JsonObject {
  if (!Predicate.isObject(value) || Array.isArray(value)) return rejected(reason);
  return value;
}

function array(value: unknown, reason: string): unknown[] {
  if (!Array.isArray(value)) return rejected(reason);
  return value;
}

function strings(value: unknown, reason: string): string[] {
  const values = array(value, reason);
  if (!values.every(Predicate.isString)) return rejected(reason);
  return values;
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return [...actual].sort().join("\n") === [...expected].sort().join("\n");
}

function exactHosts(value: unknown): readonly string[] | null {
  if (!Predicate.isObject(value) || Array.isArray(value)) return null;
  const match = value.match;
  if (!Array.isArray(match) || match.length !== 1) return null;
  const matcher = match[0];
  if (!Predicate.isObject(matcher) || Array.isArray(matcher)) return null;
  if (Object.keys(matcher).length !== 1 || !Array.isArray(matcher.host)) return null;
  return matcher.host.every(Predicate.isString) ? matcher.host : null;
}

function isCatchall(value: unknown): boolean {
  if (!Predicate.isObject(value) || Array.isArray(value)) return false;
  return value.match === undefined || value.match === null;
}

function routeForHosts(routes: readonly unknown[], expected: readonly string[]): JsonObject | null {
  const matches = routes.filter((route) => {
    const hosts = exactHosts(route);
    return hosts !== null && sameStrings(hosts, expected);
  });
  if (matches.length > 1) return rejected(`duplicate route for ${expected.join(",")}`);
  return matches.length === 0 ? null : object(matches[0], "host route is malformed");
}

function reverseProxyDials(value: unknown, output: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) reverseProxyDials(item, output);
    return output;
  }
  if (!Predicate.isObject(value)) return output;
  if (value.handler === "reverse_proxy") {
    const upstreams = array(value.upstreams, "reverse proxy upstreams are malformed");
    for (const upstream of upstreams) {
      const dial = object(upstream, "reverse proxy upstream is malformed").dial;
      if (!Predicate.isString(dial)) return rejected("reverse proxy dial is malformed");
      output.push(dial);
    }
  }
  for (const child of Object.values(value)) reverseProxyDials(child, output);
  return output;
}

type ProxyLocation = Readonly<{
  sequence: readonly unknown[];
  index: number;
  proxy: JsonObject;
}>;

function proxyLocations(
  value: unknown,
  target: string,
  output: ProxyLocation[] = [],
): ProxyLocation[] {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      if (Predicate.isObject(item) && !Array.isArray(item) && item.handler === "reverse_proxy") {
        const dials = reverseProxyDials(item);
        if (dials.length === 1 && dials[0] === target) {
          output.push({ sequence: value, index, proxy: item });
        }
      }
      proxyLocations(item, target, output);
    }
    return output;
  }
  if (!Predicate.isObject(value)) return output;
  for (const child of Object.values(value)) proxyLocations(child, target, output);
  return output;
}

function assertDials(route: JsonObject, expected: readonly string[], label: string): void {
  const actual = reverseProxyDials(route);
  if (!sameStrings(actual, expected)) rejected(`${label} upstream changed`);
}

function assertTrustedBoundary(
  route: JsonObject,
  target: string,
  requiredDeletes: readonly string[],
): void {
  const locations = proxyLocations(route, target);
  if (locations.length !== 1) rejected(`expected one ${target} reverse proxy`);
  const location = locations[0];
  if (location === undefined) rejected(`missing ${target} reverse proxy`);

  const deleted = new Set<string>();
  for (const item of location.sequence.slice(0, location.index)) {
    if (!Predicate.isObject(item) || Array.isArray(item) || item.handler !== "headers") continue;
    const request = object(item.request, "header deletion request is malformed");
    for (const header of strings(request.delete, "header deletion list is malformed")) {
      deleted.add(header);
    }
  }
  if (!requiredDeletes.every((header) => deleted.has(header))) {
    rejected(`reserved headers are not deleted before ${target}`);
  }

  const headers = object(location.proxy.headers, "reverse proxy headers are missing");
  const request = object(headers.request, "reverse proxy request headers are missing");
  const set = object(request.set, "reverse proxy trusted headers are missing");
  const expected = {
    "X-Pirate-Gateway-External-Scheme": ["https"],
    "X-Pirate-Gateway-Tls-Sni": ["{http.request.tls.server_name}"],
  } as const;
  if (!sameStrings(Object.keys(set), Object.keys(expected))) {
    rejected("reverse proxy injects unexpected request headers");
  }
  for (const [header, values] of Object.entries(expected)) {
    if (!sameStrings(strings(set[header], "trusted header value is malformed"), values)) {
      rejected(`trusted header ${header} changed`);
    }
  }
}

type Topology = Readonly<{
  root: JsonObject;
  https_server: string;
  server: JsonObject;
  routes: unknown[];
  app_route: JsonObject;
  catchall_index: number;
  state: "source" | "generic";
  certificate_skips_complete: boolean;
}>;

function inspectTopology(rootValue: unknown): Topology {
  const root = object(rootValue, "root is malformed");
  const apps = object(root.apps, "apps are missing");
  const http = object(apps.http, "HTTP app is missing");
  const servers = object(http.servers, "HTTP servers are missing");
  const httpsServers = Object.entries(servers).filter(([, value]) => {
    if (!Predicate.isObject(value) || Array.isArray(value) || !Array.isArray(value.listen)) {
      return false;
    }
    return value.listen.includes(":443");
  });
  if (httpsServers.length !== 1) rejected("expected exactly one :443 server");
  const httpsEntry = httpsServers[0];
  if (httpsEntry === undefined) rejected("HTTPS server is missing");
  const [httpsServer, serverValue] = httpsEntry;
  const server = object(serverValue, "HTTPS server is malformed");
  const routes = array(server.routes, "HTTPS routes are missing");
  const automaticHttps =
    server.automatic_https === undefined
      ? undefined
      : object(server.automatic_https, "automatic HTTPS settings are malformed");
  const skippedCertificates =
    automaticHttps?.skip_certificates === undefined
      ? []
      : strings(
          automaticHttps.skip_certificates,
          "automatic HTTPS certificate skip list is malformed",
        );
  const certificateSkipsComplete = staticHosts.every((host) => skippedCertificates.includes(host));

  const catchalls = routes
    .map((route, index) => ({ route, index }))
    .filter(({ route }) => isCatchall(route));
  if (catchalls.length !== 1) rejected("expected exactly one HTTPS catchall");
  const catchall = catchalls[0];
  if (catchall === undefined) rejected("HTTPS catchall is missing");
  const catchallRoute = object(catchall.route, "HTTPS catchall is malformed");

  const appRoute = routeForHosts(routes, ["app.jazleeuw"]);
  const wildcardRoute = routeForHosts(routes, ["*.jazleeuw"]);
  const verifierRoute = routeForHosts(routes, ["verifier.pirate.sc"]);
  const dohRoute = routeForHosts(routes, ["dns.pirate.sc"]);
  if (appRoute === null || wildcardRoute === null || verifierRoute === null || dohRoute === null) {
    rejected("required exact route is missing");
  }
  assertDials(appRoute, [HNS_GENERIC_COMMUNITY_UPSTREAM], "app.jazleeuw");
  assertDials(wildcardRoute, [HNS_GENERIC_COMMUNITY_UPSTREAM], "*.jazleeuw");
  assertDials(verifierRoute, ["127.0.0.1:4047", "127.0.0.1:4048"], "verifier");
  assertDials(dohRoute, ["127.0.0.1:8053"], "DoH");
  assertTrustedBoundary(appRoute, HNS_GENERIC_COMMUNITY_UPSTREAM, communityHeaders);
  assertTrustedBoundary(wildcardRoute, HNS_GENERIC_COMMUNITY_UPSTREAM, communityHeaders);

  const staticRoute = routeForHosts(routes, staticHosts);
  const catchallDials = reverseProxyDials(catchallRoute);
  if (catchallDials.length !== 1) rejected("HTTPS catchall upstream is ambiguous");
  if (catchallDials[0] === HNS_STATIC_PLATFORM_UPSTREAM && staticRoute === null) {
    assertTrustedBoundary(catchallRoute, HNS_STATIC_PLATFORM_UPSTREAM, gatewayHeaders);
    return {
      root,
      https_server: httpsServer,
      server,
      routes,
      app_route: appRoute,
      catchall_index: catchall.index,
      state: "source",
      certificate_skips_complete: certificateSkipsComplete,
    };
  }
  if (catchallDials[0] === HNS_GENERIC_COMMUNITY_UPSTREAM && staticRoute !== null) {
    assertDials(staticRoute, [HNS_STATIC_PLATFORM_UPSTREAM], "static platform");
    assertTrustedBoundary(staticRoute, HNS_STATIC_PLATFORM_UPSTREAM, gatewayHeaders);
    assertTrustedBoundary(catchallRoute, HNS_GENERIC_COMMUNITY_UPSTREAM, communityHeaders);
    return {
      root,
      https_server: httpsServer,
      server,
      routes,
      app_route: appRoute,
      catchall_index: catchall.index,
      state: "generic",
      certificate_skips_complete: certificateSkipsComplete,
    };
  }
  return rejected("static and generic gateway routes are not in an accepted state");
}

export function buildHnsGenericCaddyCandidate(sourceBytes: Uint8Array): HnsGenericCaddyCandidate {
  if (sourceBytes.byteLength === 0 || sourceBytes.byteLength > MAX_CADDY_CONFIG_BYTES) {
    return rejected("source byte length is outside the accepted bound");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(sourceBytes));
  } catch {
    return rejected("source is not bounded UTF-8 JSON");
  }
  const topology = inspectTopology(parsed);
  const rollbackBytes = Uint8Array.from(sourceBytes);
  if (topology.state === "generic" && topology.certificate_skips_complete) {
    return {
      candidate_bytes: encoder.encode(JSON.stringify(topology.root)),
      rollback_bytes: rollbackBytes,
      changed: false,
      https_server: topology.https_server,
      general_gateway_spki_sha256: HNS_GENERIC_GATEWAY_SPKI_SHA256,
    };
  }

  const candidateRoot = structuredClone(topology.root);
  const candidateApps = object(candidateRoot.apps, "candidate apps are missing");
  const candidateHttp = object(candidateApps.http, "candidate HTTP app is missing");
  const candidateServers = object(candidateHttp.servers, "candidate servers are missing");
  const candidateServer = object(
    candidateServers[topology.https_server],
    "candidate HTTPS server is missing",
  );
  const candidateRoutes = array(candidateServer.routes, "candidate routes are missing");
  if (topology.state === "source") {
    const staticRoute = structuredClone(
      object(candidateRoutes[topology.catchall_index], "candidate catchall is missing"),
    );
    staticRoute.match = [{ host: [...staticHosts] }];
    const genericRoute = structuredClone(topology.app_route);
    delete genericRoute.match;
    candidateRoutes.splice(topology.catchall_index, 1, staticRoute, genericRoute);
  }
  const candidateAutomaticHttps =
    candidateServer.automatic_https === undefined
      ? {}
      : object(candidateServer.automatic_https, "candidate automatic HTTPS settings are malformed");
  const candidateSkippedCertificates =
    candidateAutomaticHttps.skip_certificates === undefined
      ? []
      : strings(
          candidateAutomaticHttps.skip_certificates,
          "candidate automatic HTTPS certificate skip list is malformed",
        );
  candidateAutomaticHttps.skip_certificates = [
    ...candidateSkippedCertificates,
    ...staticHosts.filter((host) => !candidateSkippedCertificates.includes(host)),
  ];
  candidateServer.automatic_https = candidateAutomaticHttps;

  const candidateTopology = inspectTopology(candidateRoot);
  if (candidateTopology.state !== "generic" || !candidateTopology.certificate_skips_complete) {
    rejected("candidate did not reach generic state");
  }
  return {
    candidate_bytes: encoder.encode(JSON.stringify(candidateRoot)),
    rollback_bytes: rollbackBytes,
    changed: true,
    https_server: topology.https_server,
    general_gateway_spki_sha256: HNS_GENERIC_GATEWAY_SPKI_SHA256,
  };
}
