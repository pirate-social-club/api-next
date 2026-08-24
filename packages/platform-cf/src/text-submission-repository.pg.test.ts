import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type {
  CreatePostBody,
  M2Actor,
  TextPostModerationEvaluation,
  TextPostStore,
  TextPostSubmissionDocument,
} from "@pirate/application";
import { canonicalBodyHash } from "@pirate/application/use-cases/content/common";
import {
  createTextPost,
  getTextContentSubmission,
  TextModerationProviderError,
} from "@pirate/application/use-cases/content/text-post";
import { canonicalTextModerationInput } from "@pirate/domain";
import { Cause, Effect, Exit, Result } from "effect";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations";
import { makeDirectPostgresControlPlaneLayer } from "./postgres";
import { makeControlPlaneTextSubmissionStore } from "./text-submission-repository";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
const suite = connectionString === undefined ? describe.skip : describe;
type RuntimeStore = TextPostStore["Service"] & {
  readonly reportComment: NonNullable<TextPostStore["Service"]["reportComment"]>;
  readonly moderateCaseAction: NonNullable<TextPostStore["Service"]["moderateCaseAction"]>;
};

const actor: M2Actor = { userId: "usr_text_order5", kind: "user" };
const otherActor: M2Actor = { userId: "usr_text_order5_other", kind: "user" };
const body = {
  post_type: "text",
  idempotency_key: "text-order5-race",
  body: "terminal text",
} as CreatePostBody;
const policyHash = "b0a8fd06312d7f9a99d7100633bc03fafc44b16aae5340899d290f54cb64df9d";
const input = {
  version: "text-moderation-input-v1" as const,
  surface: "text_post" as const,
  title: null,
  body: "terminal text",
};
const inputSha = (() => {
  const canonical = canonicalTextModerationInput(input);
  if (canonical.kind === "rejected") throw new Error(canonical.reason);
  return canonical.sha256;
})();
const evaluation: TextPostModerationEvaluation = {
  version: "text-moderation-v1",
  surface: "text_post",
  decision: "allow",
  reason_codes: [],
  policy_revision: "text-moderation-policy-v1",
  policy_hash: policyHash,
  input_sha256: inputSha,
  evidence_ref: null,
};

const commentBody = { idempotency_key: "comment-order6-race", body: "terminal comment" };
const commentInput = {
  version: "text-moderation-input-v1" as const,
  surface: "comment" as const,
  title: null,
  body: commentBody.body,
};
const commentInputSha = (() => {
  const canonical = canonicalTextModerationInput(commentInput);
  if (canonical.kind === "rejected") throw new Error(canonical.reason);
  return canonical.sha256;
})();
const commentEvaluation: TextPostModerationEvaluation = {
  version: "text-moderation-v1",
  surface: "comment",
  decision: "allow",
  reason_codes: [],
  policy_revision: "text-moderation-policy-v1",
  policy_hash: policyHash,
  input_sha256: commentInputSha,
  evidence_ref: null,
};
const replyBody = { idempotency_key: "reply-order6-depth", body: "terminal reply" };
const replyInput = { ...commentInput, surface: "reply" as const, body: replyBody.body };
const replyCanonical = canonicalTextModerationInput(replyInput);
if (replyCanonical.kind === "rejected") throw new Error(replyCanonical.reason);
const replyEvaluation: TextPostModerationEvaluation = {
  ...commentEvaluation,
  surface: "reply",
  input_sha256: replyCanonical.sha256,
};

async function commentRequestHash(
  idempotencyKey: string,
  text: string,
  postId = "text-order6-post",
  surface: "comment" | "reply" = "comment",
  parentCommentId?: string,
): Promise<string> {
  return Effect.runPromise(
    canonicalBodyHash({
      endpoint: surface,
      community_id: "text-community",
      post_id: postId,
      ...(parentCommentId === undefined ? {} : { parent_comment_id: parentCommentId }),
      body: { idempotency_key: idempotencyKey, body: text },
    }),
  );
}

function schemaName(): string {
  return `api_next_text_order5_${crypto.randomUUID().replaceAll("-", "")}`;
}
function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
function scopedConnection(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

async function withSchema<A>(use: (client: Client, connection: string) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("Postgres test configuration is unavailable");
  const schema = schemaName();
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  const connection = scopedConnection(connectionString, schema);
  try {
    await runPostgresMigrations({ connectionString: connection });
    await seed(admin, schema);
    return await use(admin, connection);
  } finally {
    await admin.query("ROLLBACK").catch(() => undefined);
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

async function seed(admin: Client, schema: string): Promise<void> {
  await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  const hash = policyHash;
  const bindingHash = "b".repeat(64);
  const terminalAt = new Date(Date.now() - 1_000);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1_000);
  await admin.query("INSERT INTO users (user_id) VALUES ($1)", [actor.userId]);
  await admin.query("INSERT INTO users (user_id) VALUES ($1)", [otherActor.userId]);
  await admin.query(
    `INSERT INTO community_creation_intents (
       intent_id, actor_id, create_idempotency_key, create_request_hash, revision, status,
       draft, canonical_policy_revision, canonical_policy_hash, verification_requirement_hash,
       verification_provider_id, provider_configuration_kind, provider_configuration_ref,
       provider_configuration_version, expires_at
     ) VALUES ('text-intent', $1, 'text-create', $2, 1, 'verification_required', '{}'::jsonb,
       1, $2, $2, 'text.provider', 'dynamic', 'text-config', '1', clock_timestamp() + interval '1 day')`,
    [actor.userId, policyHash],
  );
  await admin.query(
    `INSERT INTO community_creation_requirement_states (
       intent_id, actor_id, requirement_kind, status, requirement_hash, provider_id,
       provider_binding_hash, provider_configuration_kind, provider_configuration_ref,
       provider_configuration_version, route_family, route_root_label, route_root_label_display,
       route_path_segment, generation, current_ceremony_intent_id
     ) VALUES ('text-intent', $1, 'namespace_ownership', 'unmet', $2, 'text.provider', $3,
       'dynamic', 'text-config', '1', 'hns', 'text-order5', 'text-order5', 'app.text-order5', 0,
       NULL)`,
    [actor.userId, hash, bindingHash],
  );
  await admin.query(
    `INSERT INTO community_creation_ceremony_attempts (
       ceremony_intent_id, actor_id, intent_id, requirement_kind, generation, requirement_hash,
       provider_id, provider_binding_hash, provider_configuration_kind, provider_configuration_ref,
       provider_configuration_version, route_family, route_root_label, route_root_label_display,
       route_path_segment, reservation_request_hash, reservation_request, reserved_at, expires_at
     ) VALUES ('text-ceremony', $1, 'text-intent', 'namespace_ownership', 1, $2, 'text.provider', $3,
       'dynamic', 'text-config', '1', 'hns', 'text-order5', 'text-order5', 'app.text-order5', $2,
       '{}'::jsonb, clock_timestamp() - interval '1 second', clock_timestamp() + interval '1 day')`,
    [actor.userId, hash, bindingHash],
  );
  await admin.query(
    `UPDATE community_creation_requirement_states
        SET status = 'pending', generation = 1, current_ceremony_intent_id = 'text-ceremony',
            updated_at = clock_timestamp()
      WHERE intent_id = 'text-intent' AND requirement_kind = 'namespace_ownership'`,
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
     ) VALUES ('text-start', 'text-session', $1, 'text-intent', 'text-ceremony', 1, $2, 1,
       'text-start-key', $2, 'text.provider', $3, 'dynamic', 'text-config', '1',
       'hns-txt-v1', 'test', 'hns', 'text-order5', 'text-order5', 'app.text-order5',
       '/c/app.text-order5', 'acquired', 1, clock_timestamp() + interval '30 minutes')`,
    [actor.userId, hash, bindingHash],
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
     ) VALUES ('text-session', $1, 'text-intent', 'text-ceremony', 'text-start', 1, 1, 1,
       $2, $2, 'text.provider', $3, 'dynamic', 'text-config', '1', 'hns-txt-v1', 'test',
       'hns', 'text-order5', 'text-order5', 'app.text-order5', '/c/app.text-order5',
       'text-upstream', 'poll', '{}'::jsonb, 'pending', clock_timestamp() - interval '1 minute',
       clock_timestamp() + interval '1 hour')`,
    [actor.userId, hash, bindingHash],
  );
  await admin.query(
    `UPDATE namespace_ownership_start_reservations
        SET state = 'finalized', updated_at = clock_timestamp()
      WHERE reservation_id = 'text-start'`,
  );
  await admin.query(
    `INSERT INTO namespace_ownership_completion_attempts (
       completion_attempt_id, namespace_session_id, actor_id, idempotency_key,
       completion_request_hash, evidence_ref, submission_channel, state,
       fence_token, lease_expires_at
     ) VALUES ('text-completion', 'text-session', $1, 'text-callback', $2,
       'text-evidence', 'poll_result', 'leased', 1, clock_timestamp() + interval '30 minutes')`,
    [actor.userId, hash],
  );
  await admin.query(
    `UPDATE namespace_ownership_completion_attempts
        SET state = 'consumed', consumption_kind = 'verified', updated_at = clock_timestamp()
      WHERE completion_attempt_id = 'text-completion'`,
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
     ) VALUES ('text-evidence', 'text-completion', 'text-session', $1,
       'text-intent', 'text-ceremony', 1, $2, $2, 'text.provider', $3,
       'dynamic', 'text-config', '1', 'hns-txt-v1', 'test', 'hns', 'text-order5',
       'text-order5', 'app.text-order5', '/c/app.text-order5', 'text-upstream', 1,
       'owner_authoritative_dns_txt', '_pirate.text-order5', $2, TRUE, TRUE, TRUE,
       'hns-testnet', 10, $2, 100, 20, $4, $5, 'text-observation', $2, $2, $2,
       '{"status":"verified"}'::jsonb, decode('01', 'hex'))`,
    [actor.userId, hash, bindingHash, terminalAt, expiresAt],
  );
  await admin.query(
    `UPDATE namespace_ownership_sessions
        SET status = 'completed', terminal_at = $1, completed_at = $1, updated_at = clock_timestamp()
      WHERE namespace_session_id = 'text-session'`,
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
     ) VALUES ('text-ceremony', $1, 'text-intent', 'namespace_ownership', 1, $2,
       'text.provider', $3, '1', 'text-callback', $2, 'satisfied', $2,
       'text-evidence', $2, $2, $4, $4, 'text-session', 'text-completion', 'poll_result')`,
    [actor.userId, hash, bindingHash, terminalAt],
  );
  await admin.query(
    `UPDATE community_creation_requirement_states
        SET status = 'satisfied', satisfied_at = $1, updated_at = clock_timestamp()
      WHERE intent_id = 'text-intent' AND requirement_kind = 'namespace_ownership'`,
    [terminalAt],
  );
  await admin.query(
    `INSERT INTO community_route_ownership_evidence (
       evidence_ref, creation_ceremony_intent_id, verified_by_actor_id, family, root_label,
       root_label_display, path_segment, requirement_hash, provider_id, provider_binding_hash,
       provider_configuration_version, provider_identity_digest, evidence_digest, binding_generation,
       verified_at, expires_at
     ) VALUES ('text-evidence', 'text-ceremony', $1, 'hns', 'text-order5', 'text-order5',
       'app.text-order5', $2, 'text.provider', $3, '1', $2, $2, 1, $4, $5)`,
    [actor.userId, hash, bindingHash, terminalAt, expiresAt],
  );
  await admin.query(
    `INSERT INTO communities (
       community_id, display_name, status, created_by_user_id, canonical_route_binding_id,
       created_at, updated_at
     ) VALUES ('text-community', 'Text Order 5', 'active', $1, NULL, now(), now())`,
    [actor.userId],
  );
  await admin.query(
    `INSERT INTO community_canonical_route_bindings (
       route_binding_id, community_id, family, root_label, root_label_display, ownership_status,
       route_lifecycle_status, binding_generation, verified_evidence_ref
     ) VALUES ('text-binding', 'text-community', 'hns', 'text-order5', 'text-order5',
       'verified', 'active', 1, 'text-evidence')`,
  );
  await admin.query(
    "UPDATE communities SET canonical_route_binding_id = 'text-binding' WHERE community_id = 'text-community'",
  );
  await admin.query(
    `INSERT INTO community_memberships
       (community_id, membership_id, user_id, status, joined_at, created_at, updated_at)
     VALUES ('text-community', 'text-membership', $1, 'member', now(), now(), now())`,
    [actor.userId],
  );
  await admin.query("COMMIT");
}

function runStore<A, E>(
  connection: string,
  use: (store: RuntimeStore) => Effect.Effect<A, E>,
): Promise<A> {
  const layer = makeDirectPostgresControlPlaneLayer(connection);
  const store = makeControlPlaneTextSubmissionStore(layer) as RuntimeStore;
  return Effect.runPromise(Effect.scoped(use(store)));
}

function snapshotBytes(snapshot: TextPostSubmissionDocument): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(snapshot));
}

function databaseBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array && value.byteLength > 0) return new Uint8Array(value);
  throw new Error("expected non-empty response_snapshot_bytes");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function insertCommentPost(admin: Client, postId = "text-order6-post"): Promise<void> {
  await admin.query(
    `INSERT INTO posts (
       community_id, post_id, author_user_id, post_type, status, visibility,
       title, body, created_at, updated_at
     ) VALUES ('text-community', $1, $2, 'text', 'published', 'public',
       NULL, 'comment target', now(), now())`,
    [postId, actor.userId],
  );
}

async function insertParentComment(
  admin: Client,
  postId = "text-order6-post",
  commentId = "text-order6-parent",
  depth = 0,
): Promise<void> {
  await admin.query(
    `INSERT INTO comments (
       community_id, comment_id, post_id, parent_comment_id, author_user_id,
       status, body, created_at, updated_at, idempotency_key, idempotency_body_hash,
       depth, reply_count
     ) VALUES ('text-community', $1, $2, NULL, $3, 'published', 'parent', now(), now(),
       $4, $5, $6, 0)`,
    [commentId, postId, actor.userId, `${commentId}-key`, "a".repeat(64), depth],
  );
}

suite("Postgres 17 terminal text submission repository", () => {
  test("commits one terminal row and makes concurrent same-key submissions replay the winner", async () => {
    await withSchema(async (admin, connection) => {
      const commit = (operationId: string) =>
        runStore(connection, (store) =>
          store.commitTerminal({
            communityId: "text-community",
            actor,
            body,
            moderationInput: input,
            idempotencyKey: body.idempotency_key,
            requestHash: "ff6d5e5ea74c493047530e42fa4150abc1f03ce8011c9cc295a070059820be0c",
            operationId,
            evaluation,
          }),
        );
      const results = await Promise.all([commit("operation_text_1"), commit("operation_text_2")]);
      expect(results.map((result) => result.kind).sort()).toEqual(["created", "replay"]);
      const created = results.find((result) => result.kind === "created");
      const replay = results.find((result) => result.kind === "replay");
      if (created === undefined || replay === undefined)
        throw new Error("expected one created outcome and one replay outcome");
      const stored = await admin.query<{
        readonly submission_id: string;
        readonly response_snapshot_bytes: unknown;
        readonly response_snapshot_sha256: string;
      }>(
        `SELECT submission_id, response_snapshot_bytes, response_snapshot_sha256
           FROM text_content_submissions
          WHERE actor_user_id = $1 AND surface = 'text_post' AND idempotency_key = $2`,
        [actor.userId, body.idempotency_key],
      );
      expect(stored.rows).toHaveLength(1);
      const storedRow = stored.rows[0];
      if (storedRow === undefined) throw new Error("missing stored response snapshot");
      const createdBytes = snapshotBytes(created.snapshot);
      const replayBytes = snapshotBytes(replay.snapshot);
      const storedBytes = databaseBytes(storedRow.response_snapshot_bytes);
      expect(Array.from(replayBytes)).toEqual(Array.from(createdBytes));
      expect(Array.from(replayBytes)).toEqual(Array.from(storedBytes));
      expect(storedRow.response_snapshot_sha256).toBe(sha256(storedBytes));
      expect(storedRow.response_snapshot_sha256).toBe(sha256(replayBytes));
      const crossCommunity = await runStore(connection, (store) =>
        store.replay({
          communityId: "other-community",
          actor,
          idempotencyKey: body.idempotency_key,
          requestHash: "e".repeat(64),
        }),
      );
      if (crossCommunity.kind !== "conflict")
        throw new Error("expected cross-community key reuse to conflict");
      expect(crossCommunity.submissionId).toBe(storedRow.submission_id);
      await admin
        .query("SELECT count(*) FROM text_post_reservations")
        .then(() => {
          throw new Error("text_post_reservations must not exist");
        })
        .catch((error: unknown) => {
          expect(String(error)).toContain("text_post_reservations");
        });
      const counts = await admin.query(
        `SELECT
         (SELECT count(*)::int FROM text_content_submissions) AS submissions,
         (SELECT count(*)::int FROM posts) AS posts,
         (SELECT count(*)::int FROM home_feed_projection) AS feed`,
      );
      expect(counts.rows[0]).toMatchObject({ submissions: 1, posts: 1, feed: 1 });
    });
  }, 30_000);

  test("replays the immutable POST response bytes and digest without a second row", async () => {
    await withSchema(async (admin, connection) => {
      const postBody = {
        ...body,
        idempotency_key: "text-order5-post-replay",
      } as CreatePostBody;
      const textPostStore = makeControlPlaneTextSubmissionStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      let moderationCalls = 0;
      const textModeration = {
        evaluate: () => {
          moderationCalls += 1;
          return Effect.succeed(evaluation);
        },
      };
      const first = await Effect.runPromise(
        createTextPost(
          { communityId: "text-community", actor, body: postBody },
          { textPostStore, textModeration },
        ),
      );
      const stored = await admin.query<{
        readonly submission_id: string;
        readonly response_snapshot_bytes: unknown;
        readonly response_snapshot_sha256: string;
      }>(
        `SELECT submission_id, response_snapshot_bytes, response_snapshot_sha256
           FROM text_content_submissions
          WHERE actor_user_id = $1 AND surface = 'text_post' AND idempotency_key = $2`,
        [actor.userId, postBody.idempotency_key],
      );
      expect(stored.rows).toHaveLength(1);
      const storedRow = stored.rows[0];
      if (storedRow === undefined) throw new Error("missing stored response snapshot");
      const firstBytes = snapshotBytes(first);
      const storedBytes = databaseBytes(storedRow.response_snapshot_bytes);
      expect(Array.from(firstBytes)).toEqual(Array.from(storedBytes));
      expect(storedRow.response_snapshot_sha256).toBe(sha256(storedBytes));
      expect(storedRow.response_snapshot_sha256).toBe(sha256(firstBytes));

      const second = await Effect.runPromise(
        createTextPost(
          { communityId: "text-community", actor, body: postBody },
          { textPostStore, textModeration },
        ),
      );
      expect(Array.from(snapshotBytes(second))).toEqual(Array.from(firstBytes));
      expect(moderationCalls).toBe(1);
      const conflictResult = await Effect.runPromiseExit(
        createTextPost(
          {
            communityId: "text-community",
            actor,
            body: { ...postBody, body: "different terminal text" } as CreatePostBody,
          },
          { textPostStore, textModeration },
        ),
      );
      if (Exit.isSuccess(conflictResult))
        throw new Error("expected same-key different-payload POST to conflict");
      const conflictFailure = Cause.findError(conflictResult.cause);
      expect(Result.isSuccess(conflictFailure) ? conflictFailure.success : undefined).toMatchObject(
        {
          _tag: "IdempotencyConflict",
          details: {
            reason_code: "idempotency_conflict",
            submission_id: storedRow.submission_id,
          },
        },
      );
      const count = await admin.query<{ readonly count: number }>(
        `SELECT count(*)::int AS count
           FROM text_content_submissions
          WHERE actor_user_id = $1 AND surface = 'text_post' AND idempotency_key = $2`,
        [actor.userId, postBody.idempotency_key],
      );
      expect(count.rows).toEqual([{ count: 1 }]);
    });
  }, 30_000);

  test("returns the current GET state while replaying the original held POST response", async () => {
    await withSchema(async (admin, connection) => {
      const postBody = {
        ...body,
        idempotency_key: "text-order5-get-semantics",
      } as CreatePostBody;
      const textPostStore = makeControlPlaneTextSubmissionStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const first = await Effect.runPromise(
        createTextPost(
          { communityId: "text-community", actor, body: postBody },
          {
            textPostStore,
            textModeration: {
              evaluate: () =>
                Effect.fail(new TextModerationProviderError({ reason: "unavailable" })),
            },
          },
        ),
      );
      expect(first.status).toBe("manual_review");
      const stored = await admin.query<{
        readonly submission_id: string;
        readonly review_ref: string;
        readonly response_snapshot_bytes: unknown;
      }>(
        `SELECT submission_id, review_ref, response_snapshot_bytes
           FROM text_content_submissions
          WHERE actor_user_id = $1 AND surface = 'text_post' AND idempotency_key = $2`,
        [actor.userId, postBody.idempotency_key],
      );
      expect(stored.rows).toHaveLength(1);
      const storedRow = stored.rows[0];
      if (storedRow === undefined) throw new Error("missing held submission");
      const originalBytes = snapshotBytes(first);
      expect(Array.from(originalBytes)).toEqual(
        Array.from(databaseBytes(storedRow.response_snapshot_bytes)),
      );

      const otherActorResult = await Effect.runPromiseExit(
        getTextContentSubmission(
          { submissionId: storedRow.submission_id, actor: otherActor },
          { textPostStore },
        ),
      );
      if (Exit.isSuccess(otherActorResult))
        throw new Error("an author-scoped GET must not return another actor's body");
      const otherActorFailure = Cause.findError(otherActorResult.cause);
      expect(
        Result.isSuccess(otherActorFailure) ? otherActorFailure.success : undefined,
      ).toMatchObject({ _tag: "NotFound" });

      await admin.query("BEGIN");
      await admin.query(
        `INSERT INTO posts (
           community_id, post_id, author_user_id, post_type, status, visibility,
           title, body, created_at, updated_at
         ) VALUES ('text-community', 'text-order5-approved', $1, 'text', 'published', 'public',
           NULL, 'terminal text', now(), now())`,
        [actor.userId],
      );
      await admin.query(
        `UPDATE text_moderation_cases
            SET status = 'approved', resolved_by_user_id = 'moderator-order5',
                updated_at = clock_timestamp() + interval '1 millisecond'
          WHERE case_id = $1`,
        [storedRow.review_ref],
      );
      await admin.query(
        `UPDATE text_content_submissions
            SET status = 'published', public_reason_code = NULL,
                published_post_id = 'text-order5-approved', review_ref = NULL,
                updated_at = clock_timestamp() + interval '1 millisecond'
          WHERE submission_id = $1`,
        [storedRow.submission_id],
      );
      await admin.query(
        `INSERT INTO home_feed_projection (
           community_id, feed_item_id, post_id, rank_score, projected_at
         ) VALUES ('text-community', 'feed-text-order5-approved', 'text-order5-approved', 0, now())`,
      );
      await admin.query("COMMIT");

      const current = await Effect.runPromise(
        getTextContentSubmission(
          { submissionId: storedRow.submission_id, actor },
          { textPostStore },
        ),
      );
      expect(current).toMatchObject({
        status: "published",
        published_resource: {
          kind: "post",
          post_id: "text-order5-approved",
        },
      });
      let replayModerationCalls = 0;
      const replay = await Effect.runPromise(
        createTextPost(
          { communityId: "text-community", actor, body: postBody },
          {
            textPostStore,
            textModeration: {
              evaluate: () => {
                replayModerationCalls += 1;
                return Effect.fail(new TextModerationProviderError({ reason: "unavailable" }));
              },
            },
          },
        ),
      );
      expect(Array.from(snapshotBytes(replay))).toEqual(Array.from(originalBytes));
      expect(replay.status).toBe("manual_review");
      expect(replayModerationCalls).toBe(0);
    });
  }, 30_000);

  test("commits provider unavailability as manual review without publishing", async () => {
    await withSchema(async (admin, connection) => {
      const result = await runStore(connection, (store) =>
        store.commitTerminal({
          communityId: "text-community",
          actor,
          body: { ...body, idempotency_key: "text-order5-unavailable" },
          moderationInput: input,
          idempotencyKey: "text-order5-unavailable",
          requestHash: "f3a571a76ca9f7e44c6639318537fd821637d13c75c876cf21e964a6c7b78afd",
          operationId: "operation_text_unavailable",
          evaluation: {
            ...evaluation,
            decision: "manual_review",
            reason_codes: ["provider_unavailable"],
            policy_revision: "",
            policy_hash: "",
          },
        }),
      );
      expect(result.kind).toBe("created");
      const counts = await admin.query(
        `SELECT
         (SELECT count(*)::int FROM text_content_submissions) AS submissions,
         (SELECT count(*)::int FROM posts) AS posts,
         (SELECT count(*)::int FROM home_feed_projection) AS feed,
         (SELECT count(*)::int FROM text_content_held_revisions) AS held,
         (SELECT count(*)::int FROM text_moderation_cases) AS cases`,
      );
      expect(counts.rows[0]).toEqual({ submissions: 1, posts: 0, feed: 0, held: 1, cases: 1 });
    });
  }, 30_000);

  test("publishes posts, comments, and approved held comments without a namespace binding", async () => {
    await withSchema(async (admin, connection) => {
      const communityId = "community_123e4567-e89b-42d3-a456-426614174000";
      await admin.query(
        `INSERT INTO communities (
           community_id, display_name, status, created_by_user_id,
           canonical_route_binding_id, route_authority_version, route_slug,
           created_at, updated_at
         ) VALUES ($1, 'Namespaceless text', 'active', $2,
           NULL, 'optional_route_v2', NULL, clock_timestamp(), clock_timestamp())`,
        [communityId, actor.userId],
      );
      await admin.query(
        `INSERT INTO community_memberships (
           community_id, membership_id, user_id, status, joined_at, created_at, updated_at
         ) VALUES ($1, 'text-membership-namespaceless', $2, 'member',
           clock_timestamp(), clock_timestamp(), clock_timestamp())`,
        [communityId, actor.userId],
      );

      const postText = "namespaceless post";
      const postInput = { ...input, body: postText };
      const postCanonical = canonicalTextModerationInput(postInput);
      if (postCanonical.kind === "rejected") throw new Error(postCanonical.reason);
      const postRequestHash = await Effect.runPromise(
        canonicalBodyHash({
          community_id: communityId,
          body: { ...body, idempotency_key: "namespaceless-text-post", body: postText },
        }),
      );
      const postResult = await runStore(connection, (store) =>
        store.commitTerminal({
          communityId,
          actor,
          body: { ...body, idempotency_key: "namespaceless-text-post", body: postText },
          moderationInput: postInput,
          idempotencyKey: "namespaceless-text-post",
          requestHash: postRequestHash,
          operationId: "operation_namespaceless_text_post",
          evaluation: { ...evaluation, input_sha256: postCanonical.sha256 },
        }),
      );
      expect(postResult).toMatchObject({
        kind: "created",
        snapshot: { status: "published", published_resource: { kind: "post" } },
      });

      await admin.query(
        `INSERT INTO posts (
           community_id, post_id, author_user_id, post_type, status, visibility,
           body, created_at, updated_at
         ) VALUES ($1, 'namespaceless-comment-target', $2, 'text', 'published',
           'public', 'target', clock_timestamp(), clock_timestamp())`,
        [communityId, actor.userId],
      );
      const commentText = "namespaceless comment";
      const namespacelessCommentInput = { ...commentInput, body: commentText };
      const commentCanonical = canonicalTextModerationInput(namespacelessCommentInput);
      if (commentCanonical.kind === "rejected") throw new Error(commentCanonical.reason);
      const commentRequestHash = await Effect.runPromise(
        canonicalBodyHash({
          endpoint: "comment",
          community_id: communityId,
          post_id: "namespaceless-comment-target",
          body: { idempotency_key: "namespaceless-comment", body: commentText },
        }),
      );
      const commentResult = await runStore(connection, (store) =>
        store.commitTerminal({
          communityId,
          actor,
          body: { idempotency_key: "namespaceless-comment", body: commentText },
          moderationInput: namespacelessCommentInput,
          idempotencyKey: "namespaceless-comment",
          requestHash: commentRequestHash,
          operationId: "operation_namespaceless_comment",
          evaluation: { ...commentEvaluation, input_sha256: commentCanonical.sha256 },
          target: {
            surface: "comment",
            communityId,
            postId: "namespaceless-comment-target",
          },
        }),
      );
      expect(commentResult).toMatchObject({
        kind: "created",
        snapshot: { status: "published", published_resource: { kind: "comment" } },
      });

      const heldText = "namespaceless held comment";
      const heldInput = { ...commentInput, body: heldText };
      const heldCanonical = canonicalTextModerationInput(heldInput);
      if (heldCanonical.kind === "rejected") throw new Error(heldCanonical.reason);
      const heldRequestHash = await Effect.runPromise(
        canonicalBodyHash({
          endpoint: "comment",
          community_id: communityId,
          post_id: "namespaceless-comment-target",
          body: { idempotency_key: "namespaceless-held", body: heldText },
        }),
      );
      const heldResult = await runStore(connection, (store) =>
        store.commitTerminal({
          communityId,
          actor,
          body: { idempotency_key: "namespaceless-held", body: heldText },
          moderationInput: heldInput,
          idempotencyKey: "namespaceless-held",
          requestHash: heldRequestHash,
          operationId: "operation_namespaceless_held",
          evaluation: {
            ...commentEvaluation,
            decision: "manual_review",
            reason_codes: ["provider_unavailable"],
            input_sha256: heldCanonical.sha256,
          },
          target: {
            surface: "comment",
            communityId,
            postId: "namespaceless-comment-target",
          },
        }),
      );
      if (heldResult.kind !== "created" || heldResult.snapshot.review_ref === null) {
        throw new Error("expected held namespaceless comment");
      }
      const actionHash = await Effect.runPromise(
        canonicalBodyHash({
          endpoint: "POST /moderation/cases/:caseRef/actions",
          case_ref: heldResult.snapshot.review_ref,
          body: { idempotency_key: "namespaceless-approve", action: "approve" },
        }),
      );
      await expect(
        runStore(connection, (store) =>
          store.moderateCaseAction({
            caseRef: heldResult.snapshot.review_ref as string,
            actor: { ...actor, scopes: ["moderator"] },
            idempotencyKey: "namespaceless-approve",
            action: "approve",
            requestHash: actionHash,
          }),
        ),
      ).resolves.toMatchObject({ action: "approve", targetStatus: "published" });
    });
  }, 30_000);

  test("comments same-key race commits one submission and replays winner bytes", async () => {
    await withSchema(async (admin, connection) => {
      await insertCommentPost(admin);
      const requestHash = await commentRequestHash(commentBody.idempotency_key, commentBody.body);
      const commit = (operationId: string) =>
        runStore(connection, (store) =>
          store.commitTerminal({
            communityId: "text-community",
            actor,
            body: commentBody,
            moderationInput: commentInput,
            idempotencyKey: commentBody.idempotency_key,
            requestHash,
            operationId,
            evaluation: commentEvaluation,
            target: {
              surface: "comment",
              communityId: "text-community",
              postId: "text-order6-post",
            },
          }),
        );
      const results = await Promise.all([
        commit("operation_comment_1"),
        commit("operation_comment_2"),
      ]);
      expect(results.map((result) => result.kind).sort()).toEqual(["created", "replay"]);
      const created = results.find((result) => result.kind === "created");
      const replay = results.find((result) => result.kind === "replay");
      if (created === undefined || replay === undefined)
        throw new Error("expected comment race winner");
      const stored = await admin.query<{
        readonly submission_id: string;
        readonly response_snapshot_bytes: unknown;
        readonly response_snapshot_sha256: string;
      }>(
        `SELECT submission_id, response_snapshot_bytes, response_snapshot_sha256
           FROM text_content_submissions
          WHERE actor_user_id = $1 AND surface = 'comment' AND idempotency_key = $2`,
        [actor.userId, commentBody.idempotency_key],
      );
      expect(stored.rows).toHaveLength(1);
      const storedRow = stored.rows[0];
      if (storedRow === undefined) throw new Error("missing comment response snapshot");
      const createdBytes = snapshotBytes(created.snapshot);
      const replayBytes = snapshotBytes(replay.snapshot);
      const storedBytes = databaseBytes(storedRow.response_snapshot_bytes);
      expect(Array.from(replayBytes)).toEqual(Array.from(createdBytes));
      expect(Array.from(replayBytes)).toEqual(Array.from(storedBytes));
      expect(storedRow.response_snapshot_sha256).toBe(sha256(storedBytes));
      const counts = await admin.query(
        `SELECT
           (SELECT count(*)::int FROM comments WHERE post_id = 'text-order6-post') AS comments,
           (SELECT comment_count FROM posts WHERE post_id = 'text-order6-post') AS comment_count,
           (SELECT count(*)::int FROM comment_publication_projection) AS projections,
           (SELECT count(*)::int FROM content_publication_outbox) AS outbox`,
      );
      expect(counts.rows[0]).toEqual({ comments: 1, comment_count: 1, projections: 1, outbox: 3 });
      const crossCommunity = await runStore(connection, (store) =>
        store.replay({
          communityId: "other-community",
          actor,
          idempotencyKey: commentBody.idempotency_key,
          requestHash: "e".repeat(64),
          surface: "comment",
        }),
      );
      expect(crossCommunity).toEqual({ kind: "conflict", submissionId: storedRow.submission_id });
    });
  }, 30_000);

  test("blocked comments create no comment, counter, projection, or outbox effect", async () => {
    await withSchema(async (admin, connection) => {
      await insertCommentPost(admin);
      const blockedBody = { idempotency_key: "comment-order6-blocked", body: "blocked comment" };
      const blockedInput = { ...commentInput, body: blockedBody.body };
      const canonical = canonicalTextModerationInput(blockedInput);
      if (canonical.kind === "rejected") throw new Error(canonical.reason);
      const requestHash = await commentRequestHash(blockedBody.idempotency_key, blockedBody.body);
      const result = await runStore(connection, (store) =>
        store.commitTerminal({
          communityId: "text-community",
          actor,
          body: blockedBody,
          moderationInput: blockedInput,
          idempotencyKey: blockedBody.idempotency_key,
          requestHash,
          operationId: "operation_comment_blocked",
          evaluation: {
            ...commentEvaluation,
            decision: "blocked",
            reason_codes: ["hate"],
            input_sha256: canonical.sha256,
          },
          target: { surface: "comment", communityId: "text-community", postId: "text-order6-post" },
        }),
      );
      expect(result.kind).toBe("created");
      const counts = await admin.query(
        `SELECT
           (SELECT count(*)::int FROM text_content_submissions WHERE surface = 'comment') AS submissions,
           (SELECT count(*)::int FROM comments) AS comments,
           (SELECT comment_count FROM posts WHERE post_id = 'text-order6-post') AS comment_count,
           (SELECT count(*)::int FROM comment_publication_projection) AS projections,
           (SELECT count(*)::int FROM content_publication_outbox) AS outbox`,
      );
      expect(counts.rows[0]).toEqual({
        submissions: 1,
        comments: 0,
        comment_count: 0,
        projections: 0,
        outbox: 0,
      });
    });
  }, 30_000);

  test("reply parent closure, cross-thread, depth, and reply_count invariants hold at commit", async () => {
    await withSchema(async (admin, connection) => {
      await insertCommentPost(admin);
      await insertCommentPost(admin, "text-order6-other-post");
      await insertParentComment(admin, "text-order6-other-post", "text-order6-cross-parent");
      const replyHash = await commentRequestHash(
        replyBody.idempotency_key,
        replyBody.body,
        "text-order6-post",
        "reply",
        "text-order6-cross-parent",
      );
      const crossThreadFailure = await runStore(connection, (store) =>
        store.commitTerminal({
          communityId: "text-community",
          actor,
          body: replyBody,
          moderationInput: replyInput,
          idempotencyKey: replyBody.idempotency_key,
          requestHash: replyHash,
          operationId: "operation_reply_cross_thread",
          evaluation: replyEvaluation,
          target: {
            surface: "reply",
            communityId: "text-community",
            postId: "text-order6-post",
            parentCommentId: "text-order6-cross-parent",
          },
        }),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(crossThreadFailure).toMatchObject({
        _tag: "TextPostRepositoryError",
        reason: "not-found",
      });

      await admin.query(
        "UPDATE posts SET comments_locked = TRUE WHERE community_id = 'text-community' AND post_id = 'text-order6-post'",
      );
      await insertParentComment(admin, "text-order6-post", "text-order6-closed-parent");
      const closedHash = await commentRequestHash(
        "reply-order6-closed",
        replyBody.body,
        "text-order6-post",
        "reply",
        "text-order6-closed-parent",
      );
      const closedFailure = await runStore(connection, (store) =>
        store.commitTerminal({
          communityId: "text-community",
          actor,
          body: { ...replyBody, idempotency_key: "reply-order6-closed" },
          moderationInput: replyInput,
          idempotencyKey: "reply-order6-closed",
          requestHash: closedHash,
          operationId: "operation_reply_closed",
          evaluation: replyEvaluation,
          target: {
            surface: "reply",
            communityId: "text-community",
            postId: "text-order6-post",
            parentCommentId: "text-order6-closed-parent",
          },
        }),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(closedFailure).toMatchObject({
        _tag: "TextPostRepositoryError",
        reason: "comments-locked",
      });

      await admin.query(
        "UPDATE posts SET comments_locked = FALSE WHERE community_id = 'text-community' AND post_id = 'text-order6-post'",
      );
      await insertParentComment(admin, "text-order6-post", "text-order6-deep-parent", 8);
      const depthHash = await commentRequestHash(
        "reply-order6-depth",
        replyBody.body,
        "text-order6-post",
        "reply",
        "text-order6-deep-parent",
      );
      const depthFailure = await runStore(connection, (store) =>
        store.commitTerminal({
          communityId: "text-community",
          actor,
          body: replyBody,
          moderationInput: replyInput,
          idempotencyKey: replyBody.idempotency_key,
          requestHash: depthHash,
          operationId: "operation_reply_depth",
          evaluation: replyEvaluation,
          target: {
            surface: "reply",
            communityId: "text-community",
            postId: "text-order6-post",
            parentCommentId: "text-order6-deep-parent",
          },
        }),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(depthFailure).toMatchObject({
        _tag: "TextPostRepositoryError",
        reason: "reply-depth-exceeded",
      });

      await insertParentComment(admin, "text-order6-post", "text-order6-max-parent", 7);
      const allowedHash = await commentRequestHash(
        "reply-order6-max-allowed",
        replyBody.body,
        "text-order6-post",
        "reply",
        "text-order6-max-parent",
      );
      const allowed = await runStore(connection, (store) =>
        store.commitTerminal({
          communityId: "text-community",
          actor,
          body: { ...replyBody, idempotency_key: "reply-order6-max-allowed" },
          moderationInput: replyInput,
          idempotencyKey: "reply-order6-max-allowed",
          requestHash: allowedHash,
          operationId: "operation_reply_max_allowed",
          evaluation: replyEvaluation,
          target: {
            surface: "reply",
            communityId: "text-community",
            postId: "text-order6-post",
            parentCommentId: "text-order6-max-parent",
          },
        }),
      );
      expect(allowed).toMatchObject({
        kind: "created",
        snapshot: { status: "published", published_resource: { kind: "comment" } },
      });
      const parentCounter = await admin.query<{ readonly reply_count: number }>(
        "SELECT reply_count FROM comments WHERE comment_id = 'text-order6-max-parent'",
      );
      expect(parentCounter.rows).toEqual([{ reply_count: 1 }]);
    });
  }, 30_000);

  test("reports coalesce, held state and approval are atomic, and invalid visibility pairs fail", async () => {
    await withSchema(async (admin, connection) => {
      await insertCommentPost(admin);
      const requestHash = await commentRequestHash("comment-order6-report", commentBody.body);
      const publishedResult = await runStore(connection, (store) =>
        store.commitTerminal({
          communityId: "text-community",
          actor,
          body: { ...commentBody, idempotency_key: "comment-order6-report" },
          moderationInput: commentInput,
          idempotencyKey: "comment-order6-report",
          requestHash,
          operationId: "operation_comment_report_target",
          evaluation: commentEvaluation,
          target: { surface: "comment", communityId: "text-community", postId: "text-order6-post" },
        }),
      );
      if (publishedResult.kind !== "created") throw new Error("expected report target comment");
      const commentId =
        publishedResult.snapshot.published_resource?.kind === "comment"
          ? publishedResult.snapshot.published_resource.comment_id
          : null;
      if (commentId === null) throw new Error("missing published comment id");
      const reportHash = (key: string) =>
        Effect.runPromise(
          canonicalBodyHash({
            endpoint: "POST /comments/:commentId/reports",
            comment_id: commentId,
            body: { idempotency_key: key, reason_code: "spam" },
          }),
        );
      const firstReportHash = await reportHash("report-order6-1");
      const report = await runStore(connection, (store) =>
        store.reportComment({
          commentId,
          actor,
          idempotencyKey: "report-order6-1",
          reasonCode: "spam",
          requestHash: firstReportHash,
        }),
      );
      expect(report.status).toBe("open");
      const reportConflict = await runStore(connection, (store) =>
        store.reportComment({
          commentId,
          actor,
          idempotencyKey: "report-order6-1",
          reasonCode: "spam",
          requestHash: "0".repeat(64),
        }),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(reportConflict).toMatchObject({
        _tag: "TextPostRepositoryError",
        reason: "idempotency-conflict",
      });
      const secondReportHash = await reportHash("report-order6-2");
      const coalesced = await runStore(connection, (store) =>
        store.reportComment({
          commentId,
          actor,
          idempotencyKey: "report-order6-2",
          reasonCode: "harassment",
          requestHash: secondReportHash,
        }),
      );
      expect(coalesced).toMatchObject({ caseRef: report.caseRef, status: "coalesced" });
      const reportReplay = await runStore(connection, (store) =>
        store.reportComment({
          commentId,
          actor,
          idempotencyKey: "report-order6-1",
          reasonCode: "spam",
          requestHash: firstReportHash,
        }),
      );
      expect(reportReplay).toEqual(report);

      const heldKey = "comment-order6-held";
      const heldHash = await commentRequestHash(heldKey, "held comment");
      const heldInput = { ...commentInput, body: "held comment" };
      const heldCanonical = canonicalTextModerationInput(heldInput);
      if (heldCanonical.kind === "rejected") throw new Error(heldCanonical.reason);
      const heldResult = await runStore(connection, (store) =>
        store.commitTerminal({
          communityId: "text-community",
          actor,
          body: { idempotency_key: heldKey, body: "held comment" },
          moderationInput: heldInput,
          idempotencyKey: heldKey,
          requestHash: heldHash,
          operationId: "operation_comment_held",
          evaluation: {
            ...commentEvaluation,
            decision: "manual_review",
            reason_codes: ["provider_unavailable"],
            input_sha256: heldCanonical.sha256,
          },
          target: { surface: "comment", communityId: "text-community", postId: "text-order6-post" },
        }),
      );
      if (heldResult.kind !== "created" || heldResult.snapshot.review_ref === null)
        throw new Error("expected held comment");
      const heldCaseRef = heldResult.snapshot.review_ref;
      const heldCounts = await admin.query(
        `SELECT
           (SELECT count(*)::int FROM text_content_held_revisions
             WHERE submission_id = $1) AS held_revisions,
           (SELECT count(*)::int FROM text_moderation_cases
             WHERE submission_id = $1 AND status = 'open') AS open_text_cases,
           (SELECT count(*)::int FROM comment_moderation_cases
             WHERE submission_id = $1 AND status = 'open') AS open_comment_cases,
           (SELECT count(*)::int
              FROM text_content_submissions AS s
              JOIN comments AS c
                ON c.community_id = s.community_id
               AND c.comment_id = s.published_comment_id
             WHERE s.submission_id = $1) AS comments,
           (SELECT comment_count FROM posts WHERE post_id = 'text-order6-post') AS comment_count,
           (SELECT count(*)::int FROM content_publication_outbox
             WHERE submission_id = $1) AS outbox`,
        [heldResult.snapshot.submission_id],
      );
      expect(heldCounts.rows[0]).toEqual({
        held_revisions: 1,
        open_text_cases: 1,
        open_comment_cases: 1,
        comments: 0,
        comment_count: 1,
        outbox: 0,
      });
      const actionHash = (key: string, action: string) =>
        Effect.runPromise(
          canonicalBodyHash({
            endpoint: "POST /moderation/cases/:caseRef/actions",
            case_ref: heldCaseRef,
            body: { idempotency_key: key, action },
          }),
        );
      const moderator = { ...actor, scopes: ["moderator"] };
      const authorApproveHash = await actionHash("action-order6-author-approve", "approve");
      const authorApproveFailure = await runStore(connection, (store) =>
        store.moderateCaseAction({
          caseRef: heldCaseRef,
          actor,
          idempotencyKey: "action-order6-author-approve",
          action: "approve",
          requestHash: authorApproveHash,
        }),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(authorApproveFailure).toMatchObject({
        _tag: "TextPostRepositoryError",
        reason: "not-found",
      });
      const dismissHash = await actionHash("action-order6-dismiss", "dismiss");
      const dismissFailure = await runStore(connection, (store) =>
        store.moderateCaseAction({
          caseRef: heldCaseRef,
          actor: moderator,
          idempotencyKey: "action-order6-dismiss",
          action: "dismiss",
          requestHash: dismissHash,
        }),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(dismissFailure).toMatchObject({
        _tag: "TextPostRepositoryError",
        reason: "action-conflict",
      });
      const approveHash = await actionHash("action-order6-approve", "approve");
      const approved = await runStore(connection, (store) =>
        store.moderateCaseAction({
          caseRef: heldCaseRef,
          actor: moderator,
          idempotencyKey: "action-order6-approve",
          action: "approve",
          requestHash: approveHash,
        }),
      );
      expect(approved).toMatchObject({
        caseRef: heldCaseRef,
        action: "approve",
        targetStatus: "published",
      });
      const approvedReplay = await runStore(connection, (store) =>
        store.moderateCaseAction({
          caseRef: heldCaseRef,
          actor: moderator,
          idempotencyKey: "action-order6-approve",
          action: "approve",
          requestHash: approveHash,
        }),
      );
      expect(approvedReplay).toEqual(approved);
      const approvedSubmissionReplay = await runStore(connection, (store) =>
        store.commitTerminal({
          communityId: "text-community",
          actor,
          body: { idempotency_key: heldKey, body: "held comment" },
          moderationInput: heldInput,
          idempotencyKey: heldKey,
          requestHash: heldHash,
          operationId: "operation_comment_held_replay",
          evaluation: {
            ...commentEvaluation,
            decision: "manual_review",
            reason_codes: ["provider_unavailable"],
            input_sha256: heldCanonical.sha256,
          },
          target: { surface: "comment", communityId: "text-community", postId: "text-order6-post" },
        }),
      );
      expect(approvedSubmissionReplay).toMatchObject({
        kind: "replay",
        snapshot: { status: "manual_review", published_resource: null },
      });
      const approvedRead = await runStore(connection, (store) =>
        store.getForAuthor({ submissionId: heldResult.snapshot.submission_id, actor }),
      );
      expect(approvedRead).toMatchObject({
        status: "published",
        published_resource: { kind: "comment" },
      });
      const counts = await admin.query(
        `SELECT
           (SELECT count(*)::int FROM comment_reports) AS reports,
           (SELECT count(*)::int FROM text_moderation_cases) AS cases,
           (SELECT count(*)::int FROM comment_moderation_cases) AS comment_cases,
           (SELECT count(*)::int FROM comments) AS comments,
           (SELECT comment_count FROM posts WHERE post_id = 'text-order6-post') AS comment_count,
           (SELECT count(*)::int FROM content_publication_outbox) AS outbox`,
      );
      expect(counts.rows[0]).toEqual({
        reports: 2,
        cases: 1,
        comment_cases: 2,
        comments: 2,
        comment_count: 2,
        outbox: 6,
      });

      const awaitActionHash = (caseRef: string, key: string, action: string) =>
        Effect.runPromise(
          canonicalBodyHash({
            endpoint: "POST /moderation/cases/:caseRef/actions",
            case_ref: caseRef,
            body: { idempotency_key: key, action },
          }),
        );
      const runAction = async (caseRef: string, key: string, action: string) => {
        const requestHash = await awaitActionHash(caseRef, key, action);
        return runStore(connection, (store) =>
          store.moderateCaseAction({
            caseRef,
            actor: moderator,
            idempotencyKey: key,
            action: action as "approve" | "dismiss" | "hide" | "remove" | "restore",
            requestHash,
          }),
        );
      };
      const expectActionConflict = async (caseRef: string, key: string, action: string) => {
        let actionFailure: unknown = await runAction(caseRef, key, action).then(
          () => null,
          (error: unknown) => error,
        );
        while (Array.isArray(actionFailure)) actionFailure = actionFailure[0];
        expect(actionFailure).toMatchObject({
          _tag: "TextPostRepositoryError",
          reason: "action-conflict",
        });
      };
      const resolvedCaseHash = await awaitActionHash(
        report.caseRef,
        "action-order6-resolved-case",
        "restore",
      );
      const resolvedCaseAction = await runStore(connection, (store) =>
        store.moderateCaseAction({
          caseRef: report.caseRef,
          actor: moderator,
          idempotencyKey: "action-order6-resolved-case",
          action: "restore",
          requestHash: resolvedCaseHash,
        }),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      let resolvedCaseFailure: unknown = resolvedCaseAction;
      while (Array.isArray(resolvedCaseFailure)) resolvedCaseFailure = resolvedCaseFailure[0];
      expect(resolvedCaseFailure).toMatchObject({
        _tag: "TextPostRepositoryError",
        reason: "action-conflict",
      });
      const hidden = await runAction(report.caseRef, "action-order6-hide", "hide");
      expect(hidden).toMatchObject({ targetStatus: "hidden" });
      const afterHideHash = await reportHash("report-order6-3");
      const afterHideReport = await runStore(connection, (store) =>
        store.reportComment({
          commentId,
          actor,
          idempotencyKey: "report-order6-3",
          reasonCode: "spam",
          requestHash: afterHideHash,
        }),
      );
      expect(afterHideReport).toMatchObject({ status: "open" });
      await expectActionConflict(afterHideReport.caseRef, "action-order6-hide-hidden", "hide");
      const restored = await runAction(
        afterHideReport.caseRef,
        "action-order6-restore-hidden",
        "restore",
      );
      expect(restored).toMatchObject({ targetStatus: "published" });
      const afterRestoreHash = await reportHash("report-order6-4");
      const afterRestoreReport = await runStore(connection, (store) =>
        store.reportComment({
          commentId,
          actor,
          idempotencyKey: "report-order6-4",
          reasonCode: "spam",
          requestHash: afterRestoreHash,
        }),
      );
      await expectActionConflict(
        afterRestoreReport.caseRef,
        "action-order6-restore-published",
        "restore",
      );
      const removed = await runAction(afterRestoreReport.caseRef, "action-order6-remove", "remove");
      expect(removed).toMatchObject({ targetStatus: "removed" });
      const afterRemoveHash = await reportHash("report-order6-5");
      const afterRemoveReport = await runStore(connection, (store) =>
        store.reportComment({
          commentId,
          actor,
          idempotencyKey: "report-order6-5",
          reasonCode: "spam",
          requestHash: afterRemoveHash,
        }),
      );
      await expectActionConflict(
        afterRemoveReport.caseRef,
        "action-order6-remove-removed",
        "remove",
      );
      const restoredRemoved = await runAction(
        afterRemoveReport.caseRef,
        "action-order6-restore-removed",
        "restore",
      );
      expect(restoredRemoved).toMatchObject({ targetStatus: "published" });
      const visibilityEffects = await admin.query<{
        readonly event_type: string;
        readonly effect_key: string;
      }>(
        `SELECT event_type, effect_key
           FROM content_publication_outbox
          WHERE submission_id = $1 AND event_type = 'comment_cache_invalidation'
          ORDER BY effect_key`,
        [publishedResult.snapshot.submission_id],
      );
      expect(visibilityEffects.rows).toHaveLength(5);
      expect(new Set(visibilityEffects.rows.map((row) => row.effect_key)).size).toBe(5);
    });
  }, 30_000);
});
