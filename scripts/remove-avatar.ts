import { ControlPlaneDb } from "@pirate/application";
import { AvatarAssetId } from "@pirate/contracts";
import { Effect, Schema } from "effect";
import { makeAvatarStoreFromDb } from "../packages/platform-cf/src/avatar-store.ts";
import { makeDirectPostgresControlPlaneLayer } from "../packages/platform-cf/src/postgres.ts";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";

export function parseAvatarRemoval(args: readonly string[]) {
  const options = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === "--apply" && !apply) {
      apply = true;
      continue;
    }
    if (key !== "--database-url-env" && key !== "--asset-id")
      throw new Error("Unknown or duplicate argument");
    const value = args[++index];
    if (!value || value.startsWith("--") || options.has(key))
      throw new Error("Missing or duplicate argument");
    options.set(key, value);
  }
  const variable = options.get("--database-url-env");
  if (!variable || !/^[A-Z][A-Z0-9_]*$/u.test(variable))
    throw new Error("An explicit database URL environment variable name is required");
  const assetId = Schema.decodeUnknownSync(AvatarAssetId)(options.get("--asset-id"));
  return { variable, assetId, apply };
}

async function main(args: readonly string[]) {
  if (args.length === 1 && args[0] === "--help") {
    console.log("remove-avatar --database-url-env NAME --asset-id avatar-UUID [--apply]");
    console.log(
      "Defaults to a read-only preview. Apply revokes delivery; the cleanup job deletes bytes later.",
    );
    return;
  }
  const { variable, assetId, apply } = parseAvatarRemoval(args);
  const raw = process.env[variable];
  if (!raw) throw new Error("Database URL is not configured");
  const connectionString = normalizePostgresConnectionString(raw);
  if (!["postgres:", "postgresql:"].includes(new URL(connectionString).protocol))
    throw new Error("Invalid database URL protocol");
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const identity = yield* db.execute<{
          principal: string;
          database_name: string;
          authorized: boolean;
        }>({
          label: "avatars.operator.authority",
          text: "SELECT session_user AS principal,current_database() AS database_name,(r.rolsuper OR pg_has_role(session_user,d.datdba,'USAGE')) AS authorized FROM pg_roles r JOIN pg_database d ON d.datname=current_database() WHERE r.rolname=session_user",
          values: [],
          readonly: true,
        });
        const operator = identity.rows[0];
        if (operator?.authorized !== true || typeof operator.principal !== "string")
          return yield* Effect.fail(new Error("Database operator required"));
        if (apply) yield* makeAvatarStoreFromDb(db).remove(assetId);
        const asset = yield* db.execute<{ state: string; moderation_status: string }>({
          label: "avatars.operator.report",
          text: "SELECT state,moderation_status FROM avatar_assets WHERE asset_id=$1",
          values: [assetId],
          readonly: true,
        });
        return {
          asset_id: assetId,
          apply,
          operator_role: operator.principal,
          database: operator.database_name,
          delivery_revoked: apply,
          asset: asset.rows[0] ?? null,
        };
      }).pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connectionString))),
    ),
  );
  console.log(JSON.stringify(result));
}
if (import.meta.main) {
  main(process.argv.slice(2)).catch(() => {
    // Driver errors can contain credentials or database values. Never print them.
    console.error(
      "Avatar removal failed; verify arguments, target and database access. No automatic retry was attempted.",
    );
    process.exitCode = 1;
  });
}
