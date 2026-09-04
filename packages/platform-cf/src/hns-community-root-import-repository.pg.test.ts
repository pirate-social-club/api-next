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
          status: "awaiting_ownership",
          root_label: "dankmemes",
        },
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

      const secondCommunityId = "community_123e4567-e89b-42d3-a456-426614174001";
      await admin.query(
        `INSERT INTO communities (community_id,display_name,status,created_by_user_id,
           canonical_route_binding_id,route_authority_version,route_slug,created_at,updated_at)
         VALUES ($1,'Second root import','active',$2,NULL,'optional_route_v2',NULL,
           clock_timestamp(),clock_timestamp())`,
        [secondCommunityId, actorId],
      );
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
      ).toMatchObject({ kind: "created", value: { root_label: "dankmemes" } });
    });
  });
});
