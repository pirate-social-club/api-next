import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertServingFunctionPrivileges,
  SERVING_FUNCTION_EXECUTE_DENIALS,
  SERVING_FUNCTION_EXECUTE_GRANTS,
  ServingFunctionPrivilegesRefused,
} from "../packages/platform-cf/src/serving-function-privileges.ts";
import { withServingFunctionPrivilegesDeployment } from "./serving-function-privileges-preflight.ts";

const roots: string[] = [];
const saved = {
  runtime: process.env.RUNTIME_POSTGRES_URL,
  control: process.env.CONTROL_PLANE_POSTGRES_RUNTIME_URL,
};
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  process.env.RUNTIME_POSTGRES_URL = saved.runtime;
  process.env.CONTROL_PLANE_POSTGRES_RUNTIME_URL = saved.control;
  if (saved.runtime === undefined) delete process.env.RUNTIME_POSTGRES_URL;
  if (saved.control === undefined) delete process.env.CONTROL_PLANE_POSTGRES_RUNTIME_URL;
});

async function source(withList: boolean) {
  const root = await mkdtemp(join(tmpdir(), "serving-functions-"));
  roots.push(root);
  if (withList) {
    await mkdir(join(root, "packages/platform-cf/src"), { recursive: true });
    await writeFile(join(root, "packages/platform-cf/src/serving-function-privileges.ts"), "");
  }
  return root;
}

const ready = () => [
  ...SERVING_FUNCTION_EXECUTE_GRANTS.map(({ signature }) => fact(signature, true)),
  ...SERVING_FUNCTION_EXECUTE_DENIALS.map((signature) => fact(signature, false)),
];
const fact = (signature: string, expected: boolean) => ({
  runtime_role: "serving",
  signature,
  expected_execute: expected,
  schema_usage: true,
  function_exists: true,
  anchored_owner: true,
  security_definer: true,
  pinned_search_path: true,
  owner_equivalent: false,
  can_execute: expected,
});

const row = (rows: ReturnType<typeof ready>, index: number) => {
  const selected = rows.at(index);
  if (selected === undefined) throw Error("fixture row missing");
  return selected;
};

test("exact grants and denials admit the serving role", () => {
  expect(assertServingFunctionPrivileges(ready())).toBe("serving");
});

test("a missing grant, an extra grant or a weakened entry point refuses", () => {
  const cases: [string, (rows: ReturnType<typeof ready>) => void, string][] = [
    ["missing", (rows) => (row(rows, 0).can_execute = false), "EXECUTE missing"],
    ["extra", (rows) => (row(rows, -1).can_execute = true), "EXECUTE must be denied"],
    ["invoker", (rows) => (row(rows, 0).security_definer = false), "not security definer"],
    ["path", (rows) => (row(rows, 0).pinned_search_path = false), "search_path not pinned"],
    ["owner", (rows) => (row(rows, 0).anchored_owner = false), "schema or owner differs"],
    ["equivalent", (rows) => (row(rows, 0).owner_equivalent = true), "owner-equivalent"],
    ["absent", (rows) => (row(rows, 0).function_exists = false), "function missing"],
  ];
  for (const [, mutate, failure] of cases) {
    const rows = ready();
    mutate(rows);
    try {
      assertServingFunctionPrivileges(rows);
      throw Error("admitted");
    } catch (error) {
      expect(error).toBeInstanceOf(ServingFunctionPrivilegesRefused);
      expect((error as ServingFunctionPrivilegesRefused).failures.join("\n")).toContain(failure);
    }
  }
  expect(() => assertServingFunctionPrivileges(ready().slice(1))).toThrow(
    ServingFunctionPrivilegesRefused,
  );
});

test("a denied trigger helper need not be a pinned definer", () => {
  const rows = ready();
  const denied = row(rows, -1);
  denied.security_definer = false;
  denied.pinned_search_path = false;
  expect(assertServingFunctionPrivileges(rows)).toBe("serving");
});

test("grants and denials never overlap", () => {
  const grants = new Set<string>(SERVING_FUNCTION_EXECUTE_GRANTS.map((grant) => grant.signature));
  expect(grants.size).toBe(SERVING_FUNCTION_EXECUTE_GRANTS.length);
  expect(new Set(SERVING_FUNCTION_EXECUTE_DENIALS).size).toBe(
    SERVING_FUNCTION_EXECUTE_DENIALS.length,
  );
  for (const denied of SERVING_FUNCTION_EXECUTE_DENIALS) expect(grants.has(denied)).toBe(false);
  expect(SERVING_FUNCTION_EXECUTE_DENIALS).toContain(
    "close_unclaimed_learner_audio_private_v1(text)",
  );
});

test("deploy guard runs only for HTTP and jobs sources that carry the list", async () => {
  delete process.env.RUNTIME_POSTGRES_URL;
  delete process.env.CONTROL_PLANE_POSTGRES_RUNTIME_URL;
  const checked: string[] = [];
  const preflight = async (url: string) => checked.push(url);
  const old = await source(false);
  await expect(
    withServingFunctionPrivilegesDeployment(
      old,
      "apps/http-worker/wrangler.jsonc",
      async () => "ok",
      preflight,
    ),
  ).resolves.toBe("ok");
  const current = await source(true);
  await expect(
    withServingFunctionPrivilegesDeployment(
      current,
      "apps/media-processor-worker/wrangler.jsonc",
      async () => "ok",
      preflight,
    ),
  ).resolves.toBe("ok");
  await expect(
    withServingFunctionPrivilegesDeployment(
      current,
      "apps/jobs-worker/wrangler.jsonc",
      async () => "ok",
      preflight,
    ),
  ).rejects.toThrow("requires the serving-role database URL");
  process.env.CONTROL_PLANE_POSTGRES_RUNTIME_URL = "postgres://serving@example.invalid/db";
  await expect(
    withServingFunctionPrivilegesDeployment(
      current,
      "apps/jobs-worker/wrangler.jsonc",
      async () => "ok",
      preflight,
    ),
  ).resolves.toBe("ok");
  expect(checked).toEqual(["postgres://serving@example.invalid/db"]);
});

test("a refused preflight blocks the upload and names only signatures", async () => {
  process.env.CONTROL_PLANE_POSTGRES_RUNTIME_URL = "postgres://serving@example.invalid/db";
  const current = await source(true);
  const diagnostics: string[] = [];
  let uploaded = false;
  await expect(
    withServingFunctionPrivilegesDeployment(
      current,
      "apps/http-worker/wrangler.jsonc",
      async () => {
        uploaded = true;
      },
      async () => {
        throw new ServingFunctionPrivilegesRefused(["f(text): EXECUTE missing"]);
      },
      (text) => diagnostics.push(text),
    ),
  ).rejects.toThrow("Serving-role function privileges refused");
  expect(uploaded).toBe(false);
  expect(diagnostics.join("")).toBe("f(text): EXECUTE missing\n");
  expect(diagnostics.join("")).not.toContain("example.invalid");
});
