import { Client } from "pg";
import { normalizePostgresConnectionString } from "../postgres-connection-string.ts";
import {
  type IsolatedDatabaseIdentity,
  validateIsolatedDatabaseIdentity,
} from "./bootstrap-database.ts";
import { verifyRetiredDatabase } from "./retired-stack-inventory.ts";
import { fixture } from "./seed-fixtures.ts";

/** Import the existing song's catalog and alignment pointer, without creating provider evidence. */
export async function repairFixtureContent(
  sourceUrl: string,
  targetUrl: string,
  identity: IsolatedDatabaseIdentity,
  apply = false,
) {
  verifyRetiredDatabase(sourceUrl);
  validateIsolatedDatabaseIdentity(targetUrl, identity);
  if (identity.branchId !== "l8mhyb0fxy54") throw Error("Isolated repair branch differs");
  const source = new Client({
    connectionString: normalizePostgresConnectionString(sourceUrl),
    connectionTimeoutMillis: 10000,
  });
  const target = new Client({
    connectionString: normalizePostgresConnectionString(targetUrl),
    connectionTimeoutMillis: 10000,
  });
  try {
    await source.connect();
    await target.connect();
    await source.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await target.query("BEGIN");
    await target.query("SET LOCAL search_path TO api_next, public");
    const empty = await target.query(
      "SELECT (SELECT count(*) FROM song_reward_offers)+(SELECT count(*) FROM reward_chain_effects)+(SELECT count(*) FROM study_sessions_v2)+(SELECT count(*) FROM karaoke_attempts) AS total",
    );
    if (String(empty.rows[0]?.total) !== "0")
      throw Error("Fixture content repair requires no activity or money");
    const report = [];
    for (const table of [
      "localization_lyrics_revision_lines",
      "media_alignment_projections",
    ] as const) {
      const rows = (
        await source.query(`SELECT * FROM api_next.${table} WHERE community_id=$1 AND post_id=$2`, [
          fixture.community,
          fixture.song,
        ])
      ).rows;
      if (
        !rows.length ||
        (table === "media_alignment_projections" &&
          (rows.length !== 1 || rows[0]?.status !== "ready"))
      )
        throw Error("Existing fixture readiness evidence missing");
      const existing = (
        await target.query(`SELECT * FROM api_next.${table} WHERE community_id=$1 AND post_id=$2`, [
          fixture.community,
          fixture.song,
        ])
      ).rows;
      if (existing.length) throw Error("Content repair refuses to replace existing rows");
      if (apply) {
        if (table === "media_alignment_projections") {
          const guard = await target.query(
            "SELECT tgenabled FROM pg_trigger WHERE tgrelid='api_next.media_alignment_projections'::regclass AND tgname='media_alignment_insert_guard'",
          );
          if (guard.rows.length !== 1 || guard.rows[0]?.tgenabled !== "O")
            throw Error("Alignment import guard differs");
          await target.query(
            "ALTER TABLE media_alignment_projections DISABLE TRIGGER media_alignment_insert_guard",
          );
        }
        for (const row of rows) {
          const generated = (
            await target.query(
              "SELECT column_name FROM information_schema.columns WHERE table_schema='api_next' AND table_name=$1 AND is_generated <> 'NEVER'",
              [table],
            )
          ).rows.map((item) => item.column_name);
          const keys = Object.keys(row).filter((key) => !generated.includes(key));
          if (keys.some((key) => !/^[a-z][a-z0-9_]*$/.test(key)))
            throw Error("Fixture column differs");
          await target.query(
            `INSERT INTO api_next.${table} (${keys.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`,
            keys.map((key) => row[key]),
          );
        }
        if (table === "media_alignment_projections")
          await target.query(
            "ALTER TABLE media_alignment_projections ENABLE TRIGGER media_alignment_insert_guard",
          );
      }
      report.push({ table, rows: rows.length });
    }
    await target.query(apply ? "COMMIT" : "ROLLBACK");
    await source.query("COMMIT");
    return {
      applied: apply,
      scope: "Exact existing isolated song readiness; no simulated activity or grading",
      tables: report,
    };
  } catch (error) {
    await target.query("ROLLBACK").catch(() => {});
    await source.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await target.end().catch(() => {});
    await source.end().catch(() => {});
  }
}
