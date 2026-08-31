import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_OPTIONAL_ROUTE_V2_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-optional-route-v2-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-optional-route-v2-suite-complete\n";
const testCount = 1;
let completedTestCount = 0;

function schemaName(): string {
  return `api_next_optional_route_v2_${crypto.randomUUID().replaceAll("-", "")}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function scopedConnection(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=-csearch_path%3D${schema}`;
}

const schemas = new Set<string>();

async function withSchema(
  run: (connection: string, admin: Client) => Promise<void>,
): Promise<void> {
  if (connectionString === undefined) throw new Error("missing PostgreSQL test URL");
  const schema = schemaName();
  schemas.add(schema);
  const root = new Client({ connectionString });
  await root.connect();
  await root.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await root.end();
  const connection = scopedConnection(connectionString, schema);
  const admin = new Client({ connectionString: connection });
  await admin.connect();
  try {
    await run(connection, admin);
  } finally {
    await admin.end();
  }
}

afterAll(async () => {
  if (connectionString === undefined) return;
  const admin = new Client({ connectionString });
  await admin.connect();
  try {
    for (const schema of schemas) {
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    }
  } finally {
    await admin.end();
  }
  if (completedTestCount === testCount) await Bun.write(sentinelPath, sentinelContents);
});

suite("optional-route-v2 sibling attachment aggregate", () => {
  test("checks authority at creation and commits only exact attachment evidence", async () => {
    await withSchema(async (connection, admin) => {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      const actorId = "optional-route-attachment-actor";
      const otherActorId = "optional-route-attachment-other";
      const communityId = "community_123e4567-e89b-42d3-a456-426614174000";
      const requirementHash = "1".repeat(64);
      const providerBindingHash = "2".repeat(64);
      const evidenceDigest = "3".repeat(64);
      const providerIdentityDigest = "4".repeat(64);
      const requestHash = "5".repeat(64);
      await admin.query(
        `INSERT INTO users (user_id, status, account)
         VALUES ($1, 'active', '{}'::jsonb), ($2, 'active', '{}'::jsonb)`,
        [actorId, otherActorId],
      );
      await admin.query(
        `INSERT INTO communities (
           community_id, display_name, status, created_by_user_id,
           canonical_route_binding_id, route_authority_version, route_slug,
           created_at, updated_at
         ) VALUES ($1, 'Optional attachment', 'active', $2, NULL,
           'optional_route_v2', NULL, clock_timestamp(), clock_timestamp())`,
        [communityId, actorId],
      );
      await admin.query(
        `INSERT INTO community_route_authority_grants (
           grant_id, community_id, principal_user_id, authority, source_kind,
           source_policy_ref, status, granted_at, granted_by_user_id
         ) VALUES (
           'optional-route-owner-grant', $1, $2, 'manage_routes', 'creator_owner',
           NULL, 'active', clock_timestamp(), $2
         )`,
        [communityId, actorId],
      );

      await expect(
        admin.query(
          `INSERT INTO community_route_attachment_intents (
             attachment_intent_id, community_id, actor_id, authority_grant_id,
             create_idempotency_key, create_request_hash, revision, status,
             family, root_label, root_label_display, requirement_hash,
             provider_id, provider_binding_hash, provider_configuration_kind,
             provider_configuration_ref, provider_configuration_version,
             protocol_version, expires_at
           ) VALUES (
             'optional-route-unauthorized', $1, $2, 'optional-route-owner-grant',
             'optional-route-unauthorized-create', $3, 1, 'verification_required',
             'hns', 'optional-route', 'optional-route', $4,
             'hns.owner.v1', $5, 'managed', 'hns-owner-test', '1',
             'hns-txt-v1', clock_timestamp() + interval '1 hour'
           )`,
          [communityId, otherActorId, requestHash, requirementHash, providerBindingHash],
        ),
      ).rejects.toThrow("route attachment requires active community manage_routes authority");

      await admin.query("BEGIN");
      await admin.query(
        `INSERT INTO community_route_attachment_intents (
           attachment_intent_id, community_id, actor_id, authority_grant_id,
           create_idempotency_key, create_request_hash, revision, status,
           family, root_label, root_label_display, requirement_hash,
           provider_id, provider_binding_hash, provider_configuration_kind,
           provider_configuration_ref, provider_configuration_version,
           protocol_version, expires_at
         ) VALUES (
           'optional-route-slot-holder', $1, $2, 'optional-route-owner-grant',
           'optional-route-slot-holder-create', $3, 1, 'verification_required',
           'hns', 'slot-holder', 'slot-holder', $4,
           'hns.owner.v1', $5, 'managed', 'hns-owner-test', '1',
           'hns-txt-v1', clock_timestamp() + interval '1 hour'
         )`,
        [communityId, actorId, requestHash, requirementHash, providerBindingHash],
      );
      await admin.query(
        `INSERT INTO community_route_attachment_requirement_states (
           attachment_intent_id, actor_id, requirement_kind, status,
           requirement_hash, provider_id, provider_binding_hash,
           provider_configuration_kind, provider_configuration_ref,
           provider_configuration_version, family, root_label,
           root_label_display, path_segment, generation
         ) VALUES (
           'optional-route-slot-holder', $1, 'namespace_ownership', 'unmet',
           $2, 'hns.owner.v1', $3, 'managed', 'hns-owner-test', '1',
           'hns', 'slot-holder', 'slot-holder', 'app.slot-holder', 0
         )`,
        [actorId, requirementHash, providerBindingHash],
      );
      await admin.query("SAVEPOINT one_nonterminal_attachment");
      await expect(
        admin.query(
          `INSERT INTO community_route_attachment_intents (
             attachment_intent_id, community_id, actor_id, authority_grant_id,
             create_idempotency_key, create_request_hash, revision, status,
             family, root_label, root_label_display, requirement_hash,
             provider_id, provider_binding_hash, provider_configuration_kind,
             provider_configuration_ref, provider_configuration_version,
             protocol_version, expires_at
           ) VALUES (
             'optional-route-slot-contender', $1, $2, 'optional-route-owner-grant',
             'optional-route-slot-contender-create', $3, 1, 'verification_required',
             'hns', 'slot-contender', 'slot-contender', $4,
             'hns.owner.v1', $5, 'managed', 'hns-owner-test', '1',
             'hns-txt-v1', clock_timestamp() + interval '1 hour'
           )`,
          [communityId, actorId, requestHash, requirementHash, providerBindingHash],
        ),
      ).rejects.toThrow("community_route_attachment_intents_one_open_per_community_uidx");
      await admin.query("ROLLBACK TO SAVEPOINT one_nonterminal_attachment");
      await admin.query(
        `UPDATE community_route_attachment_intents
            SET revision = 2, status = 'cancelled', updated_at = clock_timestamp()
          WHERE attachment_intent_id = 'optional-route-slot-holder'`,
      );
      await admin.query("COMMIT");

      await admin.query("BEGIN");
      await admin.query(
        `INSERT INTO community_route_attachment_intents (
           attachment_intent_id, community_id, actor_id, authority_grant_id,
           create_idempotency_key, create_request_hash, revision, status,
           family, root_label, root_label_display, requirement_hash,
           provider_id, provider_binding_hash, provider_configuration_kind,
           provider_configuration_ref, provider_configuration_version,
           protocol_version, expires_at
         ) VALUES (
           'optional-route-attachment', $1, $2, 'optional-route-owner-grant',
           'optional-route-attachment-create', $3, 1, 'verification_required',
           'hns', 'optional-route', 'optional-route', $4,
           'hns.owner.v1', $5, 'managed', 'hns-owner-test', '1',
           'hns-txt-v1', clock_timestamp() + interval '1 hour'
         )`,
        [communityId, actorId, requestHash, requirementHash, providerBindingHash],
      );
      await admin.query(
        `INSERT INTO community_route_attachment_requirement_states (
           attachment_intent_id, actor_id, requirement_kind, status,
           requirement_hash, provider_id, provider_binding_hash,
           provider_configuration_kind, provider_configuration_ref,
           provider_configuration_version, family, root_label,
           root_label_display, path_segment, generation
         ) VALUES (
           'optional-route-attachment', $1, 'namespace_ownership', 'unmet',
           $2, 'hns.owner.v1', $3, 'managed', 'hns-owner-test', '1',
           'hns', 'optional-route', 'optional-route', 'app.optional-route', 0
         )`,
        [actorId, requirementHash, providerBindingHash],
      );
      await admin.query(
        `INSERT INTO community_route_attachment_ceremony_attempts (
           ceremony_intent_id, attachment_intent_id, actor_id, requirement_kind,
           generation, requirement_hash, provider_id, provider_binding_hash,
           provider_configuration_kind, provider_configuration_ref,
           provider_configuration_version, family, root_label,
           root_label_display, path_segment, reservation_request_hash,
           reservation_request, expires_at
         ) VALUES (
           'optional-route-ceremony', 'optional-route-attachment', $1,
           'namespace_ownership', 1, $2, 'hns.owner.v1', $3,
           'managed', 'hns-owner-test', '1', 'hns', 'optional-route',
           'optional-route', 'app.optional-route', $4, '{}'::jsonb,
           clock_timestamp() + interval '30 minutes'
         )`,
        [actorId, requirementHash, providerBindingHash, requestHash],
      );
      await admin.query(
        `UPDATE community_route_attachment_requirement_states
            SET status = 'pending', generation = 1,
                current_ceremony_intent_id = 'optional-route-ceremony',
                updated_at = clock_timestamp()
          WHERE attachment_intent_id = 'optional-route-attachment'`,
      );
      await admin.query(
        `INSERT INTO community_route_attachment_ceremony_results (
           ceremony_intent_id, actor_id, attachment_intent_id, requirement_kind,
           generation, callback_idempotency_key, callback_request_hash,
           outcome_status, result_hash, evidence_ref, evidence_digest,
           provider_identity_digest, terminal_at, satisfied_at
         ) VALUES (
           'optional-route-ceremony', $1, 'optional-route-attachment',
           'namespace_ownership', 1, 'optional-route-callback', $2,
           'satisfied', $2, 'optional-route-evidence', $3, $4,
           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
         )`,
        [actorId, requestHash, evidenceDigest, providerIdentityDigest],
      );
      await admin.query(
        `UPDATE community_route_attachment_requirement_states
            SET status = 'satisfied', satisfied_at = (
                  SELECT satisfied_at
                    FROM community_route_attachment_ceremony_results
                   WHERE ceremony_intent_id = 'optional-route-ceremony'
                ),
                updated_at = clock_timestamp()
          WHERE attachment_intent_id = 'optional-route-attachment'`,
      );
      await admin.query(
        `INSERT INTO community_route_ownership_evidence (
           evidence_ref, creation_ceremony_intent_id, verified_by_actor_id,
           family, root_label, root_label_display, path_segment,
           requirement_hash, provider_id, provider_binding_hash,
           provider_configuration_version, provider_identity_digest,
           evidence_digest, evidence_receipt_id, binding_generation,
           verified_at, expires_at, origin, route_revalidation_attempt_id,
           route_attachment_ceremony_intent_id
         ) VALUES (
           'optional-route-evidence', NULL, $1, 'hns', 'optional-route',
           'optional-route', 'app.optional-route', $2, 'hns.owner.v1', $3,
           '1', $4, $5, NULL, 1, (
             SELECT satisfied_at FROM community_route_attachment_ceremony_results
              WHERE ceremony_intent_id = 'optional-route-ceremony'
           ), clock_timestamp() + interval '30 minutes', 'route_attachment',
           NULL, 'optional-route-ceremony'
         )`,
        [actorId, requirementHash, providerBindingHash, providerIdentityDigest, evidenceDigest],
      );
      await admin.query(
        `UPDATE community_route_attachment_intents
            SET revision = 2, status = 'commit_ready', updated_at = clock_timestamp()
          WHERE attachment_intent_id = 'optional-route-attachment'`,
      );
      await admin.query("SAVEPOINT attachment_commit_authority_recheck");
      await admin.query(
        `UPDATE community_route_authority_grants
            SET status = 'revoked', revoked_at = clock_timestamp(), revoked_by_user_id = $1
          WHERE grant_id = 'optional-route-owner-grant'`,
        [actorId],
      );
      await expect(
        admin.query(
          `UPDATE community_route_attachment_intents
              SET revision = 3, status = 'committed',
                  committed_route_binding_id = 'missing-route-binding',
                  committed_resource = '{}'::jsonb,
                  updated_at = clock_timestamp()
            WHERE attachment_intent_id = 'optional-route-attachment'`,
        ),
      ).rejects.toThrow("route attachment requires active community manage_routes authority");
      await admin.query("ROLLBACK TO SAVEPOINT attachment_commit_authority_recheck");
      await admin.query("COMMIT");

      const contender = new Client({ connectionString: connection });
      const observer = new Client({ connectionString: connection });
      await contender.connect();
      await observer.connect();
      try {
        await admin.query("BEGIN");
        await contender.query("BEGIN");
        const contenderPid = await contender.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        await admin.query(
          `INSERT INTO community_canonical_route_bindings (
             route_binding_id, community_id, family, root_label, root_label_display,
             ownership_status, route_lifecycle_status, binding_generation,
             verified_evidence_ref
           ) VALUES (
             'optional-route-binding', $1, 'hns', 'optional-route',
             'optional-route', 'verified', 'active', 1, 'optional-route-evidence'
           )`,
          [communityId],
        );
        const competingInsert = contender.query(
          `INSERT INTO community_canonical_route_bindings (
             route_binding_id, community_id, family, root_label, root_label_display,
             ownership_status, route_lifecycle_status, binding_generation,
             verified_evidence_ref
           ) VALUES (
             'optional-route-binding-race', $1, 'hns', 'optional-route',
             'optional-route', 'verified', 'active', 1, 'optional-route-evidence'
           )`,
          [communityId],
        );

        let contenderWaitedOnLock = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const activity = await observer.query<{ wait_event_type: string | null }>(
            "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
            [contenderPid.rows[0]?.pid],
          );
          if (activity.rows[0]?.wait_event_type === "Lock") {
            contenderWaitedOnLock = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(contenderWaitedOnLock).toBe(true);

        await admin.query(
          `UPDATE communities
              SET canonical_route_binding_id = 'optional-route-binding',
                  updated_at = clock_timestamp()
            WHERE community_id = $1`,
          [communityId],
        );
        await admin.query(
          `UPDATE community_route_attachment_intents
              SET revision = 3, status = 'committed',
                  committed_route_binding_id = 'optional-route-binding',
                  committed_resource = jsonb_build_object(
                    'authority_version', 'optional_route_v2',
                    'community_id', $1::text,
                    'href', '/c/' || $1::text,
                    'canonical_route', jsonb_build_object(
                      'family', 'hns',
                      'root_label', 'optional-route',
                      'root_label_display', 'optional-route',
                      'path_segment', 'app.optional-route',
                      'href', '/c/app.optional-route',
                      'app_host', NULL
                    )
                  ),
                  updated_at = clock_timestamp()
            WHERE attachment_intent_id = 'optional-route-attachment'`,
          [communityId],
        );
        await admin.query("COMMIT");
        await expect(competingInsert).rejects.toThrow(
          "route attachment commit requires the community to remain unrouted",
        );
        await contender.query("ROLLBACK");
      } finally {
        await contender.query("ROLLBACK").catch(() => undefined);
        await contender.end();
        await observer.end();
      }

      const committed = await admin.query<{
        status: string;
        canonical_route_binding_id: string;
        authority_version: string;
      }>(
        `SELECT intent.status, community.canonical_route_binding_id,
                intent.committed_resource ->> 'authority_version' AS authority_version
           FROM community_route_attachment_intents AS intent
           JOIN communities AS community ON community.community_id = intent.community_id
          WHERE intent.attachment_intent_id = 'optional-route-attachment'`,
      );
      expect(committed.rows).toEqual([
        {
          status: "committed",
          canonical_route_binding_id: "optional-route-binding",
          authority_version: "optional_route_v2",
        },
      ]);
    });
    completedTestCount += 1;
  }, 30_000);
});
