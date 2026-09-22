import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, X509Certificate } from "node:crypto";
import { createServer, request, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import {
  encodeHnsCommunityAppInteractiveGatewayProfileV3,
  HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PROFILE,
} from "@pirate/application/hns-community-app-gateway";
import type { HnsCommunityAppHostAuthorityStateV1 } from "@pirate/application/hns-host-serving";
import { makeStaticHnsForwarderKeyRegistryV1 } from "@pirate/platform-cf/hns-forwarder-v3";
import { Effect } from "effect";
import { runLocalAuthorityFixture } from "../apps/hns-authority-provisioner/ops/staging-fixture/authority.ts";
import { makeHnsCommunityAppGatewayComposition } from "../apps/hns-platform-gateway/src/community-composition.ts";
import {
  HNS_GATEWAY_EXTERNAL_SCHEME_HEADER,
  HNS_GATEWAY_TLS_SNI_HEADER,
} from "../apps/hns-platform-gateway/src/request.ts";

export function certificateSpki(certificate: X509Certificate): string {
  return createHash("sha256")
    .update(certificate.publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
}

async function certificate(root: string) {
  assert.match(root, /^e2e[a-f0-9]{12}$/);
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const key = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  // Throwaway key stays in memory and the child stdin; never arguments or files.
  const child = Bun.spawn(
    [
      "openssl",
      "req",
      "-new",
      "-x509",
      "-key",
      "/dev/stdin",
      "-days",
      "1",
      "-subj",
      `/CN=app.${root}`,
      "-addext",
      `subjectAltName=DNS:app.${root},DNS:unclaimed.${root},IP:127.0.0.1`,
    ],
    { stdin: new TextEncoder().encode(key), stdout: "pipe", stderr: "pipe", timeout: 5000 },
  );
  const [status, pem] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  assert.equal(status, 0, "Fixture certificate generation failed");
  const cert = new X509Certificate(pem);
  assert.ok(cert.checkHost(`app.${root}`));
  return { key, cert: pem, spki: certificateSpki(cert) };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

function get(
  port: number,
  host: string,
  ca: string,
  expectedSpki: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        servername: host,
        ca,
        headers: { ...headers, host },
        method: "GET",
        path: "/",
        timeout: 5000,
      },
      (res) => {
        const peer = (res.socket as TLSSocket).getPeerCertificate();
        try {
          assert.equal(certificateSpki(new X509Certificate(peer.raw)), expectedSpki);
        } catch (error) {
          res.destroy();
          reject(error);
          return;
        }
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
          if (body.length > 4096) req.destroy(new Error("Oversized fixture response"));
        });
        res.once("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.once("error", reject);
      },
    );
    req.once("timeout", () => req.destroy(new Error("Fixture TLS request timed out")));
    req.once("error", reject);
    req.end();
  });
}

/** Component authority is seeded, not a substitute for authenticated activation. */
export async function startFixtureGateway(root: string) {
  const tls = await certificate(root);
  const host = `app.${root}`;
  const deployment = "isolated-gateway-fixture";
  const marker = `fixture-community-${randomUUID()}`;
  let originCalls = 0;
  const origin = createServer(tls, (_req, res) => {
    originCalls += 1;
    res.end(marker);
  });
  const originPort = await listen(origin);
  let gateway: Server | undefined;
  try {
    const now = Math.floor(Date.now() / 1000);
    const current: HnsCommunityAppHostAuthorityStateV1 = {
      variant: "community_app_v1",
      normalized_host: host,
      canonical_root: root,
      community_id: "fixture-community",
      app_host_activation_id: "fixture-activation",
      app_host_activation_generation: 1,
      app_host_activation_status: "active",
      activation_dns_zone_id: "fixture-zone",
      activation_dns_zone_generation: 1,
      activation_gateway_deployment_reference: deployment,
      route_binding_id: "fixture-route",
      route_binding_current: true,
      route_authority_kind: "operator_managed_route_v1",
      route_authority_reference: "fixture-authority",
      route_authority_generation: 1,
      route_authority_effective: true,
      dns_zone: {
        dns_zone_activation_id: "fixture-zone",
        dns_zone_activation_generation: 1,
        status: "active",
        stable_chain_delegation_matches: true,
        dnssec_ds_authenticates_zone: true,
        retained_zone_digest_matches: true,
        gateway_deployment_reference: deployment,
        gateway_certificate_spki_sha256: tls.spki,
        gateway_health: "healthy",
      },
    };
    const composition = makeHnsCommunityAppGatewayComposition(true, {
      profile_bytes: encodeHnsCommunityAppInteractiveGatewayProfileV3(),
      gateway_deployment_reference: deployment,
      solid_origin: `https://127.0.0.1:${originPort}`,
      solid_access_client_id: "fixture-only",
      solid_access_client_secret: "fixture-only",
      authority_source: { resolve: (name) => Effect.succeed(name === host ? current : null) },
      key_registry: makeStaticHnsForwarderKeyRegistryV1([
        {
          key_id: "fixture-key",
          key_bytes: crypto.getRandomValues(new Uint8Array(32)),
          signing_enabled: true,
          verify_not_before: now - 60,
          verify_not_after: now + 3600,
        },
      ]),
      clock: { nowUnixSeconds: () => Math.floor(Date.now() / 1000) },
      nonce_source: { next: () => randomUUID() },
      forwarder_limits: {
        max_body_bytes: HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PROFILE[11],
        freshness_window_seconds: 300,
        future_clock_skew_seconds: 5,
      },
      upstream_fetch: async (input) => {
        assert.equal(new URL(input.url).origin, `https://127.0.0.1:${originPort}`);
        const result = await get(
          originPort,
          host,
          tls.cert,
          tls.spki,
          Object.fromEntries(input.headers),
        );
        return new Response(result.body, { status: result.status });
      },
    });
    assert.ok(composition.enabled);
    gateway = createServer(tls, async (req, res) => {
      try {
        const socket = req.socket as TLSSocket;
        const response = await composition.service.handle({
          method: req.method ?? "GET",
          target: req.url ?? "/",
          body_bytes: new Uint8Array(),
          signal: AbortSignal.timeout(5000),
          header_fields: [
            ["host", req.headers.host ?? ""],
            [HNS_GATEWAY_EXTERNAL_SCHEME_HEADER, "https"],
            [HNS_GATEWAY_TLS_SNI_HEADER, socket.servername || ""],
          ],
        });
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(new Uint8Array(await response.arrayBuffer()));
      } catch {
        res.writeHead(500);
        res.end();
      }
    });
    const port = await listen(gateway);
    const runningGateway = gateway;
    return {
      spki: tls.spki,
      verify: async () => {
        const good = await get(port, host, tls.cert, tls.spki);
        assert.equal(good.status, 200);
        assert.equal(good.body, marker);
        const before = originCalls;
        const unknown = await get(port, `unclaimed.${root}`, tls.cert, tls.spki);
        assert.equal(unknown.status, 421);
        assert.equal(unknown.body, "");
        assert.equal(originCalls, before, "Unclaimed host reached the origin");
        await assert.rejects(get(port, host, tls.cert, "00".repeat(32)));
      },
      stop: async () => {
        await close(runningGateway);
        await close(origin);
      },
    };
  } catch (error) {
    if (gateway?.listening) await close(gateway);
    await close(origin);
    throw error;
  }
}

if (import.meta.main) {
  assert.deepEqual(process.argv.slice(2), ["--execute-local", "--with-chain"]);
  await runLocalAuthorityFixture(true, startFixtureGateway);
}
