import { describe, expect, test } from "bun:test";
import type { CommunityStore } from "@pirate/application";
import { Effect } from "effect";
import { Client } from "pg";

import { runPostgresMigrations } from "../../../scripts/postgres-migrations";
import { makeControlPlaneCommunityStore } from "./community-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;

function schemaIdentifier(): string {
  return `api_next_community_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function connectionForSchema(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

async function withSchema<A>(use: (connection: string, admin: Client) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  const schema = schemaIdentifier();
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  try {
    return await use(connectionForSchema(connectionString, schema), admin);
  } finally {
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

function runStore<A, E>(
  connection: string,
  use: (store: CommunityStore["Service"]) => Effect.Effect<A, E>,
): Promise<A> {
  const layer = makeDirectPostgresControlPlaneLayer(connection);
  const store = makeControlPlaneCommunityStore(layer);
  return Effect.runPromise(Effect.scoped(use(store)));
}

suite("Postgres 17 community repository", () => {
  test("keeps membership and follow state scoped to the requested community", async () => {
    await withSchema(async (connection, admin) => {
      await runPostgresMigrations({ connectionString: connection });
      await admin.query({
        text: `INSERT INTO communities
          (community_id, display_name, status, created_by_user_id, created_at, updated_at)
          VALUES ($1, $2, 'active', $3, now(), now()),
                 ($4, $5, 'active', $3, now(), now())`,
        values: ["community-a", "A", "owner", "community-b", "B"],
      });
      await admin.query({
        text: `INSERT INTO community_memberships
          (community_id, membership_id, user_id, status, joined_at, created_at, updated_at)
          VALUES ('community-b', 'membership-b-user-a', 'user-a', 'member', now(), now(), now())`,
      });

      const preview = await runStore(connection, (store) =>
        store.getPreview({ communityId: "community-a", viewerUserId: "user-a" }),
      );
      expect(preview).toMatchObject({
        id: "community-a",
        viewer_membership_status: "not_member",
        member_count: 0,
        follower_count: 0,
      });

      await expect(
        runStore(connection, (store) =>
          store.follow({
            communityId: "community-a",
            actor: { userId: "user-a", kind: "user" },
          }),
        ),
      ).rejects.toMatchObject({ _tag: "CommunityRepositoryError", reason: "membership-required" });
    });
  }, 30_000);

  test("makes join and follow/unfollow idempotent for an open community", async () => {
    await withSchema(async (connection, admin) => {
      await runPostgresMigrations({ connectionString: connection });
      await admin.query({
        text: `INSERT INTO communities
          (community_id, display_name, status, created_by_user_id, created_at, updated_at)
          VALUES ('community-open', 'Open', 'active', 'owner', now(), now())`,
      });

      const firstJoin = await runStore(connection, (store) =>
        store.join({
          communityId: "community-open",
          actor: { userId: "user-a", kind: "user" },
          body: {},
        }),
      );
      const secondJoin = await runStore(connection, (store) =>
        store.join({
          communityId: "community-open",
          actor: { userId: "user-a", kind: "user" },
          body: {},
        }),
      );
      expect(firstJoin).toEqual({ community: "community-open", status: "joined" });
      expect(secondJoin).toEqual(firstJoin);

      const firstFollow = await runStore(connection, (store) =>
        store.follow({
          communityId: "community-open",
          actor: { userId: "user-a", kind: "user" },
        }),
      );
      const secondFollow = await runStore(connection, (store) =>
        store.follow({
          communityId: "community-open",
          actor: { userId: "user-a", kind: "user" },
        }),
      );
      expect(firstFollow).toEqual({
        community: "community-open",
        following: true,
        follower_count: 1,
      });
      expect(secondFollow).toEqual(firstFollow);

      const firstUnfollow = await runStore(connection, (store) =>
        store.unfollow({
          communityId: "community-open",
          actor: { userId: "user-a", kind: "user" },
        }),
      );
      const secondUnfollow = await runStore(connection, (store) =>
        store.unfollow({
          communityId: "community-open",
          actor: { userId: "user-a", kind: "user" },
        }),
      );
      expect(firstUnfollow).toEqual({
        community: "community-open",
        following: false,
        follower_count: 0,
      });
      expect(secondUnfollow).toEqual(firstUnfollow);
    });
  }, 30_000);

  test("does not turn a gated compatibility default into an implicit join", async () => {
    await withSchema(async (connection, admin) => {
      await runPostgresMigrations({ connectionString: connection });
      await admin.query({
        text: `INSERT INTO communities
          (community_id, display_name, status, membership_mode, created_by_user_id, created_at, updated_at)
          VALUES ('community-gated', 'Gated', 'active', 'gated', 'owner', now(), now())`,
      });

      await expect(
        runStore(connection, (store) =>
          store.join({
            communityId: "community-gated",
            actor: { userId: "user-a", kind: "user" },
            body: {},
          }),
        ),
      ).rejects.toMatchObject({ _tag: "CommunityRepositoryError", reason: "membership-required" });
      const memberships = await admin.query({
        text: "SELECT COUNT(*)::int AS count FROM community_memberships WHERE community_id = $1",
        values: ["community-gated"],
      });
      expect(memberships.rows[0]?.count).toBe(0);
    });
  }, 30_000);
});
