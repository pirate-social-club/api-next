import { describe, expect, test } from "bun:test";

import {
  auditInfisicalSnapshots,
  fetchInfisicalSnapshots,
  type InfisicalSnapshot,
  listInfisicalSecretNames,
  parseInfisicalFolderPaths,
  parseInfisicalSecretNames,
} from "./infisical-secret-drift-audit";

const emptySnapshot = (environment: InfisicalSnapshot["environment"]): InfisicalSnapshot => ({
  environment,
  folders:
    environment === "dev" ? [] : ["/services", "/services/api-next", "/services/api-next/operator"],
  secrets: {
    "/": [],
    "/services/api-next": [],
    "/services/api-next/operator": [],
  },
});

describe("Infisical secret drift audit", () => {
  test("extracts names and folder paths without exposing secret values", () => {
    expect(
      parseInfisicalSecretNames({
        secrets: [
          { secretKey: "B", secretValue: "must-not-be-used" },
          { secretKey: "A", secretValue: "must-not-be-used" },
        ],
      }),
    ).toEqual(["A", "B"]);
    expect(parseInfisicalFolderPaths({ folders: [{ relativePath: "/services/" }] })).toEqual([
      "/services",
    ]);
  });

  test("enforces enabled staging and production runtime completeness", () => {
    const stagingBase = emptySnapshot("staging");
    const staging: InfisicalSnapshot = {
      ...stagingBase,
      secrets: {
        ...stagingBase.secrets,
        "/services/api-next": [
          "PIRATE_APP_JWT_PRIVATE_KEY",
          "PRIVY_APP_SECRET",
          "COMMUNITY_PURCHASE_FUNDING_RPC_URL",
          "MEGAPOT_COMMITMENT_PUBLIC_ORIGIN",
          "MEGAPOT_CUSTODY_PRIVATE_KEY",
          "MEGAPOT_V2_RPC_URL",
        ],
        "/services/api-next/operator": [
          "CONTROL_PLANE_POSTGRES_ADMIN_URL",
          "CONTROL_PLANE_POSTGRES_RUNTIME_URL",
          "MEGAPOT_REFERRER_PRIVATE_KEY",
        ],
      },
    };

    const prodBase = emptySnapshot("prod");
    const prod: InfisicalSnapshot = {
      ...prodBase,
      secrets: {
        ...prodBase.secrets,
        "/": [
          "API_NEXT_ALERT_EMAIL_TOKEN",
          "API_NEXT_ALERT_EMAIL_URL",
          "API_NEXT_ALERT_WEBHOOK_TOKEN",
          "API_NEXT_ALERT_WEBHOOK_URL",
        ],
        "/services/api-next": [
          "PIRATE_APP_JWT_PRIVATE_KEY",
          "PRIVY_APP_SECRET",
          "MEGAPOT_V2_RPC_URL",
        ],
        "/services/api-next/operator": [
          "CONTROL_PLANE_POSTGRES_ADMIN_URL",
          "CONTROL_PLANE_POSTGRES_RUNTIME_URL",
        ],
      },
    };

    const report = auditInfisicalSnapshots([emptySnapshot("dev"), staging, prod]);
    expect(report.violations.map(({ name }) => name)).toEqual([
      "VERY_WEB_SEALING_KEY",
      "ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_SECRET",
      "ZKPASSPORT_VERIFIER_SHARED_SECRET",
      "API_NEXT_ALERT_EMAIL_TOKEN",
      "API_NEXT_ALERT_EMAIL_URL",
      "API_NEXT_ALERT_WEBHOOK_TOKEN",
      "API_NEXT_ALERT_WEBHOOK_URL",
      "COMMUNITY_PURCHASE_FUNDING_RPC_URL",
    ]);
    expect(report.acceptedDrift).toHaveLength(0);
  });

  test("detects unexpected folders and stored names", () => {
    const stagingBase = emptySnapshot("staging");
    const staging: InfisicalSnapshot = {
      ...stagingBase,
      folders: [...stagingBase.folders, "/services/hns-verifier"],
      secrets: { ...stagingBase.secrets, "/": ["UNOWNED_SECRET"] },
    };

    const report = auditInfisicalSnapshots([staging]);
    expect(
      report.violations.map(({ kind, name, path }) => `${kind}:${path}:${name ?? ""}`),
    ).toContain("unexpected-folder:/services/hns-verifier:");
    expect(
      report.violations.map(({ kind, name, path }) => `${kind}:${path}:${name ?? ""}`),
    ).toContain("unexpected-secret:/:UNOWNED_SECRET");

    const missingFolderSnapshot: InfisicalSnapshot = {
      ...emptySnapshot("staging"),
      folders: ["/services", "/services/api-next"],
      secrets: {
        "/": [],
        "/services/api-next": [
          "PIRATE_APP_JWT_PRIVATE_KEY",
          "PRIVY_APP_SECRET",
          "COMMUNITY_PURCHASE_FUNDING_RPC_URL",
          "MEGAPOT_COMMITMENT_PUBLIC_ORIGIN",
          "MEGAPOT_CUSTODY_PRIVATE_KEY",
          "MEGAPOT_V2_RPC_URL",
          "VERY_WEB_SEALING_KEY",
          "ZKPASSPORT_VERIFIER_SHARED_SECRET",
          "ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_SECRET",
        ],
        "/services/api-next/operator": [
          "CONTROL_PLANE_POSTGRES_ADMIN_URL",
          "CONTROL_PLANE_POSTGRES_RUNTIME_URL",
          "MEGAPOT_REFERRER_PRIVATE_KEY",
        ],
      },
    };
    const missingFolderReport = auditInfisicalSnapshots([missingFolderSnapshot]);
    expect(missingFolderReport.violations.map(({ kind, path }) => `${kind}:${path}`)).toContain(
      "missing-folder:/services/api-next/operator",
    );
  });

  test("allows staging media runtime provisioning names without requiring them", async () => {
    const stagingBase = emptySnapshot("staging");
    const stagingWithoutProvisioning: InfisicalSnapshot = {
      ...stagingBase,
      secrets: {
        ...stagingBase.secrets,
        "/services/api-next": [
          "PIRATE_APP_JWT_PRIVATE_KEY",
          "PRIVY_APP_SECRET",
          "COMMUNITY_PURCHASE_FUNDING_RPC_URL",
          "MEGAPOT_COMMITMENT_PUBLIC_ORIGIN",
          "MEGAPOT_CUSTODY_PRIVATE_KEY",
          "MEGAPOT_V2_RPC_URL",
          "VERY_WEB_SEALING_KEY",
          "ZKPASSPORT_VERIFIER_SHARED_SECRET",
          "ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_SECRET",
        ],
        "/services/api-next/operator": [
          "CONTROL_PLANE_POSTGRES_ADMIN_URL",
          "CONTROL_PLANE_POSTGRES_RUNTIME_URL",
          "MEGAPOT_REFERRER_PRIVATE_KEY",
        ],
      },
    };
    expect(auditInfisicalSnapshots([stagingWithoutProvisioning]).violations).toEqual([]);

    const stagingWithProvisioning: InfisicalSnapshot = {
      ...stagingWithoutProvisioning,
      secrets: {
        ...stagingWithoutProvisioning.secrets,
        "/services/api-next": [
          ...stagingWithoutProvisioning.secrets["/services/api-next"],
          "TRANSLOADIT_AUTH_KEY",
          "TRANSLOADIT_AUTH_SECRET",
          "ACRCLOUD_ACCESS_KEY",
          "ACRCLOUD_ACCESS_SECRET",
          "ELEVENLABS_API_KEY",
          "FILEBASE_IPFS_TOKEN",
          "DATA_REGISTRATION_STAGING_PRIVATE_KEY",
          "MEDIA_CLASSIFIER_API_KEY",
          "MEDIA_INGRESS_R2_PRESIGN_ACCESS_KEY_ID",
          "MEDIA_INGRESS_R2_PRESIGN_SECRET_ACCESS_KEY",
          "OPENAI_API_KEY",
        ],
      },
    };
    expect(auditInfisicalSnapshots([stagingWithProvisioning]).violations).toEqual([]);

    const httpWorkerConfig = await Bun.file("apps/http-worker/wrangler.jsonc").text();
    const processorWorkerConfig = await Bun.file("apps/media-processor-worker/wrangler.jsonc")
      .text()
      .catch(() => "");
    for (const name of [
      "MEDIA_INGRESS_R2_PRESIGN_ACCESS_KEY_ID",
      "MEDIA_INGRESS_R2_PRESIGN_SECRET_ACCESS_KEY",
    ]) {
      expect(httpWorkerConfig).toContain(name);
      expect(processorWorkerConfig).not.toContain(name);
    }

    const retiredR2Names: InfisicalSnapshot = {
      ...stagingWithProvisioning,
      secrets: {
        ...stagingWithProvisioning.secrets,
        "/services/api-next/operator": [
          ...stagingWithProvisioning.secrets["/services/api-next/operator"],
          "R2_SEAL_PROBE_ACCESS_KEY_ID",
          "R2_SEAL_PROBE_SECRET_ACCESS_KEY",
        ],
      },
    };
    expect(auditInfisicalSnapshots([retiredR2Names]).violations).toEqual([
      {
        environment: "staging",
        path: "/services/api-next/operator",
        kind: "unexpected-secret",
        name: "R2_SEAL_PROBE_ACCESS_KEY_ID",
      },
      {
        environment: "staging",
        path: "/services/api-next/operator",
        kind: "unexpected-secret",
        name: "R2_SEAL_PROBE_SECRET_ACCESS_KEY",
      },
    ]);
  });

  test("forces the REST query to hide values", async () => {
    let requestedUrl = "";
    const names = await listInfisicalSecretNames({
      baseUrl: "https://infisical.example/api",
      projectId: "project",
      environment: "staging",
      path: "/services/api-next",
      token: "test-token",
      request: async (url, init) => {
        requestedUrl = url;
        expect(init.headers).toMatchObject({ authorization: "Bearer test-token" });
        return new Response(
          JSON.stringify({ secrets: [{ secretKey: "SAFE_NAME", secretValue: "ignored" }] }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    });

    const query = new URL(requestedUrl).searchParams;
    expect(query.get("viewSecretValue")).toBe("false");
    expect(query.get("recursive")).toBe("false");
    expect(names).toEqual(["SAFE_NAME"]);
  });

  test("does not query secret paths under absent folders", async () => {
    const requestedUrls: string[] = [];
    const snapshots = await fetchInfisicalSnapshots({
      baseUrl: "https://infisical.example/api",
      projectId: "project",
      token: "test-token",
      request: async (url) => {
        requestedUrls.push(url);
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("/folders")) {
          const environment = parsed.searchParams.get("environment");
          return new Response(
            JSON.stringify({
              folders:
                environment === "dev"
                  ? []
                  : [
                      { relativePath: "/services" },
                      { relativePath: "/services/api-next" },
                      { relativePath: "/services/api-next/operator" },
                    ],
            }),
          );
        }
        return new Response(JSON.stringify({ secrets: [] }));
      },
    });

    expect(snapshots).toHaveLength(3);
    expect(
      requestedUrls.filter((url) => url.includes("/v4/secrets") && url.includes("environment=dev")),
    ).toHaveLength(1);
    expect(
      requestedUrls.some(
        (url) =>
          url.includes("environment=dev") && url.includes("secretPath=%2Fservices%2Fapi-next"),
      ),
    ).toBe(false);
  });
});
