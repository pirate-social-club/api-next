import { afterAll, describe, expect, test } from "bun:test";
import type { ClearVoteBody, CreatePostBody, M2Actor } from "@pirate/application";
import { Cause, Effect, Exit, Result } from "effect";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { makeControlPlaneContentStore } from "./content-repository";
import { makeDirectPostgresControlPlaneLayer } from "./postgres";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_CONTENT_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-content-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-content-suite-complete\n";
let completedTestCount = 0;

function schemaIdentifier(): string {
  return `api_next_content_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function connectionForSchema(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  const option = encodeURIComponent(`-c search_path=${schema}`);
  return `${raw}${separator}options=${option}`;
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

async function apply(connection: string): Promise<void> {
  await runPostgresMigrations({ connectionString: connection });
}

function failureOf<A, E>(exit: Exit.Exit<A, E>): E | undefined {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.findError(exit.cause);
  return Result.isSuccess(failure) ? failure.success : undefined;
}

const actor: M2Actor = { userId: "usr_alice", kind: "user" };
const postBody = (key: string, body = "hello"): CreatePostBody =>
  ({ post_type: "text", idempotency_key: key, body }) as CreatePostBody;
type RouteState = "active" | "suspended" | "expired";

async function seedEffectiveRoute(admin: Client, state: RouteState): Promise<void> {
  const hash = "a".repeat(64);
  const bindingHash = "b".repeat(64);
  const terminalAt = new Date(Date.now() - 1_000);
  const expiresAt = new Date(Date.now() + (state === "expired" ? 3_000 : 60 * 60 * 1_000));
  const snapshotExpiresAt = expiresAt;

  await admin.query(
    `INSERT INTO community_creation_intents (
       intent_id, actor_id, create_idempotency_key, create_request_hash,
       revision, status, draft, canonical_policy_revision,
       canonical_policy_hash, verification_requirement_hash,
       verification_provider_id, provider_configuration_kind,
       provider_configuration_ref, provider_configuration_version, expires_at
     ) VALUES ('content-intent', 'usr_alice', 'content-create', $1, 1,
       'verification_required', '{}'::jsonb, 1, $1, $1, 'content.provider',
       'dynamic', 'content-config', '1', clock_timestamp() + interval '1 day')`,
    [hash],
  );
  await admin.query(
    `INSERT INTO community_creation_requirement_states (
       intent_id, actor_id, requirement_kind, status, requirement_hash,
       provider_id, provider_binding_hash, provider_configuration_kind,
       provider_configuration_ref, provider_configuration_version,
       route_family, route_root_label, route_root_label_display, route_path_segment
     ) VALUES ('content-intent', 'usr_alice', 'namespace_ownership', 'unmet', $1,
       'content.provider', $2, 'dynamic', 'content-config', '1', 'hns',
       'content-route', 'content-route', 'app.content-route')`,
    [hash, bindingHash],
  );
  await admin.query(
    `INSERT INTO community_creation_ceremony_attempts (
       ceremony_intent_id, actor_id, intent_id, requirement_kind, generation,
       requirement_hash, provider_id, provider_binding_hash,
       provider_configuration_kind, provider_configuration_ref,
       provider_configuration_version, route_family, route_root_label,
       route_root_label_display, route_path_segment, reservation_request_hash,
       reservation_request, reserved_at, expires_at
     ) VALUES ('content-ceremony', 'usr_alice', 'content-intent',
       'namespace_ownership', 1, $1, 'content.provider', $2, 'dynamic',
       'content-config', '1', 'hns', 'content-route', 'content-route',
       'app.content-route', $1, '{}'::jsonb, $3, clock_timestamp() + interval '1 hour')`,
    [hash, bindingHash, terminalAt],
  );
  await admin.query(
    `UPDATE community_creation_requirement_states
        SET status = 'pending', generation = 1,
            current_ceremony_intent_id = 'content-ceremony', updated_at = clock_timestamp()
      WHERE intent_id = 'content-intent' AND requirement_kind = 'namespace_ownership'`,
  );
  await admin.query("BEGIN");
  await admin.query(
    `INSERT INTO namespace_ownership_start_reservations (
       reservation_id, namespace_session_id, actor_id, creation_intent_id,
       ceremony_intent_id, generation, requirement_hash, expected_revision,
       client_idempotency_key, request_hash, provider_id, provider_binding_hash,
       provider_configuration_kind, provider_configuration_ref, provider_configuration_version,
       protocol_version, environment, route_family, route_root_label, route_root_label_display,
       route_path_segment, route_href, state, fence_token, lease_expires_at
     ) VALUES ('content-start', 'content-session', 'usr_alice', 'content-intent',
       'content-ceremony', 1, $1, 1, 'content-start-key', $1, 'content.provider', $2,
       'dynamic', 'content-config', '1', 'hns-txt-v1', 'test', 'hns', 'content-route',
       'content-route', 'app.content-route', '/c/app.content-route', 'acquired', 1,
       clock_timestamp() + interval '30 minutes')`,
    [hash, bindingHash],
  );
  await admin.query(
    `INSERT INTO namespace_ownership_sessions (
       namespace_session_id, actor_id, creation_intent_id, ceremony_intent_id,
       start_reservation_id, start_fence_token, expected_revision, generation,
       requirement_hash, request_hash, provider_id, provider_binding_hash,
       provider_configuration_kind, provider_configuration_ref, provider_configuration_version,
       protocol_version, environment, route_family, route_root_label, route_root_label_display,
       route_path_segment, route_href, upstream_session_ref, presentation_kind,
       presentation_payload, status, started_at, expires_at
     ) VALUES ('content-session', 'usr_alice', 'content-intent', 'content-ceremony',
       'content-start', 1, 1, 1, $1, $1, 'content.provider', $2, 'dynamic',
       'content-config', '1', 'hns-txt-v1', 'test', 'hns', 'content-route',
       'content-route', 'app.content-route', '/c/app.content-route', 'content-upstream',
       'poll', '{}'::jsonb, 'pending', clock_timestamp() - interval '1 minute',
       clock_timestamp() + interval '1 hour')`,
    [hash, bindingHash],
  );
  await admin.query(
    `UPDATE namespace_ownership_start_reservations
        SET state = 'finalized', updated_at = clock_timestamp()
      WHERE reservation_id = 'content-start'`,
  );
  await admin.query(
    `INSERT INTO namespace_ownership_completion_attempts (
       completion_attempt_id, namespace_session_id, actor_id, idempotency_key,
       completion_request_hash, evidence_ref, submission_channel, state,
       fence_token, lease_expires_at
     ) VALUES ('content-completion', 'content-session', 'usr_alice', 'content-callback',
       $1, 'content-evidence', 'poll_result', 'leased', 1,
       clock_timestamp() + interval '30 minutes')`,
    [hash],
  );
  await admin.query(
    `UPDATE namespace_ownership_completion_attempts
        SET state = 'consumed', consumption_kind = 'verified', updated_at = clock_timestamp()
      WHERE completion_attempt_id = 'content-completion'`,
  );
  await admin.query(
    `INSERT INTO namespace_ownership_evidence_snapshots (
       evidence_ref, completion_attempt_id, namespace_session_id, actor_id,
       creation_intent_id, ceremony_intent_id, generation, requirement_hash,
       request_hash, provider_id, provider_binding_hash, provider_configuration_kind,
       provider_configuration_ref, provider_configuration_version, protocol_version,
       environment, family, root_label, root_label_display, path_segment, href,
       upstream_session_ref, fence_token, ownership_source, challenge_name,
       challenge_value_sha256, root_exists, root_control_verified,
       expiry_horizon_sufficient, chain_network, chain_anchor_height,
       chain_anchor_block_hash, chain_anchor_median_time, expiry_height,
       observed_at, expires_at, provider_evidence_ref, observation_sha256,
       provider_identity_digest, evidence_digest, observation, raw_response_bytes
     ) VALUES ('content-evidence', 'content-completion', 'content-session', 'usr_alice',
       'content-intent', 'content-ceremony', 1, $1, $1, 'content.provider', $2,
       'dynamic', 'content-config', '1', 'hns-txt-v1', 'test', 'hns', 'content-route',
       'content-route', 'app.content-route', '/c/app.content-route', 'content-upstream', 1,
       'owner_authoritative_dns_txt', '_pirate.content-route', $1, TRUE, TRUE, TRUE,
       'hns-testnet', 10, $1, 100, 20, $3, $4, 'content-observation', $1, $1, $1,
       '{"status":"verified"}'::jsonb, decode('01', 'hex'))`,
    [hash, bindingHash, terminalAt, snapshotExpiresAt],
  );
  await admin.query(
    `UPDATE namespace_ownership_sessions
        SET status = 'completed', terminal_at = $1, completed_at = $1,
            updated_at = clock_timestamp()
      WHERE namespace_session_id = 'content-session'`,
    [terminalAt],
  );
  await admin.query(
    `INSERT INTO community_creation_ceremony_results (
       ceremony_intent_id, actor_id, intent_id, requirement_kind, generation,
       requirement_hash, provider_id, provider_binding_hash,
       provider_configuration_version, callback_idempotency_key,
       callback_request_hash, outcome_status, result_hash, evidence_ref,
       evidence_digest, provider_identity_digest, terminal_at, satisfied_at,
       namespace_session_id, completion_attempt_id, submission_channel
     ) VALUES ('content-ceremony', 'usr_alice', 'content-intent',
       'namespace_ownership', 1, $1, 'content.provider', $2, '1',
       'content-callback', $1, 'satisfied', $1, 'content-evidence', $1, $1, $3, $3,
       'content-session', 'content-completion', 'poll_result')`,
    [hash, bindingHash, terminalAt],
  );
  await admin.query(
    `UPDATE community_creation_requirement_states
        SET status = 'satisfied', satisfied_at = $1, updated_at = clock_timestamp()
      WHERE intent_id = 'content-intent' AND requirement_kind = 'namespace_ownership'`,
    [terminalAt],
  );
  await admin.query(
    `INSERT INTO community_route_ownership_evidence (
       evidence_ref, creation_ceremony_intent_id, verified_by_actor_id,
       family, root_label, root_label_display, path_segment,
       requirement_hash, provider_id, provider_binding_hash,
       provider_configuration_version, provider_identity_digest,
       evidence_digest, binding_generation, verified_at, expires_at
     ) VALUES ('content-evidence', 'content-ceremony', 'usr_alice', 'hns',
       'content-route', 'content-route', 'app.content-route', $1,
       'content.provider', $2, '1', $1, $1, 1, $3, $4)`,
    [hash, bindingHash, terminalAt, expiresAt],
  );
  await admin.query("COMMIT");

  await admin.query("BEGIN");
  await admin.query(
    `INSERT INTO communities (
       community_id, display_name, status, created_by_user_id,
       created_at, updated_at, route_slug
     ) VALUES ('community_1', 'Content Community', 'active', 'usr_alice',
       clock_timestamp(), clock_timestamp(), NULL)`,
  );
  await admin.query(
    `INSERT INTO community_canonical_route_bindings (
       route_binding_id, community_id, family, root_label, root_label_display,
       ownership_status, route_lifecycle_status, binding_generation,
       verified_evidence_ref
     ) VALUES ('content-binding', 'community_1', 'hns', 'content-route',
       'content-route', 'verified', $1, 1, 'content-evidence')`,
    [state === "suspended" ? "suspended" : "active"],
  );
  await admin.query(
    `UPDATE communities SET canonical_route_binding_id = 'content-binding'
      WHERE community_id = 'community_1'`,
  );
  await admin.query("COMMIT");
}

async function seed(admin: Client, routeState: RouteState = "active"): Promise<void> {
  await admin.query("INSERT INTO users (user_id) VALUES ($1)", [actor.userId]);
  await admin.query("INSERT INTO users (user_id) VALUES ('usr_bob')");
  await seedEffectiveRoute(admin, routeState);
  await admin.query(
    `INSERT INTO community_memberships
      (community_id, membership_id, user_id, status, joined_at, created_at, updated_at)
     VALUES ('community_1', 'membership_alice', $1, 'member', now(), now(), now())`,
    [actor.userId],
  );
  await admin.query(
    `INSERT INTO posts
      (community_id, post_id, author_user_id, post_type, status, visibility, body, created_at, updated_at)
     VALUES ('community_1', 'post_parent', $1, 'text', 'published', 'public', 'parent', now(), now())`,
    [actor.userId],
  );
  await admin.query(
    `INSERT INTO comments
      (community_id, comment_id, post_id, parent_comment_id, author_user_id, status, body, created_at, updated_at)
     VALUES ('community_1', 'comment_parent', 'post_parent', NULL, $1, 'published', 'parent comment', now(), now())`,
    [actor.userId],
  );
}

async function storeFor(connection: string) {
  return makeControlPlaneContentStore(makeDirectPostgresControlPlaneLayer(connection));
}

async function waitForEffectiveRouteState(state: RouteState): Promise<void> {
  if (state === "expired") await Bun.sleep(3_100);
}

suite("Postgres 17 content repository", () => {
  test("creates processing posts and replays/conflicts idempotency atomically", async () => {
    await withSchema(async (connection, admin) => {
      await apply(connection);
      await seed(admin);
      const store = await storeFor(connection);
      const first = await Effect.runPromise(
        Effect.scoped(
          store.createPost({
            communityId: "community_1",
            actor,
            body: postBody("post-key"),
            idempotencyBodyHash: "a".repeat(64),
          }),
        ),
      );
      expect(first.status).toBe("processing");
      expect(first.id.startsWith("post_")).toBe(true);
      expect(first.analysis_state).toBe("pending");
      expect(first.content_safety_state).toBe("pending");
      expect(Number.isInteger(first.created)).toBe(true);
      const row = await admin.query<{ status: string }>(
        "SELECT status FROM posts WHERE post_id = $1",
        [first.id],
      );
      expect(row.rows[0]?.status).toBe("processing");

      const replay = await Effect.runPromise(
        Effect.scoped(
          store.createPost({
            communityId: "community_1",
            actor,
            body: postBody("post-key"),
            idempotencyBodyHash: "a".repeat(64),
          }),
        ),
      );
      expect(replay.id).toBe(first.id);
      const concurrent = await Promise.all(
        ["concurrent-a", "concurrent-b"].map(() =>
          Effect.runPromise(
            Effect.scoped(
              store.createPost({
                communityId: "community_1",
                actor,
                body: postBody("concurrent-key"),
                idempotencyBodyHash: "c".repeat(64),
              }),
            ),
          ),
        ),
      );
      expect(concurrent[0]?.id).toBe(concurrent[1]?.id);
      const conflict = await Effect.runPromiseExit(
        Effect.scoped(
          store.createPost({
            communityId: "community_1",
            actor,
            body: postBody("post-key", "different"),
            idempotencyBodyHash: "b".repeat(64),
          }),
        ),
      );
      expect(failureOf(conflict)).toMatchObject({
        _tag: "ContentRepositoryError",
        operation: "create-post",
        reason: "idempotency-conflict",
      });
      const count = await admin.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM posts WHERE community_id = 'community_1' AND idempotency_key = 'post-key'",
      );
      expect(count.rows[0]?.count).toBe("1");
    });
    completedTestCount += 1;
  });

  test("replaces votes atomically, counts them, and clears them", async () => {
    await withSchema(async (connection, admin) => {
      await apply(connection);
      await seed(admin);
      const store = await storeFor(connection);
      await Effect.runPromise(
        Effect.scoped(
          store.castPostVote({
            communityId: "community_1",
            postId: "post_parent",
            actor,
            body: { value: 1 },
          }),
        ),
      );
      await Effect.runPromise(
        Effect.scoped(
          store.castPostVote({
            communityId: "community_1",
            postId: "post_parent",
            actor,
            body: { value: -1 },
          }),
        ),
      );
      const afterReplace = await Effect.runPromise(
        Effect.scoped(
          store.getPost({
            communityId: "community_1",
            postId: "post_parent",
            viewerUserId: actor.userId,
          }),
        ),
      );
      expect(afterReplace?.upvote_count).toBe(0);
      expect(afterReplace?.downvote_count).toBe(1);
      expect(afterReplace?.viewer_vote).toBe(-1);
      await Effect.runPromise(
        Effect.scoped(
          store.clearPostVote({
            communityId: "community_1",
            postId: "post_parent",
            actor,
            body: {} as ClearVoteBody,
          }),
        ),
      );
      const afterClear = await Effect.runPromise(
        Effect.scoped(
          store.getPost({
            communityId: "community_1",
            postId: "post_parent",
            viewerUserId: actor.userId,
          }),
        ),
      );
      expect(afterClear?.downvote_count).toBe(0);
      expect(afterClear?.viewer_vote).toBeNull();
      const rows = await admin.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM post_votes WHERE post_id = 'post_parent'",
      );
      expect(rows.rows[0]?.count).toBe("0");
    });
    completedTestCount += 1;
  });

  test("requires active membership and rejects delegated actors", async () => {
    await withSchema(async (connection, admin) => {
      await apply(connection);
      await seed(admin);
      const store = await storeFor(connection);
      const nonmember: M2Actor = { userId: "usr_bob", kind: "user" };
      const create = await Effect.runPromiseExit(
        Effect.scoped(
          store.createPost({
            communityId: "community_1",
            actor: nonmember,
            body: postBody("nonmember-key"),
            idempotencyBodyHash: "1".repeat(64),
          }),
        ),
      );
      expect(failureOf(create)).toMatchObject({
        _tag: "ContentRepositoryError",
        reason: "membership-required",
      });
      const vote = await Effect.runPromiseExit(
        Effect.scoped(
          store.castPostVote({
            communityId: "community_1",
            postId: "post_parent",
            actor: nonmember,
            body: { value: 1 },
          }),
        ),
      );
      expect(failureOf(vote)).toMatchObject({ reason: "membership-required" });
      const delegated = await Effect.runPromiseExit(
        Effect.scoped(
          store.createPost({
            communityId: "community_1",
            actor: { userId: actor.userId, kind: "agent" },
            body: postBody("delegated-key"),
            idempotencyBodyHash: "3".repeat(64),
          }),
        ),
      );
      expect(failureOf(delegated)).toMatchObject({ reason: "constraint" });
    });
    completedTestCount += 1;
  });

  test("applies status and members-only visibility rules", async () => {
    await withSchema(async (connection, admin) => {
      await apply(connection);
      await seed(admin);
      const store = await storeFor(connection);
      await admin.query("UPDATE posts SET status = 'processing' WHERE post_id = 'post_parent'");
      await expect(
        Effect.runPromise(
          Effect.scoped(
            store.getPost({
              communityId: "community_1",
              postId: "post_parent",
              viewerUserId: actor.userId,
            }),
          ),
        ),
      ).resolves.toMatchObject({ post: { status: "processing" } });
      await expect(
        Effect.runPromise(
          Effect.scoped(
            store.getPost({
              communityId: "community_1",
              postId: "post_parent",
              viewerUserId: "usr_bob",
            }),
          ),
        ),
      ).resolves.toBeNull();

      await admin.query(
        "UPDATE posts SET status = 'published', visibility = 'members_only' WHERE post_id = 'post_parent'",
      );
      await expect(
        Effect.runPromise(
          Effect.scoped(
            store.getPost({
              communityId: "community_1",
              postId: "post_parent",
              viewerUserId: actor.userId,
            }),
          ),
        ),
      ).resolves.toMatchObject({ post: { visibility: "members_only" } });
      await expect(
        Effect.runPromise(
          Effect.scoped(
            store.getPost({
              communityId: "community_1",
              postId: "post_parent",
              viewerUserId: "usr_bob",
            }),
          ),
        ),
      ).resolves.toBeNull();

      for (const status of ["hidden", "removed", "deleted"] as const) {
        await admin.query("UPDATE posts SET status = $1 WHERE post_id = 'post_parent'", [status]);
        await expect(
          Effect.runPromise(
            Effect.scoped(
              store.getPost({
                communityId: "community_1",
                postId: "post_parent",
                viewerUserId: actor.userId,
              }),
            ),
          ),
        ).resolves.toBeNull();
      }
    });
    completedTestCount += 1;
  });

  test("requires an effective active route before creating a post", async () => {
    for (const routeState of ["active", "suspended", "expired"] as const) {
      await withSchema(async (connection, admin) => {
        await apply(connection);
        await seed(admin, routeState);
        const store = await storeFor(connection);
        await waitForEffectiveRouteState(routeState);
        const key = `route-post-${routeState}`;
        const operation = store.createPost({
          communityId: "community_1",
          actor,
          body: postBody(key),
          idempotencyBodyHash: "1".repeat(64),
        });
        if (routeState === "active") {
          await expect(Effect.runPromise(Effect.scoped(operation))).resolves.toMatchObject({
            status: "processing",
          });
          const created = await admin.query<{ count: string }>(
            "SELECT COUNT(*) AS count FROM posts WHERE community_id = 'community_1'",
          );
          expect(created.rows[0]?.count).toBe("2");
        } else {
          const result = await Effect.runPromiseExit(Effect.scoped(operation));
          expect(failureOf(result)).toMatchObject({ reason: "not-found" });
          const unchanged = await admin.query<{ count: string; keyed: string }>(
            `SELECT COUNT(*)::text AS count,
                    COUNT(*) FILTER (WHERE idempotency_key = $1)::text AS keyed
               FROM posts WHERE community_id = 'community_1'`,
            [key],
          );
          expect(unchanged.rows[0]).toEqual({ count: "1", keyed: "0" });
        }
      });
    }
    completedTestCount += 1;
  }, 20_000);

  test("requires an effective active route before casting a vote", async () => {
    for (const routeState of ["active", "suspended", "expired"] as const) {
      await withSchema(async (connection, admin) => {
        await apply(connection);
        await seed(admin, routeState);
        const store = await storeFor(connection);
        await waitForEffectiveRouteState(routeState);
        const operation = store.castPostVote({
          communityId: "community_1",
          postId: "post_parent",
          actor,
          body: { value: 1 },
        });
        if (routeState === "active") {
          await expect(Effect.runPromise(Effect.scoped(operation))).resolves.toMatchObject({
            post: "post_parent",
            value: 1,
          });
          const created = await admin.query<{ count: string }>(
            "SELECT COUNT(*) AS count FROM post_votes WHERE community_id = 'community_1'",
          );
          expect(created.rows[0]?.count).toBe("1");
        } else {
          const result = await Effect.runPromiseExit(Effect.scoped(operation));
          expect(failureOf(result)).toMatchObject({ reason: "not-found" });
          const unchanged = await admin.query<{ count: string }>(
            "SELECT COUNT(*) AS count FROM post_votes WHERE community_id = 'community_1'",
          );
          expect(unchanged.rows[0]?.count).toBe("0");
        }
      });
    }
    completedTestCount += 1;
  }, 20_000);

  test("requires an effective active route before clearing a vote", async () => {
    for (const routeState of ["active", "suspended", "expired"] as const) {
      await withSchema(async (connection, admin) => {
        await apply(connection);
        await seed(admin, routeState);
        await admin.query(
          `INSERT INTO post_votes
             (community_id, post_vote_id, post_id, user_id, vote_value, created_at, updated_at)
           VALUES ('community_1', 'vote_existing', 'post_parent', 'usr_alice', 1,
                   clock_timestamp(), clock_timestamp())`,
        );
        const store = await storeFor(connection);
        await waitForEffectiveRouteState(routeState);
        const operation = store.clearPostVote({
          communityId: "community_1",
          postId: "post_parent",
          actor,
          body: {} as ClearVoteBody,
        });
        if (routeState === "active") {
          await expect(Effect.runPromise(Effect.scoped(operation))).resolves.toMatchObject({
            post: "post_parent",
            value: null,
          });
          const cleared = await admin.query<{ count: string }>(
            "SELECT COUNT(*) AS count FROM post_votes WHERE community_id = 'community_1'",
          );
          expect(cleared.rows[0]?.count).toBe("0");
        } else {
          const result = await Effect.runPromiseExit(Effect.scoped(operation));
          expect(failureOf(result)).toMatchObject({ reason: "not-found" });
          const unchanged = await admin.query<{ count: string }>(
            "SELECT COUNT(*) AS count FROM post_votes WHERE community_id = 'community_1'",
          );
          expect(unchanged.rows[0]?.count).toBe("1");
        }
      });
    }
    completedTestCount += 1;
  }, 20_000);

  afterAll(async () => {
    if (connectionString !== undefined && completedTestCount === 10) {
      await Bun.write(sentinelPath, sentinelContents);
    }
  });
});
