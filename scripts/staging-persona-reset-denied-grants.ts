import { Schema } from "effect";
import type { Client } from "pg";
import { verifyStagingRuntimeIdentity } from "./staging-persona-approved-privileges";
import { readResetGrantCatalog, revokeResetCatalogGrant } from "./staging-persona-grant-catalog";
import { RUNTIME_DENIAL_CATALOG_SQL, RuntimeDeniedCatalog } from "./staging-persona-runtime-denial";

/** Same effective ACL expectation as maintained-fence admission. This proves
 * ACL denial only; reconnect, session drain and other surfaces remain mandatory. */
export async function verifyResetRuntimeDenied(admin: Pick<Client, "query">, runtimeRole: string) {
  await verifyStagingRuntimeIdentity(admin, runtimeRole);
  const result = await admin.query(RUNTIME_DENIAL_CATALOG_SQL, ["api_next", runtimeRole]);
  Schema.decodeUnknownSync(RuntimeDeniedCatalog)(result.rows[0]);
}

/** Called only inside the migration's owned transaction, before COMMIT.
 * Defaults are retained exactly, but their materialized object grants cannot
 * escape the transaction. Schema/default ACLs, role membership and outside
 * objects are never repaired here: unexpected authority there must refuse. */
export async function denyReplayedRuntimeGrants(admin: Pick<Client, "query">, runtimeRole: string) {
  const xid = (await admin.query("SELECT pg_current_xact_id_if_assigned()::text AS xid")).rows[0]
    ?.xid;
  if (!xid) throw new Error("reset_denial_owned_transaction_required");
  const names = await verifyStagingRuntimeIdentity(admin, runtimeRole);
  const catalog = await readResetGrantCatalog(admin);
  for (const grant of catalog.grants) {
    if (
      ["table", "sequence"].includes(grant.objectKind) &&
      (grant.grantee === "PUBLIC" || names.includes(grant.grantee))
    )
      await revokeResetCatalogGrant(admin, grant);
  }
  await verifyResetRuntimeDenied(admin, runtimeRole);
}
