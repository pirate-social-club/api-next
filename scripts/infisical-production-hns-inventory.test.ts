import { describe, expect, test } from "bun:test";
import {
  auditInfisicalSnapshots,
  EXPECTED_INFISICAL_FOLDERS,
  INFISICAL_POLICIES,
  type InfisicalSnapshot,
} from "./infisical-secret-drift-audit";

const emptySnapshot = (environment: InfisicalSnapshot["environment"]): InfisicalSnapshot => ({
  environment,
  folders: EXPECTED_INFISICAL_FOLDERS[environment],
  secrets: {
    "/": [],
    "/agents": [],
    "/agents/codex": [],
    "/services/api-next": [],
    "/services/api-next/operator": [],
  },
});

describe("production HNS operator inventory boundary", () => {
  test("keeps accepted production HNS credentials optional and in operator custody", () => {
    const names = [
      "HNS_AUTHORITY_HSD_AUTHORIZATION",
      "HNS_AUTHORITY_SECONDARY_PDNS_API_KEY",
      "HNS_PRODUCTION_MAINNET_READER_CLIENT_KEY",
      "HNS_PRODUCTION_POSTGRES_ADMIN_URL",
      "HNS_PRODUCTION_POSTGRES_GATEWAY_URL",
      "HNS_PRODUCTION_POSTGRES_PROVISIONER_URL",
      "HNS_PRODUCTION_POSTGRES_RUNTIME_URL",
    ];
    for (const name of names) {
      for (const environment of ["dev", "staging", "prod"] as const) {
        for (const path of ["/", "/services/api-next", "/services/api-next/operator"] as const) {
          const base = emptySnapshot(environment);
          const snapshot = { ...base, secrets: { ...base.secrets, [path]: [name] } };
          const violations = auditInfisicalSnapshots([snapshot]).violations.filter(
            (violation) => violation.name === name,
          );
          expect(violations).toEqual(
            environment === "prod" && path === "/services/api-next/operator"
              ? []
              : [{ environment, path, kind: "unexpected-secret", name }],
          );
        }
      }
      const policy = INFISICAL_POLICIES.find(
        ({ environment, path }) => environment === "prod" && path === "/services/api-next/operator",
      );
      expect(policy?.requiredNames).not.toContain(name);
    }
  });
});
