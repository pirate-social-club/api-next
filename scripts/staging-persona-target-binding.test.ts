import { expect, test } from "bun:test";
import { inspectStagingRolePage, matchStagingRole } from "./staging-persona-target-binding";

const url =
  "postgresql://runtime.syu03e00w3ux:fixture@fixture.example:5432/postgres?sslmode=verify-full&sslrootcert=system";
const adminUrl =
  "postgresql://operator.syu03e00w3ux:fixture@fixture.example:5432/postgres?sslmode=verify-full";
const role = {
  id: "fixture_role",
  username: "runtime.syu03e00w3ux",
  base_username: "runtime",
  access_host_url: "fixture.example",
  database_name: "postgres",
  expired: false,
  branch: { id: "syu03e00w3ux", name: "main" },
};

test("role binding matches branch, endpoint, database and full connection username", () => {
  const matched = matchStagingRole(role, url, "runtime");
  expect(matched.sqlRole).toBe("runtime");
  expect(matched).not.toHaveProperty("url");
  expect(matched).toMatchObject({
    hostname: "fixture.example",
    port: "5432",
    username: "runtime.syu03e00w3ux",
  });
  for (const changed of [
    { ...role, branch: { id: "production", name: "main" } },
    { ...role, access_host_url: "wrong.example" },
    { ...role, username: "other.syu03e00w3ux" },
    { ...role, database_name: "other" },
    { ...role, expired: true },
    { ...role, disabled_at: "2026-01-01T00:00:00Z" },
    { ...role, expires_at: "2020-01-01T00:00:00Z" },
  ])
    expect(() => matchStagingRole(changed, url, "runtime")).toThrow("staging_role_target_mismatch");
  for (const changed of [
    url.replace("postgres?", "other?"),
    url.replace(":5432/", ":6432/"),
    `${url}#fragment`,
  ])
    expect(() => matchStagingRole(role, changed, "runtime")).toThrow(
      "staging_role_target_mismatch",
    );
});

test("admin and runtime URLs require their exact TLS parameter sets", () => {
  const adminRole = {
    ...role,
    id: "fixture_admin",
    username: "operator.syu03e00w3ux",
    base_username: "operator",
  };
  expect(matchStagingRole(adminRole, adminUrl, "admin").sqlRole).toBe("operator");
  for (const changed of [
    adminUrl.replace("sslmode=verify-full", "sslmode=require"),
    `${adminUrl}&sslrootcert=system`,
    `${adminUrl}&application_name=reset`,
  ])
    expect(() => matchStagingRole(adminRole, changed, "admin")).toThrow(
      "staging_connection_parameters",
    );
  for (const changed of [
    url.replace("&sslrootcert=system", ""),
    url.replace("sslrootcert=system", "sslmode=verify-full"),
    url.replace("sslmode=verify-full", "sslmode=require"),
    `${url}&application_name=reset`,
  ])
    expect(() => matchStagingRole(role, changed, "runtime")).toThrow(
      "staging_connection_parameters",
    );
});

test("role pagination requires explicit terminal or contiguous next-page metadata", () => {
  expect(inspectStagingRolePage({ data: [role], current_page: 1, next_page: 2 }, 1).nextPage).toBe(
    2,
  );
  expect(
    inspectStagingRolePage({ data: [role], current_page: 2, next_page: null }, 2).nextPage,
  ).toBeNull();
  for (const response of [
    { data: [role], next_page: null },
    { data: [role], current_page: 1 },
    { data: [role], current_page: 1, next_page: undefined },
    { data: [role], current_page: 1, next_page: "2" },
    { data: [role], current_page: 1, next_page: 3 },
    { data: role, current_page: 1, next_page: null },
    { data: [role], current_page: 2, next_page: null },
  ])
    expect(() => inspectStagingRolePage(response, 1)).toThrow(/staging_role_pagination/);
});
