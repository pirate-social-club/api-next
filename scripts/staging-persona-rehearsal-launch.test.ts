import { expect, test } from "bun:test";
import {
  branchNamePattern,
  injectedCommand,
  missingInjectionVariables,
} from "./staging-persona-rehearsal-launch";

test("missing injection variables are named and no values are touched", () => {
  expect(missingInjectionVariables({})).toEqual([
    "CONTROL_PLANE_POSTGRES_ADMIN_URL",
    "CONTROL_PLANE_POSTGRES_RUNTIME_URL",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
  ]);
  const complete = {
    CONTROL_PLANE_POSTGRES_ADMIN_URL: "postgres://private",
    CONTROL_PLANE_POSTGRES_RUNTIME_URL: "postgres://private",
    CLOUDFLARE_API_TOKEN: "private",
    CLOUDFLARE_ACCOUNT_ID: "private",
  };
  expect(missingInjectionVariables(complete)).toEqual([]);
  expect(missingInjectionVariables({ ...complete, CLOUDFLARE_API_TOKEN: "   " })).toEqual([
    "CLOUDFLARE_API_TOKEN",
  ]);
  expect(
    JSON.stringify(missingInjectionVariables({ CLOUDFLARE_API_TOKEN: "synthetic_secret_value" })),
  ).not.toContain("synthetic_secret_value");
});

test("the injection boundary is one command shape shared by the supervisor and helpers", () => {
  const command = injectedCommand([
    "bun",
    "scripts/staging-persona-rehearsal-supervisor.ts",
    "--execute",
  ]);
  expect(command.slice(0, 7)).toEqual([
    "infisical",
    "run",
    "--env=staging",
    "--path=/services/api-next",
    "--path=/services/api-next/operator",
    "--silent",
    "--",
  ]);
  expect(command.slice(7)).toEqual([
    "bun",
    "scripts/staging-persona-rehearsal-supervisor.ts",
    "--execute",
  ]);
});

test("the branch name guard accepts the reviewed shape and refuses loose input", () => {
  expect(branchNamePattern.test("persona-reset-rehearsal-20260913-r11")).toBe(true);
  for (const value of ["", "Upper", "name with space", "-leading", "a".repeat(60)])
    expect(branchNamePattern.test(value)).toBe(false);
});
