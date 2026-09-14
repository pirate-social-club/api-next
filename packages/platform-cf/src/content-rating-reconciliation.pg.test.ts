import { afterAll, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  withReusablePostgresTestSchema,
} from "../../../scripts/postgres-test-baseline.ts";
import { activatePendingPersonaFixtures } from "./persona-wallet.pg-fixture.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && url === undefined)
  throw new Error("PostgreSQL test URL required");
const suite = url === undefined ? describe.skip : describe;
const sentinel =
  process.env.CONTROL_PLANE_POSTGRES_RATING_RECONCILIATION_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-rating-reconciliation-suite-complete";
let completed = 0;
async function fixture(use: (admin: Client) => Promise<void>) {
  if (url === undefined) throw new Error("PostgreSQL test URL required");
  await withReusablePostgresTestSchema({
    baseConnectionString: url,
    schemaName: "content_rating_reconciliation_pg",
    use: async ({ admin, schema }) => {
      const scoped = new URL(url);
      scoped.searchParams.set("options", `-c search_path=${schema}`);
      await applyPostgresTestBaselineConnection({ connectionString: scoped.toString() });
      await admin.query(`SET search_path TO "${schema}"`);
      await admin.query("INSERT INTO users(user_id) VALUES('rating_owner')");
      await activatePendingPersonaFixtures(admin);
      await admin.query(
        "INSERT INTO communities(community_id,display_name,status,created_by_user_id,created_at,updated_at) VALUES('rating_community','Rating fixture','active','rating_owner',now(),now())",
      );
      await use(admin);
    },
  });
  completed += 1;
}
async function post(admin: Client, id: string) {
  await admin.query(
    "INSERT INTO posts(community_id,post_id,post_type,created_at,updated_at) VALUES('rating_community',$1,'text',now(),now())",
    [id],
  );
}
async function plan(admin: Client) {
  const row = (
    await admin.query<{ plan: { plan_hash: string; items: readonly { outcome: string }[] } }>(
      "SELECT content_rating_reconciliation_plan_v1(100) AS plan",
    )
  ).rows[0];
  if (row === undefined) throw new Error("missing reconciliation plan");
  return row.plan;
}
async function cli(admin: Client, args: readonly string[] = []) {
  if (url === undefined) throw new Error("PostgreSQL test URL required");
  const scoped = new URL(url);
  const schema = (await admin.query("SELECT current_schema() AS schema")).rows[0].schema;
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  const child = Bun.spawn(
    [
      process.execPath,
      "scripts/reconcile-content-ratings.ts",
      "--database-url-env",
      "RATING_RECONCILIATION_FIXTURE_URL",
      ...args,
    ],
    {
      env: { ...process.env, RATING_RECONCILIATION_FIXTURE_URL: scoped.toString() },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  return JSON.parse(stdout);
}
async function apply(admin: Client, hash: string, rollback = false) {
  await admin.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const report = (
      await admin.query("SELECT apply_content_rating_reconciliation_v1($1,100) AS report", [hash])
    ).rows[0].report;
    await admin.query(rollback ? "ROLLBACK" : "COMMIT");
    return report;
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}
suite("retained content rating reconciliation", () => {
  test("recognizes accepted adult categories while refusing missing or malformed evidence", async () => {
    await fixture(async (admin) => {
      for (const [categories, bound, declared, expected] of [
        [[], true, "general", "general"],
        [["sexual"], true, "general", "adult_18"],
        [["violence/graphic"], true, "general", "adult_18"],
        [[], true, "adult_18", "adult_18"],
        [["sexual/minors"], true, "adult_18", "held"],
        [["sexual"], false, "general", "held"],
        [["unknown"], true, "general", "held"],
        [["sexual", "sexual"], true, "general", "held"],
        [{}, true, "general", "held"],
        [null, true, "general", "held"],
      ] as const) {
        expect(
          (
            await admin.query("SELECT retained_categories_rating_v1($1::jsonb,$2,$3) AS rating", [
              JSON.stringify(categories),
              bound,
              declared,
            ])
          ).rows[0].rating,
        ).toBe(expected);
      }
      const frames = ["poster", "first", "midpoint"].map((role, index) => ({
        role,
        sha256: String(index + 1).repeat(64),
      }));
      const analysis = {
        frames: { extracted: frames },
        safetyRequest: { frameSha256s: frames.map((f) => f.sha256), captionSha256: null },
      };
      const inputs = frames.map((f, index) => ({
        role: f.role,
        sha256: f.sha256,
        outcome: "evaluated",
        provider: {
          provider_id: "openai",
          input_sha256: f.sha256,
          matched_categories: index === 0 ? ["sexual"] : [],
        },
        resolution: { matched_categories: index === 0 ? ["sexual"] : [] },
      }));
      const read = async (evidence: unknown) =>
        (
          await admin.query(
            "SELECT retained_video_rating_v1($1::jsonb,$2::jsonb,true,'general') AS rating",
            [JSON.stringify(analysis), JSON.stringify(evidence)],
          )
        ).rows[0].rating;
      expect(await read({ inputs })).toBe("adult_18");
      expect(await read({ inputs: inputs.slice(0, 2) })).toBe("held");
      expect(
        await read({ inputs: [{ ...inputs[0], outcome: "unavailable" }, ...inputs.slice(1)] }),
      ).toBe("held");
      expect(
        await read({ inputs: [{ ...inputs[0], sha256: "0".repeat(64) }, ...inputs.slice(1)] }),
      ).toBe("held");
    });
  });
  test("plans without writes, holds unknown content, rejects moderator release and replays without effects", async () => {
    await fixture(async (admin) => {
      await post(admin, "unknown_post");
      await admin.query(
        "INSERT INTO comments(community_id,comment_id,post_id,created_at,updated_at) VALUES('rating_community','unknown_comment','unknown_post',now(),now())",
      );
      const proposed = await plan(admin);
      expect(await cli(admin)).toEqual({
        ...proposed,
        version: "content-rating-reconciliation-v1",
        limit: 100,
      });
      expect(proposed.items).toHaveLength(2);
      expect(proposed.items.every((item) => item.outcome === "held")).toBe(true);
      expect(
        (await admin.query("SELECT status FROM posts WHERE post_id='unknown_post'")).rows[0].status,
      ).toBe("published");
      expect(await cli(admin, ["--apply", "--plan-hash", proposed.plan_hash])).toMatchObject({
        status: "applied",
        resources: 2,
      });
      expect(
        (await admin.query("SELECT status FROM posts WHERE post_id='unknown_post'")).rows[0].status,
      ).toBe("hidden");
      expect(
        (await admin.query("SELECT status FROM comments WHERE comment_id='unknown_comment'"))
          .rows[0].status,
      ).toBe("hidden");
      expect(await apply(admin, proposed.plan_hash)).toMatchObject({
        status: "replayed",
        resources: 2,
      });
      expect((await plan(admin)).items).toHaveLength(0);
      await expect(
        admin.query("UPDATE posts SET status='published' WHERE post_id='unknown_post'"),
      ).rejects.toThrow("current rating evidence is unresolved");
      await expect(
        admin.query("UPDATE comments SET status='published' WHERE comment_id='unknown_comment'"),
      ).rejects.toThrow("current rating evidence is unresolved");
      await expect(
        admin.query("DELETE FROM content_rating_reconciliation_current"),
      ).rejects.toThrow("cannot be deleted");
      await expect(
        admin.query("UPDATE content_rating_reconciliation_events SET outcome='general'"),
      ).rejects.toThrow("history is immutable");
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM content_rating_reconciliation_operations",
          )
        ).rows[0].count,
      ).toBe(1);
    });
  });
  test("rejects a changed plan and rolls every resource and audit row back together", async () => {
    await fixture(async (admin) => {
      await post(admin, "first_post");
      const initial = await plan(admin);
      await post(admin, "second_post");
      await expect(apply(admin, initial.plan_hash)).rejects.toThrow("plan changed");
      const fresh = await plan(admin);
      await apply(admin, fresh.plan_hash, true);
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM posts WHERE status='published'"))
          .rows[0].count,
      ).toBe(2);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM content_rating_reconciliation_operations",
          )
        ).rows[0].count,
      ).toBe(0);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM content_rating_reconciliation_current",
          )
        ).rows[0].count,
      ).toBe(0);
      await expect(
        admin.query("SELECT apply_content_rating_reconciliation_v1($1,100)", [fresh.plan_hash]),
      ).rejects.toThrow("serializable transaction");
    });
  });
  afterAll(async () => {
    if (url !== undefined && completed === 3)
      await Bun.write(
        sentinel,
        "api-next-control-plane-postgres-rating-reconciliation-suite-complete\n",
      );
  });
});
