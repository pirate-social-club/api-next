import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { withDanceServingPermissionFixture } from "./dance-serving-permissions.pg-fixture.ts";

const connection = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connection === undefined)
  throw Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = connection === undefined ? describe.skip : describe;
const signature = "guard_media_submission_update_rating_v2()";
const lockedRead =
  "SELECT * INTO moderation_action FROM media_moderation_actions WHERE action_id=NEW.moderator_action_id AND community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id FOR SHARE;";
const catalog = `SELECT to_jsonb(p)-'prosrc' AS metadata,p.prosrc AS source,
 encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS source_sha256,
 pg_get_functiondef(p.oid) AS definition FROM pg_proc p WHERE p.oid=$1::regprocedure`;

suite("immutable song moderation action migration", () => {
  test("upgrades only the active guard read and preserves its role and trigger boundaries", async () => {
    if (connection === undefined) throw Error("Fixture database unavailable");
    await withDanceServingPermissionFixture(
      connection,
      async (f) => {
        const runtime = await f.makeRole();
        const table = `${f.quote(f.schema)}.media_moderation_actions`;
        await f.owner.query(`GRANT SELECT,INSERT ON ${table} TO ${f.quote(runtime.role)}`);
        const boundary = async () =>
          (
            await f.owner.query(
              "SELECT has_table_privilege($1,$2,'SELECT') AS can_select,has_table_privilege($1,$2,'INSERT') AS can_insert,has_table_privilege($1,$2,'UPDATE') AS can_update,has_table_privilege($1,$2,'DELETE') AS can_delete",
              [runtime.role, table],
            )
          ).rows;
        const expected = [
          { can_select: true, can_insert: true, can_update: false, can_delete: false },
        ];
        expect(await boundary()).toEqual(expected);
        const before = (await f.owner.query(catalog, [signature])).rows[0];
        expect(before.source_sha256).toBe(
          "e40a5726dc0e828a12a8af55aaa473ce1eb401bde36dfa9b35304b022f4761f6",
        );
        const triggers = async () =>
          (
            await f.owner.query(
              "SELECT oid,tgname,tgfoid,tgenabled,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgrelid=ANY(ARRAY['media_post_submissions'::regclass,'media_moderation_actions'::regclass]) ORDER BY oid",
            )
          ).rows;
        const beforeTriggers = await triggers();
        await f.upgrade();
        const after = (await f.owner.query(catalog, [signature])).rows[0];
        expect(after.metadata).toEqual(before.metadata);
        expect(after.source).toBe(
          before.source.replace(lockedRead, lockedRead.replace(" FOR SHARE", "")),
        );
        expect(after.source_sha256).toBe(
          "fbd9ec4f05ce8c93ceaa758e21cb865a499e2ae9f1c0695c255a8d36baa5d8d8",
        );
        expect(await triggers()).toEqual(beforeTriggers);
        expect(await boundary()).toEqual(expected);
        const client = new Client({ connectionString: runtime.url });
        await client.connect();
        try {
          await expect(
            client.query(`UPDATE ${table} SET evidence_ref=evidence_ref WHERE FALSE`),
          ).rejects.toMatchObject({ code: "42501" });
          await expect(client.query(`DELETE FROM ${table} WHERE FALSE`)).rejects.toMatchObject({
            code: "42501",
          });
        } finally {
          await client.end();
        }
      },
      332,
    );
  }, 120_000);

  test("refuses source or active-trigger drift without changing the prefix", async () => {
    if (connection === undefined) throw Error("Fixture database unavailable");
    const migration = (await loadPostgresMigrations()).at(-1);
    expect(migration?.version).toBe("0333_media_moderation_immutable_action.sql");
    if (migration === undefined) throw Error("Moderation migration missing");
    await withDanceServingPermissionFixture(
      connection,
      async (f) => {
        const before = (await f.owner.query(catalog, [signature])).rows[0];
        for (const drift of ["body", "trigger"] as const) {
          await f.owner.query("BEGIN");
          try {
            if (drift === "body")
              await f.owner.query(
                before.definition.replace("DECLARE", "DECLARE /* unexpected source */"),
              );
            else
              await f.owner.query(
                "DROP TRIGGER media_song_submission_update_guard ON media_post_submissions",
              );
            await expect(f.owner.query(migration.sql)).rejects.toMatchObject({
              code: "P0001",
              message: "active song moderation guard source is not recognized exactly",
            });
          } finally {
            await f.owner.query("ROLLBACK");
          }
          expect((await f.owner.query(catalog, [signature])).rows[0]).toEqual(before);
          expect(
            (await f.owner.query("SELECT count(*)::int AS count FROM schema_migrations")).rows,
          ).toEqual([{ count: 332 }]);
        }
      },
      332,
    );
  }, 120_000);
});
