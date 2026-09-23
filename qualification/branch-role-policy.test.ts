import { describe, expect, test } from "bun:test";
import { type BranchHostRoleReadback, verifyBranchHostRole } from "./branch-role-policy";

const dataRole: BranchHostRoleReadback = {
  rolname: "pscale_api_test",
  rolsuper: false,
  rolinherit: true,
  rolcreatedb: false,
  rolcreaterole: false,
  rolreplication: false,
  rolbypassrls: false,
  rolcanlogin: true,
  database_create: false,
  schema_create: false,
  inherited_roles: ["pg_read_all_data", "pg_write_all_data"],
  owned_objects: 0,
};

describe("branch-only render host role", () => {
  test("accepts only the data roles on the named login", () => {
    expect(() => verifyBranchHostRole([dataRole], dataRole.rolname)).not.toThrow();
    expect(() => verifyBranchHostRole([], dataRole.rolname)).toThrow();
    expect(() => verifyBranchHostRole([dataRole], "another_role")).toThrow();
    expect(() => verifyBranchHostRole([dataRole, dataRole], dataRole.rolname)).toThrow();
  });

  test("rejects an owner, administrator, or schema-changing privilege", () => {
    for (const extra of [
      { inherited_roles: ["pg_read_all_data", "pg_write_all_data", "postgres"] },
      { inherited_roles: ["pg_read_all_data"] },
      { rolsuper: true },
      { rolcreatedb: true },
      { rolcreaterole: true },
      { rolreplication: true },
      { rolbypassrls: true },
      { database_create: true },
      { schema_create: true },
      { owned_objects: 1 },
      { rolcanlogin: false },
      { rolinherit: false },
    ]) {
      expect(() => verifyBranchHostRole([{ ...dataRole, ...extra }], dataRole.rolname)).toThrow();
    }
  });
});
