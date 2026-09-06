import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import {
  makeControlPlaneHnsCommunityRootImportRepository,
  makeControlPlaneHnsCommunityRootImportStartStore,
} from "./hns-community-root-import-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneRouteAttachmentCompletionStore } from "./route-attachment-completion-repository.ts";
import {
  makeControlPlaneRouteAttachmentOwnershipStartAuthorityResolver,
  makeControlPlaneRouteAttachmentOwnershipStartStore,
} from "./route-attachment-start-repository.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
const suite = connectionString === undefined ? describe.skip : describe;
const communityId = "community_123e4567-e89b-42d3-a456-426614174000";
const actorId = "community-root-import-actor";
const expiresAt = "2099-01-01T00:00:00.000Z";

function quoted(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
function scoped(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}
async function withSchema<A>(use: (connection: string, admin: Client) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  const schema = `api_next_hns_community_import_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoted(schema)}`);
  await admin.query(`SET search_path TO ${quoted(schema)}`);
  try {
    const connection = scoped(connectionString, schema);
    await applyPostgresTestBaselineConnection({ connectionString: connection });
    return await use(connection, admin);
  } finally {
    await admin.query(`DROP SCHEMA ${quoted(schema)} CASCADE`);
    await admin.end();
  }
}

const binding = {
  requirement: "namespace_ownership" as const,
  family: "hns" as const,
  provider_id: "hns.owner.v1",
  provider_configuration: { kind: "managed" as const, reference: "hns-owner-test", version: "1" },
  protocol_version: "hns-txt-v1",
};

suite("community HNS root-import repositories", () => {
  test("persists preparation, provider session, root-import session, and exact replay", async () => {
    await withSchema(async (connection, admin) => {
      expect(
        (
          await admin.query<{ proname: string; proconfig: string[] }>(
            `SELECT proname,proconfig FROM pg_proc
              WHERE proname IN ('guard_hns_root_import_session_change',
                'guard_hns_root_import_session_insert',
                'reject_hns_community_root_import_preparation_change')
                AND pronamespace = current_schema()::regnamespace
              ORDER BY proname`,
          )
        ).rows,
      ).toEqual([
        {
          proname: "guard_hns_root_import_session_change",
          proconfig: [expect.stringContaining("search_path=")],
        },
        {
          proname: "guard_hns_root_import_session_insert",
          proconfig: [expect.stringContaining("search_path=")],
        },
        {
          proname: "reject_hns_community_root_import_preparation_change",
          proconfig: [expect.stringContaining("search_path=")],
        },
      ]);
      await admin.query(
        "INSERT INTO users (user_id,status,account) VALUES ($1,'active','{}'::jsonb)",
        [actorId],
      );
      await admin.query(
        `INSERT INTO communities (community_id,display_name,status,created_by_user_id,canonical_route_binding_id,route_authority_version,route_slug,created_at,updated_at)
        VALUES ($1,'Community root import','active',$2,NULL,'optional_route_v2',NULL,clock_timestamp(),clock_timestamp())`,
        [communityId, actorId],
      );
      await admin.query(
        `INSERT INTO community_route_authority_grants (grant_id,community_id,principal_user_id,authority,source_kind,source_policy_ref,status,granted_at,granted_by_user_id)
        VALUES ('community-root-import-grant',$1,$2,'manage_routes','creator_owner',NULL,'active',clock_timestamp(),$2)`,
        [communityId, actorId],
      );
      const layer = makeDirectPostgresControlPlaneLayer(connection);
      const communityStore = makeControlPlaneHnsCommunityRootImportStartStore(layer, {
        environment: "test",
        provider_binding: binding,
      });
      const current = (actor = actorId, community = communityId) =>
        Effect.runPromise(communityStore.getCurrent({ actor_id: actor, community_id: community }));
      expect(await current()).toEqual({
        community_id: communityId,
        attachment: null,
        session: null,
      });
      expect(await current("another-actor")).toBeNull();
      expect(await current(actorId, "missing-community")).toBeNull();
      const prepareInput = {
        request: {
          actor_id: actorId,
          community_id: communityId,
          root_label: "dankmemes",
          idempotency_key: "community-import-start",
        },
        attachment_intent_id: "community-import-attachment",
        ceremony_intent_id: "community-import-ceremony",
        root_import_session_id: "community-import-session",
        provision_job_id: "community-import-provision",
        request_sha256: "1".repeat(64),
      };
      const rawCommunityStore = makeControlPlaneHnsCommunityRootImportRepository({
        environment: "test",
        provider_binding: binding,
      });
      const prepared = await Effect.runPromise(
        Effect.scoped(rawCommunityStore.prepare(prepareInput).pipe(Effect.provide(layer))),
      );
      expect(prepared).toMatchObject({
        kind: "created",
        value: { root_label: "dankmemes", attachment_revision: 1 },
      });
      if (prepared.kind === "conflict" || prepared.kind === "not_found")
        throw new Error("expected preparation");
      const previousMigration = await Bun.file(
        new URL(
          "../../../db/postgres/migrations/0115_hns_community_root_import.sql",
          import.meta.url,
        ),
      ).text();
      const forwardMigration = await Bun.file(
        new URL(
          "../../../db/postgres/migrations/0129_hns_provisional_community_import.sql",
          import.meta.url,
        ),
      ).text();
      const previousPreparationTable = previousMigration.slice(
        previousMigration.indexOf("CREATE TABLE hns_community_root_import_preparations"),
        previousMigration.indexOf(
          "CREATE FUNCTION reject_hns_community_root_import_preparation_change",
        ),
      );
      const retainedPreparation = (
        await admin.query(
          "SELECT to_jsonb(preparation) AS retained FROM hns_community_root_import_preparations preparation",
        )
      ).rows[0].retained;
      await admin.query("BEGIN");
      try {
        // Restore the actual pre-amendment table, populate it, and execute the
        // complete forward migration. Roll back this fixture-only schema change.
        await admin.query("DROP TABLE hns_community_root_import_preparations");
        await admin.query(previousPreparationTable);
        await admin.query(
          "INSERT INTO hns_community_root_import_preparations SELECT (jsonb_populate_record(NULL::hns_community_root_import_preparations,$1::jsonb)).*",
          [JSON.stringify(retainedPreparation)],
        );
        await admin.query(`DROP FUNCTION hns_community_root_import_reservation_held_v1(text);
          DROP FUNCTION admit_hns_community_root_import_v1(text,text,text);
          DROP FUNCTION guard_hns_community_root_import_admission_v1();
          DROP FUNCTION lock_hns_root_zone_mutation_v1(text,text,boolean,text,text,bigint);`);
        await admin.query(forwardMigration);
        expect(
          (
            await admin.query(
              "SELECT admission_kind,start_request_sha256 FROM hns_community_root_import_preparations",
            )
          ).rows,
        ).toEqual([{ admission_kind: "name_signature", start_request_sha256: "1".repeat(64) }]);
        expect(
          (await admin.query("SELECT count(*)::integer AS count FROM hns_authority_provision_jobs"))
            .rows,
        ).toEqual([{ count: 0 }]);
      } finally {
        await admin.query("ROLLBACK");
      }

      expect(
        await Effect.runPromise(
          Effect.scoped(
            communityStore.prepare({ ...prepareInput, attachment_intent_id: "ignored" }),
          ),
        ),
      ).toMatchObject({
        kind: "replay",
        value: { attachment_intent_id: "community-import-attachment" },
      });
      const resolver = makeControlPlaneRouteAttachmentOwnershipStartAuthorityResolver(layer);
      const authority = await Effect.runPromise(
        resolver.resolve({
          actor_id: actorId,
          community_id: communityId,
          attachment_intent_id: "community-import-attachment",
          ceremony_intent_id: "community-import-ceremony",
          expected_revision: 1,
        }),
      );
      expect(authority).toMatchObject({
        actor_id: actorId,
        community_id: communityId,
        provider_id: "hns.owner.v1",
        route: { root_label: "dankmemes" },
      });
      if (authority === null) throw new Error("expected authority");
      const start = {
        operation_kind: "route_attachment" as const,
        actor_id: actorId,
        community_id: communityId,
        attachment_intent_id: authority.attachment_intent_id,
        ceremony_intent_id: authority.ceremony_intent_id,
        requirement_hash: authority.requirement_hash,
        generation: 1,
        request_hash: "2".repeat(64),
        provider_binding_hash: authority.provider_binding_hash,
        provider_configuration: authority.provider_configuration,
        protocol_version: "hns-txt-v1",
        environment: "test",
        route: authority.route,
      };
      const ownershipStore = makeControlPlaneRouteAttachmentOwnershipStartStore(layer);
      const reserved = await Effect.runPromise(
        Effect.scoped(
          ownershipStore.reserve({
            start,
            provider_id: "hns.owner.v1",
            expected_revision: 1,
            client_idempotency_key: "ownership-start",
            reservation_id: "community-import-reservation",
            namespace_session_id: "community-import-namespace",
            ttl_ms: 60_000,
          }),
        ),
      );
      expect(reserved.kind).toBe("acquired");
      if (reserved.kind !== "acquired") throw new Error("expected reservation");
      await Effect.runPromise(Effect.scoped(ownershipStore.release(reserved.reservation)));
      const reacquired = await Effect.runPromise(
        Effect.scoped(
          ownershipStore.reserve({
            start,
            provider_id: "hns.owner.v1",
            expected_revision: 1,
            client_idempotency_key: "ownership-start",
            reservation_id: "ignored-reacquire-reservation",
            namespace_session_id: "ignored-reacquire-namespace",
            ttl_ms: 60_000,
          }),
        ),
      );
      expect(reacquired).toMatchObject({
        kind: "acquired",
        reservation: {
          namespace_session_id: "community-import-namespace",
          fence_token: 2,
        },
      });
      if (reacquired.kind !== "acquired") throw new Error("expected reacquired reservation");
      const providerResult = {
        session: {
          ...start,
          provider_id: "hns.owner.v1",
          upstream_session_ref: "hns-community-upstream",
          expires_at: expiresAt,
        },
        presentation: {
          kind: "embedded_sdk" as const,
          session_id: "hns-community-upstream",
          protocol: "hns-txt-challenge",
          version: "1",
          payload: {
            ownership_source: "hns_parent_chain_txt",
            challenge_name: "dankmemes",
            challenge_value: "pirate-verification=community-import",
            expires_at: expiresAt,
          },
        },
      };
      expect(
        await Effect.runPromise(
          Effect.scoped(ownershipStore.finalize(reacquired.reservation, providerResult)),
        ),
      ).toMatchObject({ kind: "created", namespace_session_id: "community-import-namespace" });
      const ownership = {
        operation_kind: "route_attachment" as const,
        community_id: communityId,
        attachment_intent_id: "community-import-attachment",
        ceremony_intent_id: "community-import-ceremony",
        generation: 1,
        session_id: "community-import-namespace",
        channel: "poll_result" as const,
        status: "pending" as const,
        expires_at: expiresAt,
        challenge: {
          ownership_source: "hns_parent_chain_txt" as const,
          challenge_name: "dankmemes",
          challenge_value: "pirate-verification=community-import",
          record: { type: "TXT" as const, txt: ["pirate-verification=community-import"] as const },
          expires_at: expiresAt,
        },
        replayed: false,
      };
      const started = await Effect.runPromise(
        Effect.scoped(
          communityStore.start({
            preparation: prepared.value,
            ownership,
            idempotency_key: "community-import-start",
            request_sha256: "1".repeat(64),
          }),
        ),
      );
      expect(started).toMatchObject({
        kind: "created",
        session: {
          community_id: communityId,
          status: "provisioning",
          root_label: "dankmemes",
        },
      });
      expect(
        await Effect.runPromise(
          Effect.scoped(
            communityStore.get({
              actor_id: actorId,
              community_id: communityId,
              root_import_session_id: "community-import-session",
            }),
          ),
        ),
      ).toMatchObject({
        community_id: communityId,
        status: "provisioning",
        replayed: false,
      });
      expect(
        await Effect.runPromise(
          Effect.scoped(
            communityStore.start({
              preparation: prepared.value,
              ownership,
              idempotency_key: "community-import-start",
              request_sha256: "1".repeat(64),
            }),
          ),
        ),
      ).toMatchObject({ kind: "replay", session: { replayed: true } });
      expect(
        (
          await admin.query(
            "SELECT origin_kind FROM hns_root_import_sessions WHERE root_import_session_id='community-import-session'",
          )
        ).rows[0],
      ).toEqual({ origin_kind: "community_attachment" });

      expect(await current()).toMatchObject({
        community_id: communityId,
        session: {
          root_import_session_id: "community-import-session",
          status: "provisioning",
        },
      });
      const secondCommunityId = "community_123e4567-e89b-42d3-a456-426614174001";
      await admin.query(
        `INSERT INTO communities (community_id,display_name,status,created_by_user_id,
           canonical_route_binding_id,route_authority_version,route_slug,created_at,updated_at)
         VALUES ($1,'Second root import','active',$2,NULL,'optional_route_v2',NULL,
           clock_timestamp(),clock_timestamp())`,
        [secondCommunityId, actorId],
      );
      expect(
        await Effect.runPromise(
          Effect.scoped(
            communityStore.get({
              actor_id: actorId,
              community_id: secondCommunityId,
              root_import_session_id: "community-import-session",
            }),
          ),
        ),
      ).toBeNull();
      await admin.query(
        `INSERT INTO community_route_authority_grants (grant_id,community_id,
           principal_user_id,authority,source_kind,source_policy_ref,status,granted_at,
           granted_by_user_id) VALUES ('community-root-import-grant-2',$1,$2,
           'manage_routes','creator_owner',NULL,'active',clock_timestamp(),$2)`,
        [secondCommunityId, actorId],
      );
      expect(
        await Effect.runPromise(
          Effect.scoped(
            communityStore.prepare({
              ...prepareInput,
              request: { ...prepareInput.request, community_id: secondCommunityId },
              attachment_intent_id: "cross-community-key",
            }),
          ),
        ),
      ).toEqual({ kind: "conflict" });
      expect(
        await Effect.runPromise(
          Effect.scoped(
            communityStore.prepare({
              ...prepareInput,
              request: {
                ...prepareInput.request,
                community_id: secondCommunityId,
                idempotency_key: "community-import-start-2",
              },
              attachment_intent_id: "community-import-attachment-2",
              ceremony_intent_id: "community-import-ceremony-2",
              root_import_session_id: "community-import-session-2",
              provision_job_id: "community-import-provision-2",
              request_sha256: "3".repeat(64),
            }),
          ),
        ),
      ).toMatchObject({ kind: "conflict" });

      expect(await current(actorId, secondCommunityId)).toEqual({
        community_id: secondCommunityId,
        attachment: null,
        session: null,
      });
      expect(
        (
          await admin.query(
            "SELECT count(*)::integer AS count FROM hns_root_import_name_proof_observations",
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
      expect(
        (
          await admin.query(
            "SELECT provision_authorization_kind,ownership_result_sha256 FROM hns_root_import_sessions WHERE root_import_session_id=$1",
            ["community-import-session"],
          )
        ).rows,
      ).toEqual([
        { provision_authorization_kind: "community_provisional", ownership_result_sha256: null },
      ]);
      const claim = await admin.query("SELECT * FROM claim_hns_authority_provision_job_v1($1,60)", [
        "provisional-executor",
      ]);
      expect(claim.rows).toHaveLength(1);
      expect(claim.rows[0]).toMatchObject({
        root_import_session_id: "community-import-session",
        operation_kind: "provision_root_v1",
      });
      expect(
        (
          await admin.query(
            "SELECT status FROM community_route_attachment_namespace_sessions WHERE namespace_session_id=$1",
            ["community-import-namespace"],
          )
        ).rows,
      ).toEqual([{ status: "pending" }]);

      expect(
        (
          await admin.query(
            "SELECT lock_hns_root_zone_mutation_v1('dankmemes','pirate-verification=community-import',false,'community-import-provision','wrong-executor',1) AS admitted",
          )
        ).rows,
      ).toEqual([{ admitted: false }]);
      expect(
        (
          await admin.query(
            "SELECT lock_hns_root_zone_mutation_v1('dankmemes','pirate-verification=community-import',false,'community-import-provision','provisional-executor',2) AS admitted",
          )
        ).rows,
      ).toEqual([{ admitted: false }]);
      await admin.query("BEGIN");
      const competing = new Client({ connectionString: connection });
      await competing.connect();
      try {
        expect(
          (
            await admin.query(
              "SELECT lock_hns_root_zone_mutation_v1('dankmemes','pirate-verification=community-import',false,'community-import-provision','provisional-executor',1) AS admitted",
            )
          ).rows,
        ).toEqual([{ admitted: true }]);
        await expect(
          competing.query(
            "SELECT 1 FROM hns_root_import_sessions WHERE root_import_session_id='community-import-session' FOR UPDATE NOWAIT",
          ),
        ).rejects.toMatchObject({ code: "55P03" });
        await expect(
          competing.query(
            "SELECT 1 FROM hns_authority_provision_jobs WHERE provision_job_id='community-import-provision' FOR UPDATE NOWAIT",
          ),
        ).rejects.toMatchObject({ code: "55P03" });
      } finally {
        await admin.query("ROLLBACK");
        await competing.end();
      }

      const completion = makeControlPlaneRouteAttachmentCompletionStore(layer);
      const completionRequest = {
        actor_id: actorId,
        community_id: communityId,
        attachment_intent_id: "community-import-attachment",
        ceremony_intent_id: "community-import-ceremony",
        session_id: "community-import-namespace",
        expected_revision: 1,
        idempotency_key: "community-import-owner-update",
        channel: "poll_result" as const,
      };
      const completionReservation = await Effect.runPromise(
        Effect.scoped(
          completion.reserve({
            request: completionRequest,
            completion_request_sha256: "7".repeat(64),
            completion_attempt_id: "community-import-completion",
            evidence_ref: "community-import-route-evidence",
            lease_ms: 60_000,
            max_attempts: 3,
          }),
        ),
      );
      expect(completionReservation.kind).toBe("acquired");
      if (completionReservation.kind !== "acquired") throw new Error("expected completion lease");
      expect(
        await Effect.runPromise(
          Effect.scoped(
            completion.finalize({
              request: completionRequest,
              completion_request_sha256: "7".repeat(64),
              reservation: completionReservation.reservation,
              status: "verified",
              result_hash: "8".repeat(64),
              provider_result: {
                status: "verified",
                evidence_kind: "raw_provider_response_v1",
                provider_evidence_ref: "provider-community-import-evidence",
                raw_response_bytes: new TextEncoder().encode('{"secure":true}'),
                observation: { secure: true },
                observed_at: "2098-01-01T00:00:00.000Z",
                expires_at: expiresAt,
              },
              provider_response_sha256: "9".repeat(64),
              evidence_digest: "a".repeat(64),
              provider_identity_digest: "b".repeat(64),
            }),
          ),
        ),
      ).toEqual({ kind: "committed", status: "verified", result_hash: "8".repeat(64) });
      expect(
        (
          await admin.query(
            `SELECT intent.status,intent.revision,requirement.status AS requirement_status,
                    session.status AS ownership_status,community.canonical_route_binding_id
               FROM community_route_attachment_intents AS intent
               JOIN community_route_attachment_requirement_states AS requirement
                 ON requirement.attachment_intent_id=intent.attachment_intent_id
               JOIN community_route_attachment_namespace_sessions AS session
                 ON session.attachment_intent_id=intent.attachment_intent_id
               JOIN communities AS community ON community.community_id=intent.community_id
              WHERE intent.attachment_intent_id='community-import-attachment'`,
          )
        ).rows[0],
      ).toEqual({
        status: "commit_ready",
        revision: "2",
        requirement_status: "satisfied",
        ownership_status: "completed",
        canonical_route_binding_id: null,
      });

      // Failed provisioning can leave a zone without retaining a result.
      const failure = await admin.query(
        "SELECT * FROM finalize_hns_authority_provision_job_v1($1,$2,$3,$4,'failed',NULL,NULL,NULL,NULL,'authority_unavailable')",
        [
          claim.rows[0].provision_job_id,
          "provisional-executor",
          claim.rows[0].lease_fence,
          claim.rows[0].request_sha256,
        ],
      );
      expect(failure.rows[0].outcome).toBe("failed");
      const held = async () =>
        (
          await admin.query("SELECT hns_community_root_import_reservation_held_v1($1) AS held", [
            "community-import-session",
          ])
        ).rows[0].held;
      expect(await held()).toBe(true);
      expect(
        (
          await admin.query(
            "SELECT * FROM claim_hns_root_import_observation_job_v1('cleanup-executor',60)",
          )
        ).rows,
      ).toHaveLength(0);
      // Age job timestamps across the bounded in-flight request drain window.
      await admin.query(`UPDATE hns_authority_provision_jobs
        SET created_at=clock_timestamp()-interval '4 minutes',updated_at=clock_timestamp()-interval '3 minutes'
        WHERE provision_job_id='community-import-provision'`);
      const cleanup = (
        await admin.query(
          "SELECT * FROM claim_hns_root_import_observation_job_v1('cleanup-executor',60)",
        )
      ).rows[0];
      expect(cleanup).toMatchObject({
        operation_kind: "teardown_provisional_root_v1",
        provision_result_bytes: null,
        publish_plan_bytes: null,
      });
      expect(await held()).toBe(true);
      const finalizeCleanup = (fence: string, outcome: string, code: string) =>
        admin.query(
          "SELECT * FROM finalize_hns_root_import_observation_job_v1($1,'cleanup-executor',$2,$3,$4,NULL,NULL,$5)",
          [cleanup.observation_job_id, fence, cleanup.request_sha256, outcome, code],
        );
      expect(
        (await finalizeCleanup(cleanup.lease_fence, "retry", "zone_teardown_unavailable")).rows[0]
          .outcome,
      ).toBe("retry");
      expect(await held()).toBe(true);
      const reclaimed = (
        await admin.query(
          "SELECT * FROM claim_hns_root_import_observation_job_v1('cleanup-executor',60)",
        )
      ).rows[0];
      expect(
        (await finalizeCleanup(cleanup.lease_fence, "failed", "session_expired")).rows[0].outcome,
      ).toBe("lost");
      expect(await held()).toBe(true);
      expect(
        (await finalizeCleanup(reclaimed.lease_fence, "failed", "session_expired")).rows[0].outcome,
      ).toBe("failed");
      expect(await held()).toBe(false);
      expect(
        (
          await admin.query(
            "SELECT lock_hns_root_zone_mutation_v1('dankmemes','pirate-verification=community-import',true,'stale-job','cleanup-executor',1) AS admitted",
          )
        ).rows,
      ).toEqual([{ admitted: false }]);

      expect(
        (await finalizeCleanup(reclaimed.lease_fence, "failed", "session_expired")).rows[0].outcome,
      ).toBe("replayed");

      await admin.query(
        "UPDATE community_route_authority_grants SET status='revoked',revoked_at=clock_timestamp(),revoked_by_user_id=principal_user_id WHERE grant_id='community-root-import-grant'",
      );
      expect(await current()).toBeNull();
    });
  });
  test("serializes quota races, preserves replay, and retains abandoned admissions", async () => {
    await withSchema(async (connection, admin) => {
      const layer = makeDirectPostgresControlPlaneLayer(connection);
      const store = makeControlPlaneHnsCommunityRootImportRepository({
        environment: "test",
        provider_binding: binding,
      });
      let next = 0;
      async function request(actor: string, root?: string) {
        const n = ++next;
        const community = `community_${randomUUID()}`;
        await admin.query(
          "INSERT INTO users (user_id,status,account) VALUES ($1,'active','{}') ON CONFLICT DO NOTHING",
          [actor],
        );
        await admin.query(
          `INSERT INTO communities (community_id,display_name,status,created_by_user_id,
          canonical_route_binding_id,route_authority_version,route_slug,created_at,updated_at)
          VALUES ($1,'Provisional quota','active',$2,NULL,'optional_route_v2',NULL,clock_timestamp(),clock_timestamp())`,
          [community, actor],
        );
        await admin.query(
          `INSERT INTO community_route_authority_grants
          (grant_id,community_id,principal_user_id,authority,source_kind,status,granted_by_user_id,granted_at)
          VALUES ($1,$2,$3,'manage_routes','creator_owner','active',$3,clock_timestamp())`,
          [`grant-${n}`, community, actor],
        );
        return {
          request: {
            actor_id: actor,
            community_id: community,
            root_label: root ?? `quota${n}`,
            idempotency_key: `start-${n}`,
          },
          attachment_intent_id: `attachment-${n}`,
          ceremony_intent_id: `ceremony-${n}`,
          root_import_session_id: `import-${n}`,
          provision_job_id: `provision-${n}`,
          request_sha256: n.toString(16).padStart(64, "0"),
        };
      }
      const prepare = (input: Awaited<ReturnType<typeof request>>) =>
        Effect.runPromise(Effect.scoped(store.prepare(input).pipe(Effect.provide(layer))));
      const first = await request("rate-actor");
      expect((await prepare(first)).kind).toBe("created");
      expect((await prepare(first)).kind).toBe("replay");
      const sameCommunity = {
        ...first,
        request: { ...first.request, idempotency_key: "different", root_label: "differentroot" },
        attachment_intent_id: "different-attachment",
      };
      expect(await prepare(sameCommunity)).toEqual({ kind: "conflict" });
      expect((await prepare(await request("rate-actor"))).kind).toBe("created");
      const third = await request("rate-actor");
      const fourth = await request("rate-actor");
      const raced = await Promise.all([prepare(third), prepare(fourth)]);
      expect(raced.map((x) => x.kind).sort()).toEqual(["conflict", "created"]);
      expect((await prepare(first)).kind).toBe("replay");
      const rootA = await request("root-actor-a", "rootrace");
      const rootB = await request("root-actor-b", "rootrace");
      expect(
        (await Promise.all([prepare(rootA), prepare(rootB)])).map((x) => x.kind).sort(),
      ).toEqual(["conflict", "created"]);
      // Four held reservations now; fill the deployment ceiling with distinct actors.
      for (let n = 0; n < 28; n++)
        expect((await prepare(await request(`global-${n}`))).kind).toBe("created");
      const overflow = await request("global-overflow");
      expect(await prepare(overflow)).toEqual({ kind: "conflict" });
      expect(
        (
          await admin.query(
            "SELECT count(*)::integer AS count FROM hns_community_root_import_preparations WHERE admission_kind='community_provisional'",
          )
        ).rows,
      ).toEqual([{ count: 32 }]);
      // Time-controlled fixture: age one immutable preparation without creating
      // any provision job. No executor could have touched its zone.
      await admin.query(
        "ALTER TABLE hns_community_root_import_preparations DISABLE TRIGGER hns_community_root_import_preparations_change_guard",
      );
      try {
        await admin.query(
          `UPDATE hns_community_root_import_preparations
          SET created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour'
          WHERE root_import_session_id=$1`,
          [first.root_import_session_id],
        );
      } finally {
        await admin.query(
          "ALTER TABLE hns_community_root_import_preparations ENABLE TRIGGER hns_community_root_import_preparations_change_guard",
        );
      }
      expect(
        (
          await admin.query("SELECT hns_community_root_import_reservation_held_v1($1) AS held", [
            first.root_import_session_id,
          ])
        ).rows,
      ).toEqual([{ held: false }]);
      expect((await prepare(overflow)).kind).toBe("created");
      // Releasing infrastructure capacity does not refund the actor's daily admission.
      expect(await prepare(await request("rate-actor"))).toEqual({ kind: "conflict" });
    });
  });
});
