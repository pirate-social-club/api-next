import { describe, expect, test } from "bun:test";
import {
  auditInfisicalSnapshots,
  INFISICAL_POLICIES,
  type InfisicalSnapshot,
} from "./infisical-secret-drift-audit.ts";

describe("retained reward custody inventory", () => {
  test("admits retained reward custody keys only as an optional staging runtime secret", () => {
    const name = "MEGAPOT_RETAINED_CUSTODY_PRIVATE_KEYS";
    for (const environment of ["dev", "staging", "prod"] as const) {
      const base: InfisicalSnapshot = {
        environment,
        folders: ["/services", "/services/api-next", "/services/api-next/operator"],
        secrets: {},
      };
      for (const path of ["/", "/services/api-next", "/services/api-next/operator"] as const) {
        const snapshot = { ...base, secrets: { ...base.secrets, [path]: [name] } };
        const violations = auditInfisicalSnapshots([snapshot]).violations.filter(
          (violation) => violation.name === name,
        );
        expect(violations).toEqual(
          environment === "staging" && path === "/services/api-next"
            ? []
            : [{ environment, path, kind: "unexpected-secret", name }],
        );
      }
    }
    const policy = INFISICAL_POLICIES.find(
      ({ environment, path }) => environment === "staging" && path === "/services/api-next",
    );
    expect(policy?.allowedNames).toContain(name);
    expect(policy?.requiredNames).not.toContain(name);
  });
});
