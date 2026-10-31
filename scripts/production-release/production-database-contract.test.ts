import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { browserPlanGrants, BROWSER_FUNCTIONS, BROWSER_PLAN_FILE, DANCE_PLAN_FILE, RUNTIME } from "./production-database-cutover.ts";
import { fileHash } from "./production-operation-evidence.ts";

test("committed plans retain accepted bytes and exactly five browser grants inside their guarded transaction", () => {
  const browserPath = new URL("./browser-grant-plan-333.json", import.meta.url);
  expect(fileHash(browserPath)).toBe(BROWSER_PLAN_FILE);
  expect(fileHash(new URL("./production-dance-grant-plan-333.json", import.meta.url))).toBe(DANCE_PLAN_FILE);
  const plan = JSON.parse(readFileSync(browserPath, "utf8"));
  expect(browserPlanGrants(plan.statements)).toEqual(BROWSER_FUNCTIONS.map(name => `GRANT EXECUTE ON FUNCTION "api_next".${name} TO "${RUNTIME}"`));
  const extraGrant = [...plan.statements]; extraGrant.splice(10, 0, "GRANT ALL ON SCHEMA api_next TO public");
  expect(() => browserPlanGrants(extraGrant)).toThrow();
  const missingGuard = [...plan.statements]; missingGuard[4] = "SELECT true";
  expect(() => browserPlanGrants(missingGuard)).toThrow();
  const foreignRole = plan.statements.map((statement: string) => statement.replaceAll(RUNTIME, "other_runtime"));
  expect(() => browserPlanGrants(foreignRole)).toThrow();
  const noCommit = [...plan.statements]; noCommit.pop();
  expect(() => browserPlanGrants(noCommit)).toThrow();
});
