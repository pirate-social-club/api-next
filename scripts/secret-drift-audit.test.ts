import { describe, expect, test } from "bun:test";

import {
  type AuditTarget,
  auditCloudflareTargets,
  declaredBindingsForEnvironment,
  parseJsonc,
} from "./secret-drift-audit";

describe("secret drift audit", () => {
  test("parses JSONC comments, trailing commas, and URLs inside strings", () => {
    const parsed = parseJsonc<{ env: { staging: { vars: { endpoint: string } } } }>(`
      {
        // This comment must be ignored.
        "env": {
          "staging": {
            "vars": {
              "endpoint": "https://example.test/api//v1",
            },
          },
        },
      }
    `);

    expect(parsed.env.staging.vars.endpoint).toBe("https://example.test/api//v1");
  });

  test("uses named-environment vars and non-inherited required secrets", () => {
    const config = parseJsonc<{
      name: string;
      vars: Record<string, string>;
      secrets: { required: string[] };
      env: Record<string, unknown>;
    }>(`
      {
        "name": "fixture-worker",
        "vars": { "ROOT_VAR": "development" },
        "secrets": { "required": ["ROOT_SECRET"] },
        "env": {
          "staging": {
            "name": "fixture-worker-staging",
            "vars": { "STAGING_VAR": "staging" },
            "secrets": { "required": ["STAGING_SECRET"] },
          },
        },
      }
    `);

    const declared = declaredBindingsForEnvironment(config, "staging");
    expect(declared.workerName).toBe("fixture-worker-staging");
    expect(declared.vars).toEqual(["ROOT_VAR", "STAGING_VAR"]);
    expect(declared.secrets).toEqual(["STAGING_SECRET"]);
  });

  test("detects collisions, installed orphans, and missing declared secrets", () => {
    const target: AuditTarget = {
      workerId: "fixture",
      environment: "staging",
      workerName: "fixture-worker-staging",
      declared: {
        vars: ["PUBLIC_VALUE"],
        secrets: ["REQUIRED_SECRET", "MISSING_SECRET"],
      },
      remote: { kind: "present", names: ["PUBLIC_VALUE", "REQUIRED_SECRET", "ORPHAN_SECRET"] },
    };

    const report = auditCloudflareTargets([target], []);
    expect(report.acceptedDrift).toEqual([]);
    expect(report.violations.map(({ kind, name }) => `${kind}:${name}`)).toEqual([
      "installed-secret-undeclared:ORPHAN_SECRET",
      "var-secret-collision:PUBLIC_VALUE",
      "declared-secret-not-installed:MISSING_SECRET",
    ]);
  });

  test("accepts only explicitly allowlisted missing Workers", () => {
    const target: AuditTarget = {
      workerId: "fixture",
      environment: "production",
      workerName: "fixture-worker-production",
      declared: { vars: [], secrets: [] },
      remote: { kind: "missing" },
    };

    const report = auditCloudflareTargets(
      [target],
      [
        {
          workerId: "fixture",
          environment: "production",
          kind: "worker-not-deployed",
          reason: "Fixture intentionally has no production deployment.",
        },
      ],
    );
    expect(report.violations).toEqual([]);
    expect(report.acceptedDrift).toHaveLength(1);
    expect(report.acceptedDrift[0]?.reason).toContain("intentionally");

    expect(auditCloudflareTargets([target], []).violations).toHaveLength(1);
  });
});
