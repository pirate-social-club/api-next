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

  test("separates optional Spaces operator names by environment and rejects extra names", () => {
    const path = "/services/spaces-operator";
    const stagingNames = [
      "SPACES_REFRESH_OBSERVER_NODE_KEY",
      "SPACES_REFRESH_OBSERVER_POSTGRES_URL",
      "SPACES_YAHOO_ASSIGNMENT_PREPARE_TOKEN",
      "SPACES_YAHOO_CAPABILITY_REPORT_TOKEN",
      "SPACES_YAHOO_FUNDING_REPORT_TOKEN",
      "SPACES_YAHOO_REGISTRY_TOKEN",
    ];
    const productionNames = [
      "SPACES_BACKUP_AGE_RECIPIENT",
      "SPACES_BACKUP_B2_KEY_ID",
      "SPACES_BACKUP_B2_APPLICATION_KEY",
    ];
    for (const [environment, names, otherNames] of [
      ["staging", stagingNames, productionNames],
      ["prod", productionNames, stagingNames],
    ] as const) {
      const base = emptySnapshot(environment);
      const snapshot = {
        ...base,
        folders: [...base.folders, path],
        secrets: { ...base.secrets, [path]: names },
      };
      expect(auditInfisicalSnapshots([snapshot]).violations.filter((v) => v.path === path)).toEqual(
        [],
      );
      const wrongEnvironment = auditInfisicalSnapshots([
        { ...snapshot, secrets: { ...base.secrets, [path]: otherNames } },
      ]);
      expect(wrongEnvironment.violations.filter((v) => v.path === path)).toHaveLength(
        otherNames.length,
      );
      for (const wrongPath of ["/", "/services/api-next", "/services/api-next/operator"] as const) {
        const wrong = auditInfisicalSnapshots([
          { ...base, secrets: { ...base.secrets, [wrongPath]: names } },
        ]);
        expect(wrong.violations.filter((v) => v.name && names.includes(v.name))).toHaveLength(
          names.length,
        );
      }
      expect(auditInfisicalSnapshots([base]).violations.filter((v) => v.path === path)).toEqual([]);
      const unknown = auditInfisicalSnapshots([
        { ...snapshot, secrets: { ...base.secrets, [path]: ["UNDECLARED_OPERATOR_KEY"] } },
      ]);
      expect(unknown.violations.filter((v) => v.path === path)).toEqual([
        { environment, path, kind: "unexpected-secret", name: "UNDECLARED_OPERATOR_KEY" },
      ]);
    }
    const dev = emptySnapshot("dev");
    expect(
      auditInfisicalSnapshots([{ ...dev, folders: [...dev.folders, path] }]).violations.filter(
        (v) => v.path === path,
      ),
    ).toEqual([{ environment: "dev", path, kind: "unexpected-folder" }]);
  });
});
