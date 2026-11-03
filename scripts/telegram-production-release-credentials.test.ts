import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "./public-post-http-release-core.ts";
import {
  credentialContract,
  managedTelegramVault,
  telegramManagedProfile,
} from "./telegram-production-release-credentials.ts";

const now = Date.parse("2026-11-03T13:00:00Z");
const profile = "operator_profile";
const contract = {
  origin: "https://app.infisical.com" as const,
  organization: "operator_organization",
  profile_sha256: sha256(profile),
};
const session = () => ({
  principalType: "user",
  status: "authenticated",
  domain: contract.origin,
  organization: contract.organization,
  profile,
  verification: { state: "verified" },
  token: { exp: now / 1000 + 600 },
});

test("the sole verified profile is selected in memory by its exact digest", () => {
  expect(telegramManagedProfile({ sessions: [session()] }, contract, now)).toBe(profile);
  expect(JSON.stringify(contract)).not.toContain(profile);
});

test("wrong, ambiguous and invalid managed principals cannot supply a selector", () => {
  const variants = [
    [],
    [session(), session()],
    [{ ...session(), profile: "other_operator_profile" }],
    [{ ...session(), profile: "" }],
    [{ ...session(), profile: null }],
    [{ ...session(), principalType: "machine" }],
    [{ ...session(), status: "expired" }],
    [{ ...session(), domain: "https://unexpected.invalid" }],
    [{ ...session(), organization: "other_organization" }],
    [{ ...session(), verification: { state: "unverified" } }],
    [{ ...session(), token: { exp: now / 1000 + 300 } }],
    [{ ...session(), token: { exp: "invalid" } }],
  ];
  for (const sessions of variants) {
    try {
      telegramManagedProfile({ sessions }, contract, now);
      throw Error("fixture incorrectly admitted");
    } catch (error) {
      expect(String(error)).toMatch(/managed.*session-required/u);
      expect(String(error)).not.toContain(profile);
      expect(String(error)).not.toContain("other_operator_profile");
    }
  }
});

test("malformed metadata and changed profile hashes fail without raw data in errors", () => {
  for (const input of [null, [], {}, { sessions: [null] }])
    expect(() => telegramManagedProfile(input, contract, now)).toThrow();
  expect(() =>
    telegramManagedProfile(
      { sessions: [session()] },
      { ...contract, profile_sha256: "a".repeat(64) },
      now,
    ),
  ).toThrow("fresh-existing-managed-session-required");
});

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
test("the v2 hashed contract rejects the unexecuted literal-profile representation", () => {
  const directory = mkdtempSync(join(tmpdir(), "telegram-profile-contract-"));
  directories.push(directory);
  const file = (name: string, value: unknown) => {
    const path = join(directory, name),
      bytes = JSON.stringify(value);
    writeFileSync(path, bytes);
    return { path, sha256: sha256(bytes) };
  };
  const evidence = ["cli", "create", "index"].map((name) => file(name, { role_fixture: true }));
  const value = {
    ...contract,
    kind: "telegram-managed-create-only-contract-v2",
    accepted: true,
    reviewer_role: "independent_reviewer",
    findings: [],
    cli: evidence[0],
    evidence,
    atomic_create_only: true,
    duplicate_refuses_without_update: true,
    approval_is_not_creation: true,
  };
  expect(credentialContract(file("valid", value)).profile_sha256).toBe(contract.profile_sha256);
  for (const invalid of [
    { ...value, kind: "telegram-managed-create-only-contract-v1", profile },
    { ...value, profile },
    { ...value, profile_sha256: "opaque-role-reference-only" },
  ])
    expect(() => credentialContract(file("invalid", invalid))).toThrow();
});

test("fake-only managed CLI receives the verified in-memory selector; constructor has no API effect", () => {
  const directory = mkdtempSync(join(tmpdir(), "telegram-profile-cli-"));
  directories.push(directory);
  const calls = join(directory, "role-fixture-calls.jsonl");
  const cli = join(directory, "role-fixture-cli");
  const current = { ...session(), token: { exp: Math.floor(Date.now() / 1000) + 3600 } };
  const token = `role_fixture.${Buffer.from(JSON.stringify({ organizationId: contract.organization, exp: current.token.exp })).toString("base64url")}.role_fixture`;
  const body = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (JSON.stringify(args) === JSON.stringify(["login", "status", "--json", "--silent"])) {
  process.stdout.write(JSON.stringify(${JSON.stringify({ sessions: [current] })}));
} else if (JSON.stringify(args) === JSON.stringify(["user", "get", "token", "--plain", "--silent", "--profile", "operator_profile"])) {
  process.stdout.write(${JSON.stringify(token)});
} else { process.exit(23); }
`;
  writeFileSync(cli, body);
  chmodSync(cli, 0o700);
  const evidence = ["create", "duplicate", "applicability"].map((name) => {
    const path = join(directory, name),
      bytes = JSON.stringify({ role_fixture: true });
    writeFileSync(path, bytes);
    return { path, sha256: sha256(bytes) };
  });
  const value = {
    ...contract,
    kind: "telegram-managed-create-only-contract-v2",
    accepted: true,
    reviewer_role: "independent_reviewer",
    findings: [],
    cli: { path: cli, sha256: sha256(body) },
    evidence,
    atomic_create_only: true,
    duplicate_refuses_without_update: true,
    approval_is_not_creation: true,
  };
  const path = join(directory, "contract.json"),
    bytes = JSON.stringify(value);
  writeFileSync(path, bytes);
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  const refuseNetwork = () => {
    fetches++;
    throw Error("fake-only API tripwire");
  };
  globalThis.fetch = Object.assign(refuseNetwork, { preconnect: refuseNetwork });
  try {
    const vault = managedTelegramVault({ path, sha256: sha256(bytes) }, () => {});
    expect(typeof vault.list).toBe("function");
    expect(
      readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      ["login", "status", "--json", "--silent"],
      ["user", "get", "token", "--plain", "--silent", "--profile", profile],
    ]);
    expect(fetches).toBe(0);
    expect(readFileSync(path, "utf8")).not.toContain(profile);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
