import { expect, test } from "bun:test";
import {
  assertFundingOrigin,
  prepareSongFundingBindingAdmission,
} from "./song-funding-binding-admission.ts";
import { songFundingRequirements } from "./song-funding-permission-contract.ts";
import { assertSongFundingPrivileges } from "./song-funding-permissions-preflight.ts";
import type { CandidateBindings } from "./worker-binding-drift.ts";

const general = {
  scheme: "postgres",
  host: "branch.invalid",
  port: 5432,
  database: "postgres",
  user: "dance",
};
const funding = { ...general, user: "funding" };
function fixture(purpose: "http" | "jobs" = "http") {
  let cacheDisabled = true;
  let alias = false,
    drift = false,
    serving = "old";
  const checked: string[] = [];
  const candidate: { -readonly [K in keyof CandidateBindings]: CandidateBindings[K] } = {
    worker_name: "fixture",
    required_secrets: [],
    runtime: {},
    bindings: [
      { name: "CONTROL_PLANE", type: "hyperdrive", id: "general" },
      {
        name: purpose === "http" ? "SONG_FUNDING_COMMANDS" : "SONG_FUNDING_JOBS",
        type: "hyperdrive",
        id: "funding",
      },
      { name: "MEGAPOT_REWARDS_ENABLED", type: "plain_text", text: "false" },
      { name: "SAFE_POOL_PILOT_ENABLED", type: "plain_text", text: "true" },
    ],
  };
  const dependencies = {
    candidate: async () => candidate,
    account: async () => "08a4c22cf52e2ecae883e36f80a33f4a",
    api: async (path: string): Promise<unknown> => {
      if (path.endsWith("/deployments"))
        return {
          deployments: [
            {
              created_on: "2026-10-26T10:00:00Z",
              versions: [{ version_id: drift ? crypto.randomUUID() : serving, percentage: 100 }],
            },
          ],
        };
      if (path.includes("/versions/"))
        return {
          id: serving,
          resources: {
            bindings:
              serving === "old"
                ? candidate.bindings.filter(
                    (b) =>
                      b.name !==
                      (purpose === "http" ? "SONG_FUNDING_COMMANDS" : "SONG_FUNDING_JOBS"),
                  )
                : candidate.bindings,
          },
        };
      return {
        id: path.split("/").at(-1),
        caching: { disabled: cacheDisabled },
        origin: path.endsWith("/general") || alias ? general : funding,
      };
    },
    identity: async (url: string) => {
      const user = new URL(url).username;
      return { role: user, session: user, database: "postgres" };
    },
    dancePermissions: async (url: string) => {
      checked.push("dance");
      return new URL(url).username;
    },
    fundingPermissions: async (url: string) => {
      checked.push("funding");
      return new URL(url).username;
    },
    environment: {
      CONTROL_PLANE_POSTGRES_RUNTIME_URL: "postgres://dance@branch.invalid/postgres",
      SONG_FUNDING_JOBS_POSTGRES_URL: "postgres://funding@branch.invalid/postgres",
      SONG_FUNDING_COMMANDS_POSTGRES_URL: "postgres://funding@branch.invalid/postgres",
    },
  };
  const run = () =>
    prepareSongFundingBindingAdmission(
      process.cwd(),
      purpose === "http" ? "apps/http-worker/wrangler.jsonc" : "apps/jobs-worker/wrangler.jsonc",
      "staging",
      "a".repeat(40),
      dependencies,
    );
  return {
    run,
    candidate,
    dependencies,
    checked,
    cache: () => {
      cacheDisabled = false;
    },
    alias: () => {
      alias = true;
    },
    drift: () => {
      drift = true;
    },
    deploy: () => {
      serving = "new";
    },
  };
}

test("candidate and every serving version are tied to distinct actual origins, permission logins and traffic fences", async () => {
  const f = fixture();
  const guard = await f.run();
  if (!guard) throw Error("Funding admission missing");
  expect(guard.receipt.evidence).toHaveLength(3);
  expect(f.checked).toEqual(["dance", "funding", "dance"]);
  await guard.recheck();
  f.deploy();
  const after = await guard.readback();
  expect(after.evidence.filter((r) => r.version_id === "new")).toHaveLength(2);
  await expect(guard.recheck()).rejects.toThrow("changed before upload");
});

test("missing capability, aliased origin, changed candidate and traffic drift refuse before upload", async () => {
  for (const fault of ["missing", "alias", "url", "traffic", "both", "cache", "account"] as const) {
    const f = fixture();
    if (fault === "missing")
      f.candidate.bindings = f.candidate.bindings.filter((b) => b.name !== "SONG_FUNDING_COMMANDS");
    if (fault === "alias") f.alias();
    if (fault === "cache") f.cache();
    if (fault === "account") f.dependencies.account = async () => "b".repeat(32);
    if (fault === "url")
      f.dependencies.environment.SONG_FUNDING_COMMANDS_POSTGRES_URL =
        "postgres://unrelated@branch.invalid/postgres";
    if (fault === "traffic") f.drift();
    if (fault === "both")
      f.candidate.bindings = f.candidate.bindings.map((b) =>
        b.name === "MEGAPOT_REWARDS_ENABLED" ? { ...b, text: "true" } : b,
      );
    await expect(f.run()).rejects.toThrow();
  }
  const f = fixture(),
    guard = await f.run();
  f.candidate.bindings = [
    ...f.candidate.bindings,
    { name: "EXTRA", type: "plain_text", text: "changed" },
  ];
  await expect(guard?.recheck()).rejects.toThrow();
});

test("ordinary Rewards-off service requires no funding resource or permission credential", async () => {
  const f = fixture();
  f.candidate.bindings = f.candidate.bindings
    .filter((b) => b.name !== "SONG_FUNDING_COMMANDS")
    .map((b) => (b.name === "SAFE_POOL_PILOT_ENABLED" ? { ...b, text: "false" } : b));
  expect(await f.run()).toBeNull();
  expect(f.checked).toEqual([]);
});

test("binding evidence cannot substitute a different database, host, user or session", () => {
  const url = "postgres://funding@branch.invalid/postgres",
    identity = { role: "funding", session: "funding", database: "postgres" };
  assertFundingOrigin(url, funding, identity);
  for (const origin of [
    { ...funding, host: "other.invalid" },
    { ...funding, database: "other" },
    { ...funding, user: "other" },
    { ...funding, port: 6432 },
  ])
    expect(() => assertFundingOrigin(url, origin, identity)).toThrow();
  expect(() => assertFundingOrigin(url, funding, { ...identity, session: "admin" })).toThrow();
});

test("purpose contract refuses elevated, inherited, public, raw or wrong-purpose authority", () => {
  for (const purpose of ["http", "jobs"] as const) {
    const rows = songFundingRequirements(purpose).map((r) => ({
      name: r.name,
      expected: r.execute,
      runtime_role: "funding",
      session_role: "funding",
      role_safe: true,
      schema_usage: true,
      schema_create: false,
      schema_grant_option: false,
      unexpected_execute_grants: false,
      grant_option: false,
      membership: false,
      raw_access: false,
      object_exists: true,
      can_execute: r.execute,
      public_execute: false,
      trusted: true,
    }));
    expect(assertSongFundingPrivileges(rows, purpose)).toBe("funding");
    for (const change of [
      { role_safe: false },
      { membership: true },
      { grant_option: true },
      { unexpected_execute_grants: true },
      { schema_grant_option: true },
      { raw_access: true },
      { public_execute: true },
      { session_role: "admin" },
      { can_execute: !rows[0]?.can_execute },
      { object_exists: false },
    ])
      expect(() =>
        assertSongFundingPrivileges(
          rows.map((r, i) => (i === 0 ? { ...r, ...change } : r)),
          purpose,
        ),
      ).toThrow();
  }
});

test("Jobs admission binds the Jobs capability rather than the HTTP command credential", async () => {
  const f = fixture("jobs"),
    guard = await f.run();
  expect(guard?.receipt.evidence.filter((r) => r.binding === "SONG_FUNDING_JOBS")).toHaveLength(1);
  expect(guard?.receipt.evidence.some((r) => r.binding === "SONG_FUNDING_COMMANDS")).toBe(false);
});
