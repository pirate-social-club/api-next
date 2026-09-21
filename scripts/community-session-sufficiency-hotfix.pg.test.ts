import { describe, expect, test } from "bun:test";
import { Client } from "pg";
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
      use: async ({ admin, connectionString: scopedConnectionString }) => {
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
        await expect(
          transitionToActiveWithPendingWallet(admin, "accepted"),
        ).resolves.toBeUndefined();
        await expect(executeCommunitySessionHotfix(admin, "restore")).rejects.toThrow(
          "community_session_hotfix_restore_data_precondition_failed",
        );
        await admin.query("BEGIN");
        try {
          await admin.query(
            `UPDATE persona_wallet_assignments
                SET status='active',address=$2,assigned_at=clock_timestamp(),updated_at=clock_timestamp()
              WHERE persona_id=$1`,
            ["hotfix-persona-accepted", "0x1111111111111111111111111111111111111111"],
          );
          await admin.query("COMMIT");
        } catch (error) {
          await admin.query("ROLLBACK").catch(() => undefined);
          throw error;
        }
        const restored = await executeCommunitySessionHotfix(admin, "restore");
        expect(restored).toMatchObject({
          ledgerCount: 136,
          ledgerTip: "0136_hns_existing_name_attachment.sql",
          state: "before",
        });
        await expect(transitionToActiveWithPendingWallet(admin, "rejected")).rejects.toThrow(
          "public persona requires one confirmed wallet and profile",
        );
        await expect(observeCommunitySessionHotfix(admin, "before")).resolves.toEqual(restored);

        await admin.query("ALTER FUNCTION validate_persona_wallet_activation() STRICT");
        await expect(observeCommunitySessionHotfix(admin, "before")).rejects.toThrow(
          "community_session_hotfix_before_function_mismatch",
        );
        await admin.query(
          "ALTER FUNCTION validate_persona_wallet_activation() CALLED ON NULL INPUT",
        );

        const concurrent = new Client({ connectionString: scopedConnectionString });
        await concurrent.connect();
        try {
          let attempted = false;
          await executeCommunitySessionHotfix(admin, "apply", async () => {
            attempted = true;
            await concurrent.query("SET lock_timeout='100ms'");
            await expect(
              concurrent.query(
                "INSERT INTO schema_migrations(version,checksum) VALUES('9999_concurrent.sql','blocked')",
              ),
            ).rejects.toThrow(/lock timeout|canceling statement due to lock timeout/u);
          });
          expect(attempted).toBe(true);
        } finally {
          await concurrent.end();
          await executeCommunitySessionHotfix(admin, "restore");
        }
      },
    });
  }, 30_000);
});
