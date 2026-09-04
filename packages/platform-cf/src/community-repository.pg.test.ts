import { afterAll, describe, expect, test } from "bun:test";
import type { CommunityStore } from "@pirate/application";
import { Effect } from "effect";
import type { Client } from "pg";

import {
  applyPostgresTestBaselineConnection,
  withReusablePostgresTestSchema,
} from "../../../scripts/postgres-test-baseline.ts";
import { makeControlPlaneCommunityStore } from "./community-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_COMMUNITY_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-community-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-community-suite-complete\n";
let completedTestCount = 0;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function connectionForSchema(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

async function withSchema<A>(use: (connection: string, admin: Client) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  return withReusablePostgresTestSchema({
    baseConnectionString: connectionString,
    schemaName: "packages_platform_cf_src_community_repository_pg_test_ts",
    use: async ({ admin, schema }) => {
      await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      return await use(connectionForSchema(connectionString, schema), admin);
    },
  });
}

function runStore<A, E>(
  connection: string,
  use: (store: CommunityStore["Service"]) => Effect.Effect<A, E>,
): Promise<A> {
  const layer = makeDirectPostgresControlPlaneLayer(connection);
  const store = makeControlPlaneCommunityStore(layer);
  return Effect.runPromise(Effect.scoped(use(store)));
}

async function insertCommunityOwner(admin: Client): Promise<void> {
  await admin.query(
    "INSERT INTO users (user_id, status, account) VALUES ('owner', 'active', '{}'::jsonb)",
  );
}

async function insertJoinAccounts(admin: Client): Promise<void> {
  await insertCommunityOwner(admin);
  await admin.query(
    `INSERT INTO users (user_id, status, account)
     VALUES ('user-a', 'active', '{}'::jsonb),
            ('user-b', 'active', '{}'::jsonb),
            ('user-c', 'active', '{}'::jsonb),
            ('user-left', 'active', '{}'::jsonb),
            ('user-banned', 'active', '{}'::jsonb),
            ('user-pending', 'active', '{}'::jsonb)`,
  );
}

suite("Postgres 17 community repository", () => {
  test("lists only active memberships in active communities without requiring a route", async () => {
    await withSchema(async (connection, admin) => {
      const communityA = "community_00000000-0000-4000-8000-00000000000a";
      const communityB = "community_00000000-0000-4000-8000-00000000000b";
      const communityPending = "community_00000000-0000-4000-8000-00000000000c";
      const communityHidden = "community_00000000-0000-4000-8000-00000000000d";
      const communityLeft = "community_00000000-0000-4000-8000-00000000000e";
      const communityBanned = "community_00000000-0000-4000-8000-00000000000f";
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await insertJoinAccounts(admin);
      await admin.query({
        text: `INSERT INTO communities
          (community_id, display_name, status, created_by_user_id, route_authority_version,
           created_at, updated_at)
          VALUES ($1, 'Alpha', 'active', 'owner', 'optional_route_v2', now(), now()),
                 ($2, 'Beta', 'active', 'owner', 'optional_route_v2', now(), now()),
                 ($3, 'Pending', 'active', 'owner', 'optional_route_v2', now(), now()),
                 ($4, 'Hidden', 'hidden', 'owner', 'optional_route_v2', now(), now()),
                 ($5, 'Left', 'active', 'owner', 'optional_route_v2', now(), now()),
                 ($6, 'Banned', 'active', 'owner', 'optional_route_v2', now(), now())`,
        values: [
          communityA,
          communityB,
          communityPending,
          communityHidden,
          communityLeft,
          communityBanned,
        ],
      });
      await admin.query("BEGIN");
      await admin.query({
        text: `INSERT INTO community_memberships
          (community_id, membership_id, user_id, status, joined_at, created_at, updated_at)
          VALUES ($1, 'membership-list-a-user', 'user-a', 'member',
                  '2026-09-01T10:00:00.123001Z', '2026-09-01T10:00:00.123001Z', now()),
                 ($2, 'membership-list-b-user', 'user-a', 'member',
                  '2026-09-01T10:00:00.123002Z', '2026-09-01T10:00:00.123002Z', now()),
                 ($3, 'membership-list-pending-user', 'user-a', 'pending',
                  NULL, '2026-09-01T10:00:00.123003Z', now()),
                 ($4, 'membership-list-hidden-user', 'user-a', 'member',
                  '2026-09-01T10:00:00.123004Z', '2026-09-01T10:00:00.123004Z', now()),
                 ($5, 'membership-list-left-user', 'user-a', 'left',
                  NULL, '2026-09-01T10:00:00.123005Z', now()),
                 ($6, 'membership-list-banned-user', 'user-a', 'banned',
                  NULL, '2026-09-01T10:00:00.123006Z', now())`,
        values: [
          communityA,
          communityB,
          communityPending,
          communityHidden,
          communityLeft,
          communityBanned,
        ],
      });
      await admin.query({
        text: `INSERT INTO community_follows
          (community_follow_id, community_id, user_id, status, created_at, updated_at)
          VALUES ('membership-list-a-follow', $1, 'user-a', 'active', now(), now()),
                 ('membership-list-b-follow', $2, 'user-a', 'active', now(), now()),
                 ('membership-list-hidden-follow', $3, 'user-a', 'active', now(), now())`,
        values: [communityA, communityB, communityHidden],
      });
      await admin.query("COMMIT");

      const first = await runStore(connection, (store) =>
        store.listAccountMemberships({ userId: "user-a", query: { limit: "1" } }),
      );
      expect(first.items).toEqual([
        {
          object: "account_community_membership",
          community_id: communityA,
          display_name: "Alpha",
          resource_href: `/c/${communityA}`,
          canonical_route: null,
          membership_status: "member",
          can_post: true,
        },
      ]);
      expect(first.next_cursor).toStartWith("acm1.");

      const second = await runStore(connection, (store) =>
        store.listAccountMemberships({
          userId: "user-a",
          query: { cursor: first.next_cursor ?? undefined, limit: "1" },
        }),
      );
      expect(second.items.map((item) => item.community_id)).toEqual([communityB]);
      expect(second.next_cursor).toBeNull();
    });
    completedTestCount += 1;
  }, 30_000);

  test("keeps membership and follow state scoped to the requested community", async () => {
    await withSchema(async (connection, admin) => {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await insertCommunityOwner(admin);
      await admin.query({
        text: `INSERT INTO communities
          (community_id, display_name, status, created_by_user_id, created_at, updated_at)
          VALUES ($1, $2, 'active', $3, now(), now()),
                 ($4, $5, 'active', $3, now(), now())`,
        values: ["community-a", "A", "owner", "community-b", "B"],
      });
      await admin.query("BEGIN");
      await admin.query({
        text: `INSERT INTO community_memberships
          (community_id, membership_id, user_id, status, joined_at, created_at, updated_at)
          VALUES ('community-b', 'membership-b-user-a', 'user-a', 'member', now(), now(), now())`,
      });
      await admin.query({
        text: `INSERT INTO community_follows
          (community_follow_id, community_id, user_id, status, created_at, updated_at)
          VALUES ('follow-b-user-a', 'community-b', 'user-a', 'active', now(), now())`,
      });
      await admin.query("COMMIT");

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
      ).resolves.toEqual({
        community: "community-a",
        following: true,
        follower_count: 1,
      });
      const follows = await admin.query({
        text: "SELECT community_id FROM community_follows WHERE user_id = $1 ORDER BY community_id",
        values: ["user-a"],
      });
      expect(follows.rows).toEqual([
        { community_id: "community-a" },
        { community_id: "community-b" },
      ]);
    });
    completedTestCount += 1;
  }, 30_000);

  test("makes join and follow idempotent while protecting active follows", async () => {
    await withSchema(async (connection, admin) => {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await insertJoinAccounts(admin);
      await admin.query({
        text: `INSERT INTO communities
          (community_id, display_name, status, created_by_user_id, created_at, updated_at)
          VALUES ('community-open', 'Open', 'active', 'owner', now(), now())`,
      });

      const firstJoin = await runStore(connection, (store) =>
        store.join({
          communityId: "community-open",
          actor: { userId: "user-a", kind: "user" },
          body: { persona: { kind: "create_new" } },
        }),
      );
      const secondJoin = await runStore(connection, (store) =>
        store.join({
          communityId: "community-open",
          actor: { userId: "user-a", kind: "user" },
          body: {},
        }),
      );
      expect(firstJoin).toMatchObject({ community: "community-open", status: "joined" });
      expect(firstJoin.persona_id).toMatch(/^persona_[0-9a-f-]{36}$/);
      expect(secondJoin).toMatchObject({ community: "community-open", status: "joined" });
      expect("persona_id" in secondJoin).toBe(false);

      const membership = await admin.query({
        text: "SELECT membership_id FROM community_memberships WHERE community_id = $1 AND user_id = $2",
        values: ["community-open", "user-a"],
      });
      expect(membership.rows[0]?.membership_id).toMatch(/^membership_[0-9a-f-]{36}$/);

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

      const follow = await admin.query({
        text: "SELECT community_follow_id, status FROM community_follows WHERE community_id = $1 AND user_id = $2",
        values: ["community-open", "user-a"],
      });
      expect(follow.rows[0]?.community_follow_id).toMatch(/^follow_[0-9a-f-]{36}$/);
      expect(follow.rows[0]?.status).toBe("active");

      await expect(
        runStore(connection, (store) =>
          store.unfollow({
            communityId: "community-open",
            actor: { userId: "user-a", kind: "user" },
          }),
        ),
      ).rejects.toMatchObject({ _tag: "CommunityRepositoryError", reason: "constraint" });
    });
    completedTestCount += 1;
  }, 30_000);

  test("fails closed when a gated community has no pinned policy", async () => {
    await withSchema(async (connection, admin) => {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await insertCommunityOwner(admin);
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
      ).rejects.toMatchObject({ _tag: "CommunityRepositoryError", reason: "invalid-row" });
      const memberships = await admin.query({
        text: "SELECT COUNT(*)::int AS count FROM community_memberships WHERE community_id = $1",
        values: ["community-gated"],
      });
      expect(memberships.rows[0]?.count).toBe(0);
    });
    completedTestCount += 1;
  }, 30_000);

  test("persists request notes, preserves explicit follows, and supports pending follow/unfollow", async () => {
    await withSchema(async (connection, admin) => {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await insertCommunityOwner(admin);
      await admin.query({
        text: `INSERT INTO communities
          (community_id, display_name, status, membership_mode, created_by_user_id, created_at, updated_at)
          VALUES ('community-request', 'Request', 'active', 'request', 'owner', now(), now())`,
      });

      await expect(
        runStore(connection, (store) =>
          store.follow({
            communityId: "community-request",
            actor: { userId: "user-a", kind: "user" },
          }),
        ),
      ).resolves.toEqual({
        community: "community-request",
        following: true,
        follower_count: 1,
      });

      await expect(
        runStore(connection, (store) =>
          store.join({
            communityId: "community-request",
            actor: { userId: "user-a", kind: "user" },
            body: { note: "please let me in" },
          }),
        ),
      ).resolves.toEqual({ community: "community-request", status: "requested" });
      await expect(
        runStore(connection, (store) =>
          store.join({
            communityId: "community-request",
            actor: { userId: "user-a", kind: "user" },
            body: { note: "replay must be idempotent" },
          }),
        ),
      ).resolves.toEqual({ community: "community-request", status: "requested" });

      const membership = await admin.query({
        text: "SELECT membership_id, status, request_note FROM community_memberships WHERE community_id = $1 AND user_id = $2",
        values: ["community-request", "user-a"],
      });
      expect(membership.rows).toHaveLength(1);
      expect(membership.rows[0]).toMatchObject({
        status: "pending",
        request_note: "please let me in",
      });
      expect(membership.rows[0]?.membership_id).toMatch(/^membership_[0-9a-f-]{36}$/);

      const follow = await admin.query({
        text: "SELECT status FROM community_follows WHERE community_id = $1 AND user_id = $2",
        values: ["community-request", "user-a"],
      });
      expect(follow.rows[0]?.status).toBe("active");

      await expect(
        runStore(connection, (store) =>
          store.unfollow({
            communityId: "community-request",
            actor: { userId: "user-a", kind: "user" },
          }),
        ),
      ).resolves.toEqual({
        community: "community-request",
        following: false,
        follower_count: 0,
      });
      const unfollowed = await admin.query({
        text: "SELECT status FROM community_follows WHERE community_id = $1 AND user_id = $2",
        values: ["community-request", "user-a"],
      });
      expect(unfollowed.rows[0]?.status).toBe("inactive");
    });
    completedTestCount += 1;
  }, 30_000);

  test("allows follow regardless of membership state while left members rejoin atomically", async () => {
    await withSchema(async (connection, admin) => {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await insertJoinAccounts(admin);
      await admin.query({
        text: `INSERT INTO communities
          (community_id, display_name, status, membership_mode, created_by_user_id, created_at, updated_at)
          VALUES ('community-states', 'States', 'active', 'open', 'owner', now(), now())`,
      });
      await admin.query({
        text: `INSERT INTO community_memberships
          (community_id, membership_id, user_id, status, created_at, updated_at)
          VALUES ('community-states', 'membership-banned', 'user-banned', 'banned', now(), now()),
                 ('community-states', 'membership-pending', 'user-pending', 'pending', now(), now()),
                 ('community-states', 'membership-left', 'user-left', 'left', now(), now())`,
      });

      for (const userId of ["user-banned", "user-pending", "user-left"]) {
        await expect(
          runStore(connection, (store) =>
            store.follow({
              communityId: "community-states",
              actor: { userId, kind: "user" },
            }),
          ),
        ).resolves.toMatchObject({
          community: "community-states",
          following: true,
        });
      }

      await expect(
        runStore(connection, (store) =>
          store.join({
            communityId: "community-states",
            actor: { userId: "user-banned", kind: "user" },
            body: {},
          }),
        ),
      ).rejects.toMatchObject({ _tag: "CommunityRepositoryError", reason: "membership-required" });

      await expect(
        runStore(connection, (store) =>
          store.join({
            communityId: "community-states",
            actor: { userId: "user-left", kind: "user" },
            body: { persona: { kind: "create_new" } },
          }),
        ),
      ).resolves.toMatchObject({ community: "community-states", status: "joined" });
      const follow = await admin.query({
        text: "SELECT status FROM community_follows WHERE community_id = $1 AND user_id = $2",
        values: ["community-states", "user-left"],
      });
      expect(follow.rows[0]?.status).toBe("active");
    });
    completedTestCount += 1;
  }, 30_000);

  test("serializes concurrent join/follow/unfollow operations under the community lock", async () => {
    await withSchema(async (connection, admin) => {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await insertJoinAccounts(admin);
      await admin.query({
        text: `INSERT INTO communities
          (community_id, display_name, status, created_by_user_id, created_at, updated_at)
          VALUES ('community-concurrent', 'Concurrent', 'active', 'owner', now(), now())`,
      });
      const joins = await Promise.all(
        Array.from({ length: 6 }, () =>
          runStore(connection, (store) =>
            store.join({
              communityId: "community-concurrent",
              actor: { userId: "user-a", kind: "user" },
              body: { persona: { kind: "create_new" } },
            }),
          ),
        ),
      );
      expect(joins.every((result) => result.status === "joined")).toBe(true);
      expect(joins.filter((result) => "persona_id" in result)).toHaveLength(1);

      const follows = await Promise.all(
        Array.from({ length: 6 }, () =>
          runStore(connection, (store) =>
            store.follow({
              communityId: "community-concurrent",
              actor: { userId: "user-a", kind: "user" },
            }),
          ),
        ),
      );
      expect(follows.every((result) => result.following)).toBe(true);

      const unfollows = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          runStore(connection, (store) =>
            store.unfollow({
              communityId: "community-concurrent",
              actor: { userId: "user-a", kind: "user" },
            }),
          ),
        ),
      );
      expect(unfollows.every((result) => result.status === "rejected")).toBe(true);
      const rows = await admin.query({
        text: `SELECT
                 (SELECT COUNT(*)::int FROM community_memberships WHERE community_id = $1 AND user_id = $2) AS memberships,
                 (SELECT COUNT(*)::int FROM community_follows WHERE community_id = $1 AND user_id = $2 AND status = 'active') AS follows`,
        values: ["community-concurrent", "user-a"],
      });
      expect(rows.rows[0]).toEqual({ memberships: 1, follows: 1 });
    });
    completedTestCount += 1;
  }, 30_000);

  test("resolves the persona choice only at the terminal membership commit", async () => {
    await withSchema(async (connection, admin) => {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await insertJoinAccounts(admin);
      await admin.query({
        text: `INSERT INTO communities
          (community_id, display_name, status, membership_mode, created_by_user_id, created_at, updated_at)
          VALUES ('persona-home', 'Home', 'active', 'open', 'owner', now(), now()),
                 ('persona-away', 'Away', 'active', 'open', 'owner', now(), now()),
                 ('persona-request', 'Request', 'active', 'request', 'owner', now(), now())`,
      });
      await admin.query("SET session_replication_role = replica");
      await admin.query({
        text: `INSERT INTO personas (persona_id, account_id, status, is_first_persona)
               VALUES ('persona-seed-a', 'user-a', 'active', false),
                      ('persona-foreign', 'user-b', 'active', false)`,
      });
      await admin.query({
        text: `INSERT INTO persona_profiles (persona_id, revision)
               VALUES ('persona-seed-a', 1), ('persona-foreign', 1)`,
      });
      await admin.query("SET session_replication_role = origin");

      // Case 2: the first unbound platform persona binds exactly once.
      const boundJoin = await runStore(connection, (store) =>
        store.join({
          communityId: "persona-home",
          actor: { userId: "user-a", kind: "user" },
          body: { persona: { kind: "existing", persona_id: "persona-seed-a" } },
        }),
      );
      expect(boundJoin).toEqual({
        community: "persona-home",
        status: "joined",
        persona_id: "persona-seed-a",
      });
      const homeBinding = await admin.query({
        text: `SELECT account_id, community_id, binding_source FROM persona_community_bindings
                WHERE persona_id = $1`,
        values: ["persona-seed-a"],
      });
      expect(homeBinding.rows).toEqual([
        { account_id: "user-a", community_id: "persona-home", binding_source: "first_membership" },
      ]);

      // A changed target is a typed conflict and leaves no membership row.
      await expect(
        runStore(connection, (store) =>
          store.join({
            communityId: "persona-away",
            actor: { userId: "user-a", kind: "user" },
            body: { persona: { kind: "existing", persona_id: "persona-seed-a" } },
          }),
        ),
      ).rejects.toMatchObject({ _tag: "CommunityRepositoryError", reason: "constraint" });
      const awayMembership = await admin.query({
        text: `SELECT COUNT(*)::int AS count FROM community_memberships
                WHERE community_id = 'persona-away' AND user_id = 'user-a'`,
      });
      expect(awayMembership.rows[0]?.count).toBe(0);

      // Case 1: a persona already bound to the target community rejoins after leaving.
      await admin.query({
        text: `UPDATE community_memberships SET status = 'left', left_at = now()
                WHERE community_id = 'persona-home' AND user_id = 'user-a'`,
      });
      const rejoin = await runStore(connection, (store) =>
        store.join({
          communityId: "persona-home",
          actor: { userId: "user-a", kind: "user" },
          body: { persona: { kind: "existing", persona_id: "persona-seed-a" } },
        }),
      );
      expect(rejoin).toEqual({
        community: "persona-home",
        status: "joined",
        persona_id: "persona-seed-a",
      });

      // Case 3: create_new mints the persona and its binding in the commit.
      const mintedJoin = await runStore(connection, (store) =>
        store.join({
          communityId: "persona-away",
          actor: { userId: "user-a", kind: "user" },
          body: { persona: { kind: "create_new" } },
        }),
      );
      expect(mintedJoin).toMatchObject({ community: "persona-away", status: "joined" });
      const mintedId = mintedJoin.persona_id;
      expect(typeof mintedId).toBe("string");
      const minted = await admin.query({
        text: `SELECT persona.status,
                      (pending_profile.persona_id IS NOT NULL) AS has_pending_profile,
                      wallet.status AS wallet_status,
                      binding.community_id AS bound_community,
                      binding.binding_source
                 FROM personas AS persona
                 LEFT JOIN persona_pending_profiles AS pending_profile
                   ON pending_profile.persona_id = persona.persona_id
                 LEFT JOIN persona_wallet_assignments AS wallet
                   ON wallet.persona_id = persona.persona_id
                  AND wallet.chain_account_kind = 'evm'
                 LEFT JOIN persona_community_bindings AS binding
                   ON binding.persona_id = persona.persona_id
                WHERE persona.persona_id = $1`,
        values: [mintedId],
      });
      expect(minted.rows).toEqual([
        {
          status: "pending_wallet",
          has_pending_profile: true,
          wallet_status: "pending",
          bound_community: "persona-away",
          binding_source: "first_membership",
        },
      ]);

      // A foreign persona is an enumeration-safe conflict before any write.
      await expect(
        runStore(connection, (store) =>
          store.join({
            communityId: "persona-home",
            actor: { userId: "user-c", kind: "user" },
            body: { persona: { kind: "existing", persona_id: "persona-foreign" } },
          }),
        ),
      ).rejects.toMatchObject({ _tag: "CommunityRepositoryError", reason: "constraint" });

      // A terminal commit without a choice fails closed.
      await expect(
        runStore(connection, (store) =>
          store.join({
            communityId: "persona-away",
            actor: { userId: "user-c", kind: "user" },
            body: {},
          }),
        ),
      ).rejects.toMatchObject({ _tag: "CommunityRepositoryError", reason: "constraint" });

      // A request-mode intent never pre-binds identity.
      await expect(
        runStore(connection, (store) =>
          store.join({
            communityId: "persona-request",
            actor: { userId: "user-a", kind: "user" },
            body: { persona: { kind: "create_new" } },
          }),
        ),
      ).rejects.toMatchObject({ _tag: "CommunityRepositoryError", reason: "constraint" });
      const requestBindings = await admin.query({
        text: `SELECT COUNT(*)::int AS count FROM persona_community_bindings
                WHERE account_id = 'user-a' AND community_id = 'persona-request'`,
      });
      expect(requestBindings.rows[0]?.count).toBe(0);
    });
    completedTestCount += 1;
  }, 30_000);

  afterAll(async () => {
    if (connectionString !== undefined && completedTestCount === 8) {
      await Bun.write(sentinelPath, sentinelContents);
    }
  });
});
