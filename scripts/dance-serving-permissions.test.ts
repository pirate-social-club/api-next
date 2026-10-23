import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { danceServingGrantPlan } from "./dance-serving-grant-plan.ts";
import {
  DANCE_SERVING_CONSUMERS,
  type DanceServingConsumer,
  danceServingRequirements,
} from "./dance-serving-permission-contract.ts";
import {
  assertDanceServingPrivileges,
  DANCE_SERVING_PRIVILEGES_SQL,
  DanceServingPrivilegesRefused,
} from "./dance-serving-permission-query.ts";
import {
  runDanceServingPermissionsPreflight,
  withDanceServingPermissionsDeployment,
} from "./dance-serving-permissions-preflight.ts";
import { withServingFunctionPrivilegesDeployment } from "./serving-function-privileges-preflight.ts";

const http = "apps/http-worker/wrangler.jsonc";
const gateway = "apps/video-source-gateway/wrangler.jsonc";
const ready = (config: DanceServingConsumer) =>
  danceServingRequirements(config).map((row) => ({
    runtime_role: "runtime",
    session_role: "runtime",
    role_safe: true,
    schema_usage: true,
    schema_create: false,
    owner_equivalent: false,
    object_name: row.name,
    boundary: row.boundary,
    expected_execute: row.execute,
    object_exists: true,
    anchored_owner: true,
    pinned_definer: row.execute,
    can_execute: row.execute,
    public_execute: false,
    private_access: row.boundary === "read_table",
    can_select: row.boundary === "read_table",
  }));
const configs = Object.keys(DANCE_SERVING_CONSUMERS) as DanceServingConsumer[];
for (const config of configs)
  test(`exact consumer facts admit ${config}`, () => {
    expect(assertDanceServingPrivileges(ready(config), config)).toBe("runtime");
  });
test("consumer requirements cover the real account, cleanup, notification and source consumers without direct erasure", () => {
  expect(
    danceServingRequirements(http)
      .filter((r) => r.execute)
      .map((r) => r.name),
  ).toContain("read_owned_moderated_dance_capture_context_v1(text,text,text)");
  expect(
    danceServingRequirements("apps/jobs-worker/wrangler.jsonc")
      .filter((r) => r.execute)
      .map((r) => r.name),
  ).toEqual(["pending_recipient_notifications_v2()", "deliver_recipient_notification_v2(text)"]);
  expect(
    danceServingRequirements("apps/media-processor-worker/wrangler.jsonc")
      .filter((r) => r.execute)
      .map((r) => r.name),
  ).toContain("next_moderated_dance_review_task_v1()");
  expect(danceServingRequirements(gateway).filter((r) => r.boundary === "read_table")).toHaveLength(
    6,
  );
  for (const config of configs)
    expect(
      danceServingRequirements(config).find(
        (r) => r.name === "begin_moderated_dance_account_erasure_v1(text)",
      )?.execute,
    ).toBe(false);
});
test("malformed, duplicate, omitted, foreign and retargeted privilege facts cannot admit", () => {
  const rows = ready(http);
  expect(() => assertDanceServingPrivileges(undefined, http)).toThrow(
    DanceServingPrivilegesRefused,
  );
  expect(() => assertDanceServingPrivileges(rows.slice(1), http)).toThrow();
  expect(() => assertDanceServingPrivileges([rows[0], ...rows.slice(0, -1)], http)).toThrow();
  expect(() =>
    assertDanceServingPrivileges(
      [{ ...rows[0], object_name: "untrusted SQL or URL" }, ...rows.slice(1)],
      http,
    ),
  ).toThrow("permissions refused");
  expect(() =>
    assertDanceServingPrivileges([{ ...rows[0], expected_execute: false }, ...rows.slice(1)], http),
  ).toThrow();
  expect(() =>
    assertDanceServingPrivileges([{ ...rows[0], schema_create: "false" }, ...rows.slice(1)], http),
  ).toThrow();
});
test("effective inherited privileges, owner or session switches and unpinned/public definers refuse", () => {
  for (const delta of [
    { role_safe: false },
    { owner_equivalent: true },
    { schema_create: true },
    { schema_usage: false },
    { session_role: "another" },
    { runtime_role: "another" },
    { object_exists: false },
    { anchored_owner: false },
    { pinned_definer: false },
    { public_execute: true },
    { can_execute: false },
    { private_access: true },
  ]) {
    const rows = ready(http);
    expect(() =>
      assertDanceServingPrivileges([{ ...rows[0], ...delta }, ...rows.slice(1)], http),
    ).toThrow();
  }
  const rows = ready(gateway),
    index = rows.findIndex((r) => r.boundary === "read_table");
  expect(() =>
    assertDanceServingPrivileges(
      rows.map((r, i) => (i === index ? { ...r, can_select: false } : r)),
      gateway,
    ),
  ).toThrow();
});
test("a newly granted private helper or raw column is rejected", () => {
  for (const boundary of ["function", "table"] as const) {
    const rows = ready(http),
      index = rows.findIndex((r) => r.boundary === boundary && !r.expected_execute);
    expect(() =>
      assertDanceServingPrivileges(
        rows.map((r, i) =>
          i === index
            ? {
                ...r,
                ...(boundary === "function" ? { can_execute: true } : { private_access: true }),
              }
            : r,
        ),
        http,
      ),
    ).toThrow();
  }
});
test("probe uses one read-only transaction and retires the connection on refusal", async () => {
  for (const valid of [true, false]) {
    const calls: string[] = [];
    let closed = 0;
    const operation = runDanceServingPermissionsPreflight(
      "postgres://runtime@example.invalid/postgres",
      http,
      "api_next",
      () => ({
        connect: async () => undefined,
        query: async (text) => {
          calls.push(text);
          return { rows: text === DANCE_SERVING_PRIVILEGES_SQL ? (valid ? ready(http) : []) : [] };
        },
        end: async () => {
          closed++;
        },
      }),
    );
    if (valid) expect(await operation).toBe("runtime");
    else await expect(operation).rejects.toThrow();
    expect(calls).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      DANCE_SERVING_PRIVILEGES_SQL,
      "ROLLBACK",
    ]);
    expect(closed).toBe(1);
  }
});

const roots: string[] = [];
const saved = {
  runtime: process.env.RUNTIME_POSTGRES_URL,
  control: process.env.CONTROL_PLANE_POSTGRES_RUNTIME_URL,
};
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  for (const [name, value] of [
    ["RUNTIME_POSTGRES_URL", saved.runtime],
    ["CONTROL_PLANE_POSTGRES_RUNTIME_URL", saved.control],
  ] as const)
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
});
async function source() {
  const root = await mkdtemp(join(tmpdir(), "dance-serving-permissions-"));
  roots.push(root);
  await mkdir(join(root, "scripts"));
  await writeFile(join(root, "scripts/dance-serving-permission-contract.ts"), "");
  return root;
}
test("the maintained upload guard cannot skip media or the separately deployed source gateway", async () => {
  delete process.env.RUNTIME_POSTGRES_URL;
  delete process.env.CONTROL_PLANE_POSTGRES_RUNTIME_URL;
  const root = await source();
  for (const config of ["apps/media-processor-worker/wrangler.jsonc", gateway]) {
    let uploaded = false;
    await expect(
      withServingFunctionPrivilegesDeployment(root, config, async () => {
        uploaded = true;
      }),
    ).rejects.toThrow("requires the serving-role database URL");
    expect(uploaded).toBe(false);
  }
});
test("a refused consumer preflight prevents upload and logs no connection value", async () => {
  process.env.RUNTIME_POSTGRES_URL = "postgres://runtime@example.invalid/postgres";
  const root = await source(),
    messages: string[] = [];
  let uploaded = false;
  await expect(
    withDanceServingPermissionsDeployment(
      root,
      gateway,
      async () => {
        uploaded = true;
      },
      async () => {
        throw new DanceServingPrivilegesRefused(["known function: EXECUTE missing"]);
      },
      (text) => messages.push(text),
    ),
  ).rejects.toThrow("Dance serving permissions refused");
  expect(uploaded).toBe(false);
  expect(messages.join("")).toBe("known function: EXECUTE missing\n");
});
test("the render-only plan binds exact source/role/consumer inputs and adds no table or erasure grant", () => {
  const input = {
    role: "runtime",
    schema: "api_next",
    consumers: configs,
    ledgerSha256: "a".repeat(64),
  };
  const plan = danceServingGrantPlan(input),
    sql = plan.statements.join(";\n");
  expect(plan).toEqual(danceServingGrantPlan(input));
  expect(sql).toContain("Dance release ledger differs");
  expect(sql).not.toMatch(/GRANT.*(?:ON TABLE|ON ALL|ON SCHEMA|erasure)/u);
  expect(sql.match(/GRANT EXECUTE ON FUNCTION/gu)).toHaveLength(7);
  expect(sql).toContain("'source_gateway'");
  expect(sql).not.toContain("'erasure')");
  expect(plan.statements.at(0)).toBe("BEGIN");
  expect(plan.statements.at(-1)).toBe("COMMIT");
  for (const bad of [
    { ...input, role: "runtime'; DROP ROLE other;--" },
    { ...input, schema: "api_next,public" },
    { ...input, consumers: [] },
    { ...input, ledgerSha256: "bad" },
  ])
    expect(() => danceServingGrantPlan(bad)).toThrow();
});
