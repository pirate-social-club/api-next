import { expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { makeSessionCrypto } from "@pirate/platform-cf/session-crypto";
import { Client } from "pg";
import { makeHttpWorkerTestBindings } from "./composition.test-fixtures.ts";
import { prepareReadyImport } from "./hns-community-activation.pg-fixture.ts";

/**
 * Two authenticated black-box requests through the real production Worker:
 * a complete, forwarded activation configuration observes the fake HSD
 * boundary and commits lifecycle and existing effects together, and an HSD
 * transport failure is reported as a provider failure with nothing committed.
 */

// The composition module resolves its Durable Object imports at module load;
// the process-global mock must be registered first.
mock.module("cloudflare:workers", () => ({
  DurableObject: class DurableObject {},
}));
const { createProductionHttpWorker } = await import("./composition.ts");

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw new Error("Postgres required");
const pgTest = url ? test : test.skip;

const issuer = "api-next-session-test";
const audience = "api-next-browser-test";
const scope = "api-next-browser-session-test";

function toPem(label: "PRIVATE KEY" | "PUBLIC KEY", bytes: ArrayBuffer): string {
  const base64 = Buffer.from(bytes).toString("base64");
  const lines = base64.match(/.{1,64}/gu)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

async function workerBindingsFor(
  connectionString: string,
  input: {
    readonly rpcUrl: string;
    readonly enabled: boolean;
    readonly privateKeyPem: string;
    readonly publicKeyPem: string;
  },
) {
  const configured = await makeHttpWorkerTestBindings(connectionString);
  return {
    ...configured,
    PIRATE_APP_JWT_PRIVATE_KEY: input.privateKeyPem,
    PIRATE_APP_JWT_PUBLIC_KEY: input.publicKeyPem,
    PIRATE_APP_JWT_ISSUER: issuer,
    PIRATE_APP_JWT_AUDIENCE: audience,
    PIRATE_APP_JWT_SCOPE: scope,
    HNS_OWNERSHIP_ENABLED: "true",
    HNS_OWNERSHIP_CONFIGURATION_REFERENCE: "hns-owner-staging",
    HNS_OWNERSHIP_CONFIGURATION_VERSION: "hns-owner-config-v1",
    HNS_OWNER_VERIFIER: {
      fetch: async () => {
        throw new Error("owner verifier must not run during activation");
      },
    },
    HNS_ACTIVATION_CURRENT_VIEW_ENABLED: "true",
    HNS_AUTHORITY_HSD_RPC_URL: input.rpcUrl,
    HNS_AUTHORITY_HSD_AUTHORIZATION: "Basic fixture",
    HNS_AUTHORITY_CHAIN_NETWORK: "regtest",
    HNS_AUTHORITY_CHAIN_GENESIS_BLOCK_HASH: `${"0".repeat(63)}1`,
    HNS_AUTHORITY_TREE_INTERVAL_BLOCKS: "36",
    HNS_AUTHORITY_SAFE_CONFIRMATIONS: "12",
    HNS_AUTHORITY_MAXIMUM_TIP_AGE_SECONDS: "86400",
    HNS_AUTHORITY_MAXIMUM_FUTURE_TIP_SECONDS: "3600",
  };
}

async function prepare(name: string): Promise<{
  readonly ready: Awaited<ReturnType<typeof prepareReadyImport>>;
  readonly cleanup: () => Promise<void>;
}> {
  if (url === undefined) throw new Error("Postgres required");
  const database = `hns_worker_${name}_${randomUUID().replaceAll("-", "")}`;
  const control = new Client({ connectionString: url });
  await control.connect();
  await control.query(`CREATE DATABASE "${database}"`);
  const databaseUrl = (() => {
    const parsed = new URL(url);
    parsed.pathname = `/${database}`;
    return parsed.toString();
  })();
  const ready = await prepareReadyImport({ connectionString: databaseUrl, schema: "api_next" });
  await ready.admin.query(
    "INSERT INTO account_minimum_age_attestations(account_id,version,minimum_age,affirmed) VALUES($1,'minimum-age-attestation-v1',16,true)",
    [ready.actor],
  );
  return {
    ready,
    cleanup: async () => {
      await ready.cleanup();
      await control.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await control.end();
    },
  };
}

pgTest(
  "the forwarded configuration observes and activates through the production worker",
  async () => {
    const { ready, cleanup } = await prepare("match");
    try {
      const pair = (await crypto.subtle.generateKey(
        {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2_048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["sign", "verify"],
      )) as CryptoKeyPair;
      const privateKeyPem = toPem(
        "PRIVATE KEY",
        (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
      );
      const publicKeyPem = toPem(
        "PUBLIC KEY",
        (await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer,
      );
      const worker = await createProductionHttpWorker(
        await workerBindingsFor(ready.connectionString, {
          rpcUrl: ready.hsd.url,
          enabled: true,
          privateKeyPem,
          publicKeyPem,
        }),
      );
      const sessionCrypto = await makeSessionCrypto({
        privateKeyPem,
        publicKeyPem,
        issuer,
        audience,
        defaultScope: scope,
        defaultTtlSeconds: 3_600,
      });
      const token = await sessionCrypto.sign({ sub: ready.actor, scope });
      ready.hsd.setRecords(ready.planRecords);
      const response = await worker.fetch(
        new Request(
          `https://worker.test/communities/${ready.community}/hns-root-imports/${ready.sessionId}/activate`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              expected_revision: ready.revision,
              idempotency_key: "activate-worker",
              publish_plan_sha256: ready.publishPlanSha256,
              readiness_result_sha256: ready.readinessResultSha256,
              acknowledged_complete_resource_replacement: true,
            }),
          },
        ),
      );
      expect(response.status).toBe(201);
      // Only an observation over the forwarded HSD boundary can qualify.
      expect(ready.hsd.calls).toContain("getnameresource");
      const lifecycle = await ready.admin.query<{ phase: string }>(
        "SELECT phase FROM hns_root_import_lifecycle WHERE root_import_session_id=$1",
        [ready.sessionId],
      );
      expect(lifecycle.rows[0]?.phase).toBe("activated");
      const session = await ready.admin.query<{ status: string }>(
        "SELECT status FROM hns_root_import_sessions WHERE root_import_session_id=$1",
        [ready.sessionId],
      );
      expect(session.rows[0]?.status).toBe("activated");
      const operations = await ready.admin.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM hns_root_import_activation_operations WHERE root_import_session_id=$1",
        [ready.sessionId],
      );
      expect(operations.rows[0]?.count).toBe(1);
    } finally {
      await cleanup();
    }
  },
  300_000,
);

pgTest(
  "an HSD transport failure is a provider failure with nothing committed",
  async () => {
    const { ready, cleanup } = await prepare("provider");
    try {
      const pair = (await crypto.subtle.generateKey(
        {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2_048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["sign", "verify"],
      )) as CryptoKeyPair;
      const privateKeyPem = toPem(
        "PRIVATE KEY",
        (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
      );
      const publicKeyPem = toPem(
        "PUBLIC KEY",
        (await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer,
      );
      const worker = await createProductionHttpWorker(
        await workerBindingsFor(ready.connectionString, {
          rpcUrl: ready.hsd.url,
          enabled: true,
          privateKeyPem,
          publicKeyPem,
        }),
      );
      const sessionCrypto = await makeSessionCrypto({
        privateKeyPem,
        publicKeyPem,
        issuer,
        audience,
        defaultScope: scope,
        defaultTtlSeconds: 3_600,
      });
      const token = await sessionCrypto.sign({ sub: ready.actor, scope });
      ready.hsd.setFailure("transport");
      const response = await worker.fetch(
        new Request(
          `https://worker.test/communities/${ready.community}/hns-root-imports/${ready.sessionId}/activate`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              expected_revision: ready.revision,
              idempotency_key: "activate-worker-provider",
              publish_plan_sha256: ready.publishPlanSha256,
              readiness_result_sha256: ready.readinessResultSha256,
              acknowledged_complete_resource_replacement: true,
            }),
          },
        ),
      );
      expect(response.status).toBe(502);
      expect((await response.json()) as unknown).toMatchObject({
        error: { code: "provider_unavailable" },
      });
      const lifecycle = await ready.admin.query<{ phase: string }>(
        "SELECT phase FROM hns_root_import_lifecycle WHERE root_import_session_id=$1",
        [ready.sessionId],
      );
      expect(lifecycle.rows[0]?.phase).toBe("ready");
      const session = await ready.admin.query<{ status: string }>(
        "SELECT status FROM hns_root_import_sessions WHERE root_import_session_id=$1",
        [ready.sessionId],
      );
      expect(session.rows[0]?.status).toBe("ready");
      const operations = await ready.admin.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM hns_root_import_activation_operations WHERE root_import_session_id=$1",
        [ready.sessionId],
      );
      expect(operations.rows[0]?.count).toBe(0);
    } finally {
      await cleanup();
    }
  },
  300_000,
);
