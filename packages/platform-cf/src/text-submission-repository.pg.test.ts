import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type {
  CreatePostBody,
  M2Actor,
  TextPostModerationEvaluation,
  TextPostStore,
  TextPostSubmissionDocument,
} from "@pirate/application";
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
  use: (store: TextPostStore["Service"]) => Effect.Effect<A, E>,
): Promise<A> {
  const layer = makeDirectPostgresControlPlaneLayer(connection);
  const store = makeControlPlaneTextSubmissionStore(layer);
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
});
