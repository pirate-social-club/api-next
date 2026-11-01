import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  BROWSER_FUNCTIONS,
  BROWSER_PLAN_FILE,
  browserPlanGrants,
  DANCE_PLAN_FILE,
  grantPlanPreflightStatements,
  RUNTIME,
} from "./production-database-cutover.ts";
import { fileHash } from "./production-operation-evidence.ts";

test("committed plans retain accepted bytes and exactly five browser grants inside their guarded transaction", () => {
  const browserPath = new URL("./browser-grant-plan-333.json", import.meta.url);
  expect(fileHash(browserPath)).toBe(BROWSER_PLAN_FILE);
  expect(fileHash(new URL("./production-dance-grant-plan-333.json", import.meta.url))).toBe(
    DANCE_PLAN_FILE,
  );
  const plan = JSON.parse(readFileSync(browserPath, "utf8"));
  expect(browserPlanGrants(plan.statements)).toEqual(
    BROWSER_FUNCTIONS.map((name) => `GRANT EXECUTE ON FUNCTION "api_next".${name} TO "${RUNTIME}"`),
  );
  const extraGrant = [...plan.statements];
  extraGrant.splice(10, 0, "GRANT ALL ON SCHEMA api_next TO public");
  expect(() => browserPlanGrants(extraGrant)).toThrow();
  const missingGuard = [...plan.statements];
  missingGuard[4] = "SELECT true";
  expect(() => browserPlanGrants(missingGuard)).toThrow();
  const foreignRole = plan.statements.map((statement: string) =>
    statement.replaceAll(RUNTIME, "other_runtime"),
  );
  expect(() => browserPlanGrants(foreignRole)).toThrow();
  const noCommit = [...plan.statements];
  noCommit.pop();
  expect(() => browserPlanGrants(noCommit)).toThrow();
});

test("the actual Dance plan's grant helper calls start after the read-only preflight", () => {
  const plan = JSON.parse(
    readFileSync(new URL("./production-dance-grant-plan-333.json", import.meta.url), "utf8"),
  );
  expect(plan.plan.statements[3]).toBe(
    `SELECT "api_next".grant_moderated_dance_runtime_v1('${RUNTIME}','account')`,
  );
  expect(grantPlanPreflightStatements(plan.plan.statements)).toEqual(
    plan.plan.statements.slice(1, 3),
  );
  expect(grantPlanPreflightStatements(plan.plan.statements)[1]).toStartWith("DO $dance_release$");
});

test("the actual browser plan retains all read-only settings and its guard before direct grants", () => {
  const plan = JSON.parse(
    readFileSync(new URL("./browser-grant-plan-333.json", import.meta.url), "utf8"),
  );
  const preflight = grantPlanPreflightStatements(plan.statements);
  expect(preflight).toEqual(plan.statements.slice(1, 5));
  expect(preflight).toHaveLength(4);
  expect(preflight.at(-1)).toStartWith("DO $browser_release$");
  expect(() =>
    grantPlanPreflightStatements(["BEGIN", "SET LOCAL search_path TO api_next", "COMMIT"]),
  ).toThrow();
});
