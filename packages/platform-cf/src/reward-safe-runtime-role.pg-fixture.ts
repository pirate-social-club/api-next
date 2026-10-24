import type { Client } from "pg";
import { RUNTIME_RELEASE_PRIVILEGES } from "../../../scripts/runtime-role-release-preflight.ts";

const q = (value: string) => `"${value.replaceAll('"', '""')}"`;

/**
 * A login role holding only the reviewed release runtime privileges: schema USAGE and
 * each allowed entry of RUNTIME_RELEASE_PRIVILEGES, with nothing inherited or defaulted.
 * Safe code that runs through it shows the release list is sufficient; the release
 * preflight shows a deployed runtime role holds exactly that list.
 *
 * The test baseline is dumped without privileges, so PUBLIC could execute every
 * routine. As the migrations do, PUBLIC loses EXECUTE on every SECURITY DEFINER routine
 * and on each routine the list denies; invoker helpers keep the default, since they run
 * with the caller's own privileges. A definer routine the code calls must be listed.
 */
export async function makeReleaseRuntimeLogin(admin: Client, url: string, schema: string) {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const role = `safe_release_runtime_${suffix}`;
  const password = crypto.randomUUID().replaceAll("-", "");
  await admin.query(`CREATE ROLE ${q(role)} LOGIN PASSWORD '${password}'`);
  await admin.query(`GRANT USAGE ON SCHEMA ${q(schema)} TO ${q(role)}`);
  const denied = RUNTIME_RELEASE_PRIVILEGES.filter(
    (requirement) => requirement.privilege === "EXECUTE" && !requirement.allowed,
  ).map((requirement) => `${schema}.${requirement.object}`);
  const routines = await admin.query<{ routine: string }>(
    `SELECT p.oid::regprocedure::text AS routine FROM pg_proc p
      WHERE p.pronamespace = $1::regnamespace AND p.prokind = 'f'
        AND (p.prosecdef OR p.oid = ANY($2::text[]::regprocedure[]::oid[]))`,
    [schema, denied],
  );
  for (const { routine } of routines.rows) {
    await admin.query(`REVOKE EXECUTE ON FUNCTION ${routine} FROM PUBLIC`);
  }
  for (const requirement of RUNTIME_RELEASE_PRIVILEGES) {
    if (!requirement.allowed) continue;
    const kind = requirement.privilege === "EXECUTE" ? "FUNCTION" : "TABLE";
    await admin.query(
      `GRANT ${requirement.privilege} ON ${kind} ${q(schema)}.${requirement.object} TO ${q(role)}`,
    );
  }
  const login = new URL(url);
  login.username = role;
  login.password = password;
  login.searchParams.set("options", `-c search_path=${schema}`);
  return {
    role,
    url: login.toString(),
    drop: async () => {
      await admin.query(`DROP OWNED BY ${q(role)}`);
      await admin.query(`DROP ROLE ${q(role)}`);
    },
  };
}
