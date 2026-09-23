import { readFile } from "node:fs/promises";

export type BranchHostRoleReadback = Readonly<{
  rolname: string;
  rolsuper: boolean;
  rolinherit: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  rolcanlogin: boolean;
  database_create: boolean;
  schema_create: boolean;
  inherited_roles: string[];
  owned_objects: number;
}>;

/** The branch-only host may read and write data, but must not own or alter schema. */
export function verifyBranchHostRole(rows: readonly BranchHostRoleReadback[], expectedName: string): void {
  if (rows.length !== 1 || rows[0]?.rolname !== expectedName) {
    throw new Error("branch host role identity does not match");
  }
  const role = rows[0];
  if (!role.rolcanlogin || !role.rolinherit) throw new Error("branch host role cannot inherit and log in");
  if (role.inherited_roles.join(",") !== "pg_read_all_data,pg_write_all_data") {
    throw new Error("branch host role has unexpected inherited privileges");
  }
  if (
    role.rolsuper ||
    role.rolcreatedb ||
    role.rolcreaterole ||
    role.rolreplication ||
    role.rolbypassrls ||
    role.database_create ||
    role.schema_create ||
    role.owned_objects !== 0
  ) {
    throw new Error("branch host role can administer or own schema");
  }
}

if (import.meta.main) {
  const [path, expectedName] = process.argv.slice(2);
  if (!path || !expectedName) throw new Error("usage: branch-role-policy.ts <readback-json> <role-name>");
  const rows = JSON.parse(await readFile(path, "utf8")) as BranchHostRoleReadback[];
  verifyBranchHostRole(rows, expectedName);
  console.log(JSON.stringify({ role: expectedName, scope: "branch-data-only", verified: true }));
}
