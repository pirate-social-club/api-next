import { afterAll, describe, expect, test } from "bun:test";
import type { CreatePostBody, M2Actor } from "@pirate/application";
import { castPostVote } from "@pirate/application/use-cases/content/cast-post-vote";
import { clearPostVote } from "@pirate/application/use-cases/content/clear-post-vote";
import { Cause, Effect, Exit, Result } from "effect";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { makeControlPlaneContentStore } from "./content-repository";
import { createActivePersonaFixture } from "./persona-wallet.pg-fixture";
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
const actorPersonaId = "persona_content_alice";
const bobPersonaId = "persona_content_bob";
const requestHash = "a".repeat(64);
const postBody = (key: string, body = "hello", personaId = actorPersonaId): CreatePostBody =>
  ({ post_type: "text", persona_id: personaId, idempotency_key: key, body }) as CreatePostBody;
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
  await createActivePersonaFixture(admin, { accountId: actor.userId, personaId: actorPersonaId });
  await createActivePersonaFixture(admin, { accountId: "usr_bob", personaId: bobPersonaId });
  await seedEffectiveRoute(admin, routeState);
  await admin.query(
    `INSERT INTO community_memberships
      (community_id, membership_id, user_id, status, joined_at, created_at, updated_at)
     VALUES ('community_1', 'membership_alice', $1, 'member', now(), now(), now())`,
    [actor.userId],
  );
  await admin.query(
    `INSERT INTO posts
      (community_id, post_id, author_user_id, author_persona_id, post_type, status, visibility, body, created_at, updated_at)
     VALUES ('community_1', 'post_parent', $1, $2, 'text', 'published', 'public', 'parent', now(), now())`,
    [actor.userId, actorPersonaId],
  );
  await admin.query(
    `INSERT INTO comments
      (community_id, comment_id, post_id, parent_comment_id, author_user_id, author_persona_id, status, body, created_at, updated_at)
     VALUES ('community_1', 'comment_parent', 'post_parent', NULL, $1, $2, 'published', 'parent comment', now(), now())`,
    [actor.userId, actorPersonaId],
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
            body: { idempotency_key: "vote-up", value: 1 },
            requestHash,
          }),
        ),
      );
      await Effect.runPromise(
        Effect.scoped(
          store.castPostVote({
            communityId: "community_1",
            postId: "post_parent",
            actor,
            body: { idempotency_key: "vote-down", value: -1 },
            requestHash: "b".repeat(64),
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
      expect(afterReplace).toMatchObject({
        upvote_count: 0,
        downvote_count: 1,
        viewer_vote: -1,
      });
      await Effect.runPromise(
        Effect.scoped(
          store.clearPostVote({
            communityId: "community_1",
            postId: "post_parent",
            actor,
            body: { idempotency_key: "vote-clear" },
            requestHash: "c".repeat(64),
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
      expect(afterClear).toMatchObject({ downvote_count: 0, viewer_vote: null });
      const rows = await admin.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM post_votes WHERE post_id = 'post_parent'",
      );
      expect(rows.rows[0]?.count).toBe("0");
    });
    completedTestCount += 1;
  });

  test("replays cast, change, and clear results and rejects a changed request hash", async () => {
    await withSchema(async (connection, admin) => {
      await apply(connection);
      await seed(admin);
      const store = await storeFor(connection);
      const castInput = {
        postId: "post_parent",
        actor,
        body: { idempotency_key: "replay-cast", value: 1 as const },
      };
      const cast = await Effect.runPromise(castPostVote(castInput, { contentStore: store }));
      const castReplay = await Effect.runPromise(castPostVote(castInput, { contentStore: store }));
      expect(castReplay).toEqual(cast);
      expect(cast).toEqual({ post_id: "post_parent", value: 1 });
      const storedCastAction = await admin.query<{ action_id: string }>(
        `SELECT action_id FROM post_vote_actions
         WHERE post_id = 'post_parent'
           AND endpoint_template = '/posts/:postId/vote'
           AND idempotency_key = 'replay-cast'`,
      );
      const castActionId = storedCastAction.rows[0]?.action_id;
      expect(castActionId).toStartWith("vote_action_");

      const conflict = await Effect.runPromiseExit(
        castPostVote(
          {
            ...castInput,
            body: { idempotency_key: "replay-cast", value: -1 },
          },
          { contentStore: store },
        ),
      );
      expect(failureOf(conflict)).toMatchObject({
        _tag: "PostVoteIdempotencyConflict",
        details: {
          reason_code: "idempotency_conflict",
          action_id: castActionId,
        },
      });

      const changeInput = {
        ...castInput,
        body: { idempotency_key: "replay-change", value: -1 as const },
      };
      const changed = await Effect.runPromise(castPostVote(changeInput, { contentStore: store }));
      expect(await Effect.runPromise(castPostVote(changeInput, { contentStore: store }))).toEqual(
        changed,
      );
      expect(changed).toEqual({ post_id: "post_parent", value: -1 });

      const clearInput = {
        postId: "post_parent",
        actor,
        body: { idempotency_key: "replay-cast" },
      };
      const cleared = await Effect.runPromise(clearPostVote(clearInput, { contentStore: store }));
      expect(await Effect.runPromise(clearPostVote(clearInput, { contentStore: store }))).toEqual(
        cleared,
      );
      expect(cleared).toEqual({ post_id: "post_parent", value: 0 });

      const rows = await admin.query<{ actions: string; votes: string }>(
        `SELECT
           (SELECT COUNT(*)::text FROM post_vote_actions WHERE post_id = 'post_parent') AS actions,
           (SELECT COUNT(*)::text FROM post_votes WHERE post_id = 'post_parent') AS votes`,
      );
      expect(rows.rows[0]).toEqual({ actions: "3", votes: "0" });

      await admin.query(
        "UPDATE community_memberships SET status = 'left', updated_at = clock_timestamp() WHERE membership_id = 'membership_alice'",
      );
      await admin.query(
        "UPDATE posts SET status = 'hidden', updated_at = clock_timestamp() WHERE post_id = 'post_parent'",
      );
      await admin.query(
        "UPDATE community_canonical_route_bindings SET route_lifecycle_status = 'suspended', binding_generation = binding_generation + 1, updated_at = clock_timestamp() WHERE route_binding_id = 'content-binding'",
      );

      expect(await Effect.runPromise(castPostVote(castInput, { contentStore: store }))).toEqual(
        cast,
      );
      expect(await Effect.runPromise(clearPostVote(clearInput, { contentStore: store }))).toEqual(
        cleared,
      );
      const conflictAfterAuthorityLoss = await Effect.runPromiseExit(
        castPostVote(
          {
            ...castInput,
            body: { idempotency_key: "replay-cast", value: -1 },
          },
          { contentStore: store },
        ),
      );
      expect(failureOf(conflictAfterAuthorityLoss)).toMatchObject({
        _tag: "PostVoteIdempotencyConflict",
        details: {
          reason_code: "idempotency_conflict",
          action_id: castActionId,
        },
      });
    });
    completedTestCount += 1;
  });

  test("coalesces a same-key vote race into one stored action", async () => {
    await withSchema(async (connection, admin) => {
      await apply(connection);
      await seed(admin);
      const store = await storeFor(connection);
      const input = {
        communityId: "community_1",
        postId: "post_parent",
        actor,
        body: { idempotency_key: "race-key", value: 1 as const },
        requestHash,
      };
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          Effect.runPromise(Effect.scoped(store.castPostVote(input))),
        ),
      );
      expect(results).toEqual(
        Array.from({ length: 8 }, () => ({ post_id: "post_parent", value: 1 })),
      );
      const counts = await admin.query<{
        actions: string;
        votes: string;
        upvotes: number;
        downvotes: number;
      }>(
        `SELECT
           (SELECT COUNT(*)::text FROM post_vote_actions WHERE post_id = 'post_parent') AS actions,
           (SELECT COUNT(*)::text FROM post_votes WHERE post_id = 'post_parent') AS votes,
           upvote_count AS upvotes,
           downvote_count AS downvotes
         FROM posts WHERE post_id = 'post_parent'`,
      );
      expect(counts.rows[0]).toEqual({
        actions: "1",
        votes: "1",
        upvotes: 1,
        downvotes: 0,
      });
    });
    completedTestCount += 1;
  });

  test("serializes concurrent actors and repairs drifted vote aggregates", async () => {
    await withSchema(async (connection, admin) => {
      await apply(connection);
      await seed(admin);
      await admin.query(
        `INSERT INTO community_memberships
           (community_id, membership_id, user_id, status, joined_at, created_at, updated_at)
         VALUES ('community_1', 'membership_bob', 'usr_bob', 'member', now(), now(), now())`,
      );
      await admin.query(
        `UPDATE posts SET upvote_count = 9, downvote_count = 8 WHERE post_id = 'post_parent'`,
      );
      const store = await storeFor(connection);
      const bob: M2Actor = { userId: "usr_bob", kind: "user" };
      const driftedRead = await Effect.runPromise(
        Effect.scoped(
          store.getPost({
            communityId: "community_1",
            postId: "post_parent",
            viewerUserId: actor.userId,
          }),
        ),
      );
      expect(driftedRead).toMatchObject({
        upvote_count: 9,
        downvote_count: 8,
        viewer_vote: null,
      });
      const storedDrift = await admin.query<{ upvote_count: number; downvote_count: number }>(
        "SELECT upvote_count, downvote_count FROM posts WHERE post_id = 'post_parent'",
      );
      expect(storedDrift.rows[0]).toEqual({ upvote_count: 9, downvote_count: 8 });
      await Promise.all([
        Effect.runPromise(
          Effect.scoped(
            store.castPostVote({
              communityId: "community_1",
              postId: "post_parent",
              actor,
              body: { idempotency_key: "concurrent-alice", value: 1 },
              requestHash,
            }),
          ),
        ),
        Effect.runPromise(
          Effect.scoped(
            store.castPostVote({
              communityId: "community_1",
              postId: "post_parent",
              actor: bob,
              body: { idempotency_key: "concurrent-bob", value: -1 },
              requestHash: "b".repeat(64),
            }),
          ),
        ),
      ]);
      const post = await Effect.runPromise(
        Effect.scoped(
          store.getPost({
            communityId: "community_1",
            postId: "post_parent",
            viewerUserId: actor.userId,
          }),
        ),
      );
      expect(post).toMatchObject({ upvote_count: 1, downvote_count: 1, viewer_vote: 1 });
      const counts = await admin.query<{
        stored_upvotes: number;
        stored_downvotes: number;
        live_upvotes: string;
        live_downvotes: string;
      }>(
        `SELECT
           p.upvote_count AS stored_upvotes,
           p.downvote_count AS stored_downvotes,
           COUNT(*) FILTER (WHERE pv.vote_value = 1)::text AS live_upvotes,
           COUNT(*) FILTER (WHERE pv.vote_value = -1)::text AS live_downvotes
         FROM posts p
         LEFT JOIN post_votes pv
           ON pv.community_id = p.community_id AND pv.post_id = p.post_id
         WHERE p.post_id = 'post_parent'
         GROUP BY p.upvote_count, p.downvote_count`,
      );
      expect(counts.rows[0]).toEqual({
        stored_upvotes: 1,
        stored_downvotes: 1,
        live_upvotes: "1",
        live_downvotes: "1",
      });
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
            body: postBody("nonmember-key", "hello", bobPersonaId),
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
            body: { idempotency_key: "nonmember-vote", value: 1 },
            requestHash,
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

      await admin.query(
        "UPDATE posts SET visibility = 'public', content_rating = 'adult_18' WHERE post_id = 'post_parent'",
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
      ).resolves.toEqual({
        kind: "age_locked",
        content_rating: "adult_18",
        next_action: { kind: "verify_minimum_age", minimum_age: 18 },
      });
      await admin.query(
        "UPDATE posts SET content_rating = 'general' WHERE post_id = 'post_parent'",
      );

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

  test("posts and votes in an optional-route community with no binding", async () => {
    await withSchema(async (connection, admin) => {
      await apply(connection);
      const communityId = "community_123e4567-e89b-42d3-a456-426614174000";
      await admin.query("INSERT INTO users (user_id) VALUES ($1)", [actor.userId]);
      await createActivePersonaFixture(admin, {
        accountId: actor.userId,
        personaId: actorPersonaId,
      });
      await admin.query(
        `INSERT INTO communities (
           community_id, display_name, status, created_by_user_id,
           created_at, updated_at, route_slug, canonical_route_binding_id,
           route_authority_version
         ) VALUES ($1, 'Namespaceless', 'active', $2,
           clock_timestamp(), clock_timestamp(), NULL, NULL, 'optional_route_v2')`,
        [communityId, actor.userId],
      );
      await admin.query(
        `INSERT INTO community_memberships (
           community_id, membership_id, user_id, status, joined_at, created_at, updated_at
         ) VALUES ($1, 'membership_namespaceless', $2, 'member',
           clock_timestamp(), clock_timestamp(), clock_timestamp())`,
        [communityId, actor.userId],
      );
      await admin.query(
        `INSERT INTO posts (
           community_id, post_id, author_user_id, author_persona_id, post_type, status, visibility,
           body, created_at, updated_at
         ) VALUES ($1, 'post_namespaceless', $2, $3, 'text', 'published', 'public',
           'parent', clock_timestamp(), clock_timestamp())`,
        [communityId, actor.userId, actorPersonaId],
      );
      const store = await storeFor(connection);
      await expect(
        Effect.runPromise(
          Effect.scoped(
            store.createPost({
              communityId,
              actor,
              body: postBody("namespaceless-post"),
              idempotencyBodyHash: "2".repeat(64),
            }),
          ),
        ),
      ).resolves.toMatchObject({ status: "processing" });
      await expect(
        Effect.runPromise(
          Effect.scoped(
            store.castPostVote({
              communityId,
              postId: "post_namespaceless",
              actor,
              body: { idempotency_key: "namespaceless-vote", value: 1 },
              requestHash,
            }),
          ),
        ),
      ).resolves.toEqual({ post_id: "post_namespaceless", value: 1 });
      await expect(
        Effect.runPromise(
          Effect.scoped(
            store.clearPostVote({
              communityId,
              postId: "post_namespaceless",
              actor,
              body: { idempotency_key: "namespaceless-clear" },
              requestHash: "b".repeat(64),
            }),
          ),
        ),
      ).resolves.toEqual({ post_id: "post_namespaceless", value: 0 });
    });
    completedTestCount += 1;
  });

  test("creates a post independently of namespace route lifecycle", async () => {
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
        await expect(Effect.runPromise(Effect.scoped(operation))).resolves.toMatchObject({
          status: "processing",
        });
        const created = await admin.query<{ count: string }>(
          "SELECT COUNT(*) AS count FROM posts WHERE community_id = 'community_1'",
        );
        expect(created.rows[0]?.count).toBe("2");
      });
    }
    completedTestCount += 1;
  }, 20_000);

  test("casts a vote independently of namespace route lifecycle", async () => {
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
          body: { idempotency_key: `route-${routeState}`, value: 1 },
          requestHash,
        });
        await expect(Effect.runPromise(Effect.scoped(operation))).resolves.toMatchObject({
          post_id: "post_parent",
          value: 1,
        });
        const created = await admin.query<{ count: string }>(
          "SELECT COUNT(*) AS count FROM post_votes WHERE community_id = 'community_1'",
        );
        expect(created.rows[0]?.count).toBe("1");
      });
    }
    completedTestCount += 1;
  }, 20_000);

  test("clears a vote independently of namespace route lifecycle", async () => {
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
          body: { idempotency_key: `clear-${routeState}` },
          requestHash,
        });
        await expect(Effect.runPromise(Effect.scoped(operation))).resolves.toMatchObject({
          post_id: "post_parent",
          value: 0,
        });
        const cleared = await admin.query<{ count: string }>(
          "SELECT COUNT(*) AS count FROM post_votes WHERE community_id = 'community_1'",
        );
        expect(cleared.rows[0]?.count).toBe("0");
      });
    }
    completedTestCount += 1;
  }, 20_000);

  afterAll(async () => {
    if (connectionString !== undefined && completedTestCount === 11) {
      await Bun.write(sentinelPath, sentinelContents);
    }
  });
});
