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

  test("reports missing runtime secrets and root drift as failures", () => {
    const stagingBase = emptySnapshot("staging");
    const staging: InfisicalSnapshot = {
      ...stagingBase,
      secrets: {
        ...stagingBase.secrets,
        "/services/api-next": [
          "PIRATE_APP_JWT_PRIVATE_KEY",
          "PRIVY_APP_SECRET",
          "COMMUNITY_PURCHASE_FUNDING_RPC_URL",
        ],
        "/services/api-next/operator": [
          "CONTROL_PLANE_POSTGRES_ADMIN_URL",
          "CONTROL_PLANE_POSTGRES_RUNTIME_URL",
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
        "/services/api-next": ["PIRATE_APP_JWT_PRIVATE_KEY", "PRIVY_APP_SECRET"],
        "/services/api-next/operator": [
          "CONTROL_PLANE_POSTGRES_ADMIN_URL",
          "CONTROL_PLANE_POSTGRES_RUNTIME_URL",
        ],
      },
    };

    const report = auditInfisicalSnapshots([emptySnapshot("dev"), staging, prod]);
    expect(report.violations.map(({ name }) => name)).toEqual([
      "VERY_WEB_SEALING_KEY",
      "ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_KEY_ID",
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
          "VERY_WEB_SEALING_KEY",
          "ZKPASSPORT_VERIFIER_SHARED_SECRET",
          "ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_SECRET",
          "ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_KEY_ID",
        ],
        "/services/api-next/operator": [
          "CONTROL_PLANE_POSTGRES_ADMIN_URL",
          "CONTROL_PLANE_POSTGRES_RUNTIME_URL",
        ],
      },
    };
    const missingFolderReport = auditInfisicalSnapshots([missingFolderSnapshot]);
    expect(missingFolderReport.violations.map(({ kind, path }) => `${kind}:${path}`)).toContain(
      "missing-folder:/services/api-next/operator",
    );
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
