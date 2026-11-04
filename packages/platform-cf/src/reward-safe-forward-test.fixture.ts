/** Local forward-migration fixture. Rendered baselines deliberately omit ledger
 * data; record the exact verified predecessor prefix before the normal runner. */
import { createHash } from "node:crypto";
import { Client } from "pg";
import { loadPostgresMigrations,runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";

export async function upgradeLocalSafeTestSchema(connectionString:string) {
  const u=new URL(connectionString);
  if(u.hostname!=="127.0.0.1" || u.port!=="54387" || u.pathname!=="/rewards_source_test" || !/search_path=rewards_(lifecycle|safe)_[a-f0-9]+/.test(u.searchParams.get("options")??"")) throw new Error("assigned_schema_required");
  const client=new Client({connectionString});await client.connect();
  const migrations=await loadPostgresMigrations();
  try {
    const r=await client.query("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='reward_safe_settlements_v1' AND column_name='preparation_owner') AS repaired,(SELECT count(*)::int FROM schema_migrations) AS ledger");
    if(r.rows[0]?.ledger===0) {
      const predecessor=migrations.filter(m=>m.version<"0271_");
      const prefix=r.rows[0]?.repaired ? migrations : predecessor;
      // The schema was loaded once from a checksummed parent render, not replayed SQL.
      if(!r.rows[0]?.repaired) {
        const bytes=await Bun.file(new URL("../../../db/postgres/schema.sql",import.meta.url)).bytes();
        const provenance=await Bun.file(new URL("../../../.wrangler/rewards-source-agent/repair-9414/predecessor-schema.json",import.meta.url)).json();
        if(createHash("sha256").update(bytes).digest("hex")!==provenance.sha256) throw new Error("predecessor_baseline_identity_required");
      }
      await client.query("INSERT INTO schema_migrations(version,checksum) SELECT version,checksum FROM jsonb_to_recordset($1::jsonb) AS x(version text,checksum text)",[JSON.stringify(prefix.map(({version,checksum})=>({version,checksum})))]);
    }
  } finally {await client.end();}
  return runPostgresMigrations({connectionString,migrations});
}
