import { describe, expect, mock, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { Client } from "pg";
import {
  GetPublicCommunityThreads,
  GetPublicHomeFeed,
} from "../../../packages/contracts/src/v1.ts";
import { activatePendingPersonaFixtures } from "../../../packages/platform-cf/src/persona-wallet.pg-fixture.ts";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeHttpWorkerTestBindings } from "./composition.test-fixtures.ts";

mock.module("cloudflare:workers", () => ({ DurableObject: class DurableObject {} }));
const { createProductionHttpWorker } = await import("./composition.ts");
const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connectionString === undefined)
  throw new Error("Public Community composition requires the PostgreSQL test connection");
const errorResponse = Schema.Struct({
  error: Schema.Struct({ code: Schema.String }),
  request_id: Schema.optional(Schema.String),
});
const suite = connectionString === undefined ? describe.skip : describe;

suite("installed anonymous Community feed", () => {
  test("matches home visibility, redacts age-locked posts, observes moderation and never caches", async () => {
    if (connectionString === undefined) throw new Error();
    // Production pins search_path=api_next,pg_catalog. A disposable database tests that real
    // constructor without overriding its namespace boundary or sharing tables.
    const database = `public_feed_${crypto.randomUUID().replaceAll("-", "")}`;
    const control = new Client({ connectionString });
    await control.connect();
    await control.query(`CREATE DATABASE "${database}"`);
    const url = new URL(connectionString);
    url.pathname = `/${database}`;
    url.searchParams.set("options", "-c search_path=api_next");
    const connection = url.toString();
    const admin = new Client({ connectionString: connection });
    try {
      await admin.connect();
      await admin.query("CREATE SCHEMA api_next");
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      const created = new Date("2026-09-01T00:00:00Z");
      await admin.query("INSERT INTO users(user_id) VALUES('feed-fixture-owner')");
      await activatePendingPersonaFixtures(admin);
      await admin.query(
        `INSERT INTO communities
        (community_id,route_slug,display_name,status,created_by_user_id,created_at,updated_at)
        VALUES ('feed-fixture','feed-fixture','Feed fixture','active','feed-fixture-owner',$1,$1),
               ('empty-fixture','empty-fixture','Empty fixture','active','feed-fixture-owner',$1,$1)`,
        [created],
      );
      for (const [id, rating, visibility, status] of [
        ["public-post", "general", "public", "published"],
        ["locked-post", "adult_18", "public", "published"],
        ["private-post", "general", "members_only", "published"],
        ["removed-post", "general", "public", "removed"],
      ]) {
        await admin.query(
          `INSERT INTO posts
          (post_id,community_id,author_user_id,author_persona_id,post_type,status,visibility,
           content_rating,title,body,created_at,updated_at)
          VALUES($1,'feed-fixture','feed-fixture-owner',
            (SELECT persona_id FROM personas WHERE account_id='feed-fixture-owner' AND is_first_persona),
            'text',$2,$3,$4,$1,$1,$5,$5)`,
          [id, status, visibility, rating, created],
        );
        await admin.query(
          `INSERT INTO home_feed_projection
          (community_id,feed_item_id,post_id,rank_score,projected_at)
          VALUES('feed-fixture',$1,$2,1,$3)`,
          [`item-${id}`, id, created],
        );
      }
      const worker = await createProductionHttpWorker(await makeHttpWorkerTestBindings(connection));
      const artifacts: Record<string, unknown> = {};
      async function read<S extends Schema.ConstraintDecoder<unknown>>(
        name: string,
        path: string,
        schema: S,
        headers?: Record<string, string>,
      ) {
        const response = await worker.fetch(new Request(`https://api.test${path}`, { headers }));
        const rawBody: unknown = await response.json();
        const body = Schema.decodeUnknownSync(schema)(rawBody);
        artifacts[name] = {
          status: response.status,
          headers: {
            "cache-control": response.headers.get("cache-control"),
            "content-type": response.headers.get("content-type"),
          },
          body:
            response.status >= 400
              ? {
                  ...(typeof rawBody === "object" && rawBody !== null ? rawBody : {}),
                  request_id: "00000000-0000-4000-8000-000000000000",
                }
              : rawBody,
        };
        return { response, body };
      }
      const path = "/public-communities/feed-fixture/feed?surface=threads&sort=new&locale=en";
      const initial = await read("mixed", path, GetPublicCommunityThreads.response);
      expect(initial.response.status).toBe(200);
      expect(initial.response.headers.get("cache-control")).toBe("no-store");
      expect(initial.body.items).toHaveLength(2);
      expect(JSON.stringify(initial.body)).toContain("public-post");
      for (const hidden of ["locked-post", "private-post", "removed-post"])
        expect(JSON.stringify(initial.body)).not.toContain(hidden);
      const locked = initial.body.items.find((item) => "kind" in item);
      expect(locked).toBeDefined();
      if (locked === undefined) throw new Error("Expected anonymous age-locked projection");
      expect(locked.kind).toBe("age_locked");
      const home = await read(
        "home-mixed",
        "/feed/home/public?sort=new&time_range=all&locale=en",
        GetPublicHomeFeed.response,
      );
      expect(home.response.status).toBe(200);
      expect(home.body.items).toHaveLength(2);
      const communityPost = initial.body.items.find((item) => "post" in item);
      if (communityPost === undefined) throw new Error("Expected public Community post");
      expect(home.body.items.find((item) => "post" in item)?.post).toMatchObject(communityPost);
      expect(home.body.items.find((item) => "kind" in item)).toEqual(locked);
      expect(JSON.stringify(home.body)).toContain("public-post");
      for (const hidden of ["locked-post", "private-post", "removed-post"])
        expect(JSON.stringify(home.body)).not.toContain(hidden);
      for (const headers of [
        { authorization: "Bearer fixture-untrusted" },
        { cookie: "pirate_session=fixture-untrusted" },
      ]) {
        const withCredentials = await read(
          "credential-present",
          path,
          GetPublicCommunityThreads.response,
          headers,
        );
        expect(withCredentials.response.status).toBe(200);
        expect(withCredentials.body).toEqual(initial.body);
        expect(withCredentials.response.headers.get("cache-control")).toBe("no-store");
      }
      const empty = await read(
        "empty",
        "/public-communities/empty-fixture/feed?surface=threads&sort=new",
        GetPublicCommunityThreads.response,
      );
      expect(empty.response.status).toBe(200);
      expect(empty.body.items).toEqual([]);
      expect(empty.response.headers.get("cache-control")).toBe("no-store");
      const missing = await read(
        "missing",
        "/public-communities/missing-fixture/feed?surface=threads&sort=new",
        errorResponse,
      );
      expect(missing.response.status).toBe(404);
      expect(missing.body.error.code).toBe("not_found");
      expect(missing.response.headers.get("cache-control")).toBe("no-store");
      await admin.query("UPDATE posts SET status='removed' WHERE post_id='public-post'");
      const removed = await read("locked-only", path, GetPublicCommunityThreads.response);
      expect(removed.body.items).toEqual([locked]);
      expect(
        (
          await read(
            "home-locked-only",
            "/feed/home/public?sort=new&time_range=all",
            GetPublicHomeFeed.response,
          )
        ).body.items,
      ).toEqual([locked]);
      await admin.query("UPDATE posts SET content_rating='general' WHERE post_id='locked-post'");
      const rerated = await read("public-only", path, GetPublicCommunityThreads.response);
      expect(rerated.body.items).toHaveLength(1);
      expect(JSON.stringify(rerated.body)).toContain("locked-post");
      expect(
        (
          await read(
            "home-rerated",
            "/feed/home/public?sort=new&time_range=all",
            GetPublicHomeFeed.response,
          )
        ).body.items.find((item) => "post" in item)?.post.post.id,
      ).toBe("locked-post");
      await admin.query("ALTER TABLE posts RENAME TO unavailable_posts_fixture");
      const failed = await read("failed", path, errorResponse);
      expect(failed.response.status).toBe(500);
      expect(failed.body.error.code).toBe("internal_error");
      expect(failed.response.headers.get("cache-control")).toBe("no-store");
      const output = process.env.PUBLIC_COMMUNITY_FEED_FIXTURE_DIRECTORY;
      if (output !== undefined) {
        await mkdir(output, { recursive: true });
        for (const [name, fixture] of Object.entries(artifacts))
          await Bun.write(join(output, `${name}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
      }
    } finally {
      await admin.end();
      await control.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      await control.end();
    }
  }, 120000);
});
