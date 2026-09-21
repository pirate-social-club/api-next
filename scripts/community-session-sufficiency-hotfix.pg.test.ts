import { describe, expect, test } from "bun:test";
import type { Client } from "pg";
import {
  executeCommunitySessionHotfix,
  observeCommunitySessionHotfix,
} from "./community-session-sufficiency-hotfix.ts";
import { loadPostgresMigrations } from "./postgres-migrations.ts";
import { withReusablePostgresTestSchema } from "./postgres-test-baseline.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;

async function transitionToActiveWithPendingWallet(client: Client, suffix: string): Promise<void> {
  const accountId = `hotfix-account-${suffix}`;
  const personaId = `hotfix-persona-${suffix}`;
  await client.query("BEGIN");
  try {
    await client.query(
      "INSERT INTO users(user_id,status,account) VALUES($1,'active','{}'::jsonb)",
      [accountId],
    );
    await client.query(
      "INSERT INTO personas(persona_id,account_id,status,is_first_persona) VALUES($1,$2,'pending_wallet',false)",
      [personaId, accountId],
    );
    await client.query(
      "INSERT INTO persona_pending_profiles(persona_id,display_name) VALUES($1,'Hotfix owner')",
      [personaId],
    );
    await client.query(
      `INSERT INTO persona_wallet_assignments(
         assignment_id,persona_id,account_id,chain_account_kind,hd_wallet_index,
         status,reservation_idempotency_key
       ) VALUES($1,$2,$3,'evm',1,'pending',$4)`,
      [`hotfix-wallet-${suffix}`, personaId, accountId, `hotfix-reservation-${suffix}`],
    );
    await client.query(
      `INSERT INTO persona_profiles(
         persona_id,revision,display_name,avatar_ref,cover_ref,bio,
         preferred_locale,created_at,updated_at
       ) SELECT persona_id,1,display_name,avatar_ref,cover_ref,bio,
                preferred_locale,created_at,clock_timestamp()
           FROM persona_pending_profiles WHERE persona_id=$1`,
      [personaId],
    );
    await client.query("UPDATE personas SET status='active' WHERE persona_id=$1", [personaId]);
    await client.query("DELETE FROM persona_pending_profiles WHERE persona_id=$1", [personaId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

suite("community session sufficiency production compatibility operator", () => {
  test("applies, independently observes, restores, and preserves the migration ledger", async () => {
    if (connectionString === undefined) throw new Error("PostgreSQL test URL required");
    await withReusablePostgresTestSchema({
      baseConnectionString: connectionString,
      schemaName: "community_session_sufficiency_hotfix_pg_test",
      use: async ({ admin }) => {
        const migrations = await loadPostgresMigrations();
        await admin.query(
          `INSERT INTO schema_migrations(version,checksum)
           SELECT version,checksum
             FROM jsonb_to_recordset($1::jsonb) AS migration(version text,checksum text)`,
          [JSON.stringify(migrations.map(({ version, checksum }) => ({ version, checksum })))],
        );
        const before = await observeCommunitySessionHotfix(admin, "before");
        expect(before).toMatchObject({
          ledgerCount: 136,
          ledgerTip: "0136_hns_existing_name_attachment.sql",
          state: "before",
        });

        const applied = await executeCommunitySessionHotfix(admin, "apply");
        expect(applied).toMatchObject({
          ledgerCount: 136,
          ledgerTip: "0136_hns_existing_name_attachment.sql",
          state: "after",
        });
        let restored = before;
        try {
          await expect(
            transitionToActiveWithPendingWallet(admin, "accepted"),
          ).resolves.toBeUndefined();
        } finally {
          restored = await executeCommunitySessionHotfix(admin, "restore");
        }
        expect(restored).toMatchObject({
          ledgerCount: 136,
          ledgerTip: "0136_hns_existing_name_attachment.sql",
          state: "before",
        });
        await expect(transitionToActiveWithPendingWallet(admin, "rejected")).rejects.toThrow(
          "public persona requires one confirmed wallet and profile",
        );
        await expect(observeCommunitySessionHotfix(admin, "before")).resolves.toEqual(restored);
      },
    });
  }, 30_000);
});
