import { expect, test } from "bun:test";
import {
  makeSongFundingAdmissionFixture as fixture,
  funding,
} from "./song-funding-binding-admission.fixture.ts";
import { assertFundingOrigin } from "./song-funding-binding-admission.ts";
import { songFundingRequirements } from "./song-funding-permission-contract.ts";
import { assertSongFundingPrivileges } from "./song-funding-permissions-preflight.ts";

test("candidate and every serving version are tied to distinct actual origins, permission logins and traffic fences", async () => {
  const f = fixture();
  const guard = await f.run();
  if (!guard) throw Error("Funding admission missing");
  expect(guard.receipt.evidence).toHaveLength(3);
  expect(f.checked).toEqual(["dance", "funding", "dance"]);
  await guard.recheck();
  f.deploy();
  const after = await guard.readback("new");
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

test("managed PostgreSQL binds the full external branch username to its actual SQL role", async () => {
  const host = "aws-fixture.pg.psdb.cloud",
    user = "pscale_api_funding.branch1";
  const origin = { ...funding, host, user };
  assertFundingOrigin(`postgres://${user}@${host}/postgres`, origin, {
    role: "pscale_api_funding",
    session: "pscale_api_funding",
    database: "postgres",
  });
  expect(() =>
    assertFundingOrigin(`postgres://pscale_api_funding.branch2@${host}/postgres`, origin, {
      role: "pscale_api_funding",
      session: "pscale_api_funding",
      database: "postgres",
    }),
  ).toThrow();
  for (const mismatch of [false, true]) {
    const f = fixture(),
      api = f.dependencies.api;
    f.dependencies.api = async (path: string) => {
      const value = await api(path);
      if (!path.includes("/hyperdrive/configs/")) return value;
      const row = value as { id: string; caching: { disabled: boolean } };
      const baseRole = path.endsWith("/general") ? "pscale_api_dance" : "pscale_api_funding";
      const branch = path.endsWith("/funding") && mismatch ? "branch2" : "branch1";
      return { ...row, origin: { ...funding, host, user: `${baseRole}.${branch}` } };
    };
    const role = (url: string) => new URL(url).username.split(".")[0] ?? "";
    f.dependencies.identity = async (url) => ({
      role: role(url),
      session: role(url),
      database: "postgres",
    });
    f.dependencies.dancePermissions = async (url) => role(url);
    f.dependencies.fundingPermissions = async (url) => role(url);
    f.dependencies.environment.CONTROL_PLANE_POSTGRES_RUNTIME_URL = `postgres://pscale_api_dance.branch1@${host}/postgres`;
    f.dependencies.environment.SONG_FUNDING_COMMANDS_POSTGRES_URL = `postgres://pscale_api_funding.${mismatch ? "branch2" : "branch1"}@${host}/postgres`;
    if (mismatch) await expect(f.run()).rejects.toThrow("same database");
    else
      expect(
        (await f.run())?.receipt.evidence
          .filter((r) => r.binding === "SONG_FUNDING_COMMANDS")
          .map((r) => r.role),
      ).toEqual(["pscale_api_funding"]);
  }
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

test("new serving versions must retain exact admitted funding/general IDs and lane posture", async () => {
  for (const fault of ["missing", "funding_id", "general_id", "lane", "foreign_legacy"] as const) {
    const f = fixture(),
      guard = await f.run();
    if (!guard) throw Error("Funding guard required");
    f.deploy();
    const changed = f.candidate.bindings.flatMap((b) => {
      if (fault === "missing" && b.name === "SONG_FUNDING_COMMANDS") return [];
      if (fault === "funding_id" && b.name === "SONG_FUNDING_COMMANDS")
        return [{ ...b, id: "unreviewed" }];
      if (fault === "general_id" && b.name === "CONTROL_PLANE") return [{ ...b, id: "unreviewed" }];
      if (fault === "lane" && b.name === "SAFE_POOL_PILOT_ENABLED")
        return [{ ...b, text: "false" }];
      return [b];
    });
    f.deployed(
      fault === "foreign_legacy"
        ? changed.filter((b) => b.name !== "SONG_FUNDING_COMMANDS")
        : changed,
    );
    await expect(guard.readback("new")).rejects.toThrow();
  }
});
