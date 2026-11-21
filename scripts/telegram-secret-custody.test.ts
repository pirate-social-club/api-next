import { expect, test } from "bun:test";
import { auditInfisicalSnapshots } from "./infisical-secret-drift-audit";

test("admits Telegram wrapping keys only at admitted staging and production runtime custody paths", () => {
  const name = "TELEGRAM_SECRETS_JSON";
  for (const environment of ["dev", "staging", "prod"] as const) {
    for (const path of ["/services/api-next", "/services/api-next/operator"] as const) {
      const report = auditInfisicalSnapshots([
        {
          environment,
          folders: ["/services", "/services/api-next", "/services/api-next/operator"],
          secrets: { [path]: [name] },
        },
      ]);
      const unexpected = report.violations.some(
        (entry) => entry.kind === "unexpected-secret" && entry.name === name,
      );
      expect(unexpected).toBe(
        (environment !== "staging" && environment !== "prod") || path !== "/services/api-next",
      );
    }
  }
});

test("does not require Telegram wrapping keys in the production runtime inventory", () => {
  const report = auditInfisicalSnapshots([
    {
      environment: "prod",
      folders: ["/services", "/services/api-next", "/services/api-next/operator"],
      secrets: {},
    },
  ]);
  expect(
    report.violations.some(
      (entry) => entry.kind === "missing-required-secret" && entry.name === "TELEGRAM_SECRETS_JSON",
    ),
  ).toBe(false);
});
