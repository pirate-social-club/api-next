import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  auditInfisicalSnapshots,
  INFISICAL_POLICIES,
  type InfisicalEnvironment,
  type InfisicalPath,
  type InfisicalSnapshot,
} from "./infisical-secret-drift-audit";
import {
  declaredBindingsForEnvironment,
  parseJsonc,
  type WranglerConfig,
} from "./secret-drift-audit";

const fixtureNames = [
  "PRODUCTION_E2E_CREATOR_EMAIL",
  "PRODUCTION_E2E_CREATOR_OTP",
  "PRODUCTION_E2E_PARTICIPANT_EMAIL",
  "PRODUCTION_E2E_PARTICIPANT_OTP",
];

function snapshot(
  environment: InfisicalEnvironment,
  path: InfisicalPath,
  names: readonly string[],
): InfisicalSnapshot {
  return {
    environment,
    folders:
      environment === "dev"
        ? ["/agents", "/agents/codex"]
        : ["/services", "/services/api-next", "/services/api-next/operator"],
    secrets: {
      "/": [],
      "/agents": [],
      "/agents/codex": [],
      "/services/api-next": [],
      "/services/api-next/operator": [],
      [path]: names,
    },
  };
}

describe("production Palm secret boundaries", () => {
  test("admits optional production provisioning secrets only in their owned paths", () => {
    const prodBase = snapshot("prod", "/services/api-next", []);
    const requiredRuntimeNames = [
      "PIRATE_APP_JWT_PRIVATE_KEY",
      "PRIVY_APP_SECRET",
      "COMMUNITY_PURCHASE_FUNDING_RPC_URL",
      "HNS_EDGE_ALERT_TOKEN",
      "VERY_WEB_SEALING_KEY",
    ];
    const withoutSigner: InfisicalSnapshot = {
      ...prodBase,
      secrets: {
        ...prodBase.secrets,
        "/services/api-next": requiredRuntimeNames,
        "/services/api-next/operator": [
          "CONTROL_PLANE_POSTGRES_ADMIN_URL",
          "CONTROL_PLANE_POSTGRES_RUNTIME_URL",
        ],
      },
    };
    expect(auditInfisicalSnapshots([withoutSigner]).violations).toEqual([]);

    const withSigner: InfisicalSnapshot = {
      ...withoutSigner,
      secrets: {
        ...withoutSigner.secrets,
        "/services/api-next": [
          ...requiredRuntimeNames,
          "DATA_REGISTRATION_PRODUCTION_AENEID_PRIVATE_KEY",
          "FILEBASE_IPFS_TOKEN",
          "ACRCLOUD_ACCESS_KEY",
          "ACRCLOUD_ACCESS_SECRET",
          "ELEVENLABS_API_KEY",
          "OPENAI_API_KEY",
          "OPENROUTER_API_KEY",
          "MEDIA_INGRESS_R2_PRESIGN_ACCESS_KEY_ID",
          "MEDIA_INGRESS_R2_PRESIGN_SECRET_ACCESS_KEY",
          "QENCODE_API_KEY",
          "CLOUDCONVERT_RENDER_API_KEY",
          "VIDEO_WORKFLOW_READ_TOKEN",
          "VIDEO_STREAM_API_TOKEN",
          "VIDEO_STREAM_SIGNING_JWK_BASE64",
          "VIDEO_PLAYBACK_SOURCE_HMAC_BASE64",
          "SONG_PLAYBACK_R2_ACCESS_KEY_ID",
          "SONG_PLAYBACK_R2_SECRET_ACCESS_KEY",
          "SONG_PLAYBACK_SOURCE_HMAC_BASE64",
        ],
      },
    };
    expect(auditInfisicalSnapshots([withSigner]).violations).toEqual([]);

    const monitorNames = ["HNS_OPERATOR_ALERT_WEBHOOK_URL", "HNS_OPERATOR_MONITOR_POSTGRES_URL"];
    expect(
      auditInfisicalSnapshots([
        {
          ...withoutSigner,
          secrets: {
            ...withoutSigner.secrets,
            "/services/api-next/operator": [
              ...withoutSigner.secrets["/services/api-next/operator"],
              ...monitorNames,
            ],
          },
        },
      ]).violations,
    ).toEqual([]);
    expect(
      auditInfisicalSnapshots([
        {
          ...withoutSigner,
          secrets: {
            ...withoutSigner.secrets,
            "/services/api-next": [...requiredRuntimeNames, ...monitorNames],
          },
        },
      ]).violations,
    ).toEqual(
      monitorNames.map((name) => ({
        environment: "prod",
        path: "/services/api-next",
        kind: "unexpected-secret",
        name,
      })),
    );
  });

  test("requires the sealing key only in enabled staging and production runtime custody", () => {
    const name = "VERY_WEB_SEALING_KEY";
    for (const policy of INFISICAL_POLICIES) {
      const { environment, path } = policy;
      const admitted = environment !== "dev" && path === "/services/api-next";
      const report = auditInfisicalSnapshots([snapshot(environment, path, [name])]);
      expect(
        report.violations.filter(
          (violation) => violation.kind === "unexpected-secret" && violation.name === name,
        ),
      ).toEqual(admitted ? [] : [{ environment, path, kind: "unexpected-secret", name }]);
      expect(policy.allowedNames.includes(name)).toBe(admitted);
      expect(policy.requiredNames.includes(name)).toBe(admitted);
    }
    expect(
      auditInfisicalSnapshots([snapshot("prod", "/services/api-next", [])]).violations,
    ).toContainEqual({
      environment: "prod",
      path: "/services/api-next",
      kind: "missing-required-secret",
      name,
    });
  });

  test("admits optional production browser identities only in production operator custody", () => {
    for (const policy of INFISICAL_POLICIES) {
      const { environment, path } = policy;
      const admitted = environment === "prod" && path === "/services/api-next/operator";
      const report = auditInfisicalSnapshots([snapshot(environment, path, fixtureNames)]);
      expect(
        report.violations.filter(({ name }) => name !== undefined && fixtureNames.includes(name)),
      ).toEqual(
        admitted
          ? []
          : fixtureNames.map((name) => ({ environment, path, kind: "unexpected-secret", name })),
      );
      for (const name of fixtureNames) {
        expect(policy.allowedNames.includes(name)).toBe(admitted);
        expect(policy.requiredNames).not.toContain(name);
      }
    }
  });

  test("keeps public ZK configuration out of all Infisical secret paths", () => {
    const names = [
      "VERY_WEB_APP_ID",
      "VERY_WEB_API_URL",
      "VERY_WEB_VERIFY_URL",
      "VERY_WEB_BRIDGE_API_URL",
    ];
    for (const { environment, path } of INFISICAL_POLICIES) {
      const report = auditInfisicalSnapshots([snapshot(environment, path, names)]);
      expect(
        report.violations
          .filter(
            ({ kind, name }) =>
              kind === "unexpected-secret" && name !== undefined && names.includes(name),
          )
          .map(({ name }) => name)
          .sort(),
      ).toEqual([...names].sort());
    }
  });

  test("declares sealing only for HTTP and never declares operator fixtures in any Worker", async () => {
    const root = new URL("../", import.meta.url);
    const checked: string[] = [];
    for await (const path of new Bun.Glob("apps/*/wrangler.jsonc").scan({ cwd: root.pathname })) {
      const config = parseJsonc<WranglerConfig & { env?: Record<string, unknown> }>(
        readFileSync(new URL(path, root), "utf8"),
      );
      for (const name of fixtureNames) {
        expect(JSON.stringify(config)).not.toContain(JSON.stringify(name));
      }
      for (const environment of ["staging", "production"] as const) {
        if (config.env?.[environment] === undefined) continue;
        checked.push(`${path}:${environment}`);
        const declared = declaredBindingsForEnvironment(config, environment);
        expect(declared.secrets.includes("VERY_WEB_SEALING_KEY")).toBe(
          path === "apps/http-worker/wrangler.jsonc",
        );
        expect(declared.vars).not.toContain("VERY_WEB_SEALING_KEY");
        for (const name of fixtureNames) {
          expect(declared.vars).not.toContain(name);
          expect(declared.secrets).not.toContain(name);
        }
      }
    }
    expect(checked).toContain("apps/http-worker/wrangler.jsonc:production");
    expect(checked).toContain("apps/jobs-worker/wrangler.jsonc:production");
  });
});
