import { expect, test } from "bun:test";
import { auditInfisicalSnapshots } from "./infisical-secret-drift-audit";

test("admits Telegram wrapping keys only at the staging runtime custody path", () => {
  const name = "TELEGRAM_CREDENTIAL_KEYS_JSON";
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
      expect(unexpected).toBe(environment !== "staging" || path !== "/services/api-next");
    }
  }
});
