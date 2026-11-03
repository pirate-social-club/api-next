import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { startHnsOwnerRecovery } from "@pirate/application/route-revalidation";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeControlPlaneCommunityRouteExpiryStore } from "./community-route-expiry-repository.ts";
import {
  makeControlPlaneHnsOwnerRecoveryAuthorityResolver,
  makeControlPlaneHnsOwnerRecoveryStartStore,
} from "./hns-owner-recovery-start-repository.ts";
import { seedOwnership, seedSatisfiedOwnership } from "./hns-root-ownership.pg-fixture.ts";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresClientFactory,
  type PostgresClientLike,
} from "./postgres.ts";

const connection = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connection === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
}
const suite = connection === undefined ? describe.skip : describe;
type QueryFailure = { code: unknown; message: unknown; where: unknown };

/** The actual driver still executes every statement under the constrained login.
 * This supplied driver port only retains sanitized fixture failure attribution. */
function observedClients(failures: QueryFailure[]): PostgresClientFactory {
  return (options) => {
    const client = new Client(options) as unknown as PostgresClientLike;
    return {
      get connection() {
        return client.connection as NonNullable<PostgresClientLike["connection"]>;
      },
      connect: () => client.connect(),
      query: async (statement) => {
        try {
          return await client.query(statement);
        } catch (error) {
          const e = error as QueryFailure;
          failures.push({ code: e.code, message: e.message, where: e.where });
          throw error;
        }
      },
      end: () => client.end(),
    };
  };
}

suite("HNS owner recovery runtime-role reservation", () => {
  test("recovers after real expiry without UPDATE on its immutable transition", async () => {
    if (connection === undefined) throw new Error("Fixture database unavailable");
    const suffix = randomUUID().replaceAll("-", "");
    const schema = `hns_owner_lock_${suffix}`,
      role = `hns_owner_runtime_${suffix}`;
    const runtimePassword = `fixture-${suffix}`;
    const admin = new Client({ connectionString: connection });
    await admin.connect();
    let roleCreated = false;
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const scoped = new URL(connection);
      scoped.searchParams.set("options", `-c search_path=${schema}`);
      await applyPostgresTestBaselineConnection({ connectionString: scoped.toString() });
      await admin.query(`SET search_path TO "${schema}"`);
      // Existing valid creation/ownership history, not disabled guards or a
      // fabricated expired route. The database expiry writer creates gen2.
      await seedOwnership(admin, true);
      await seedSatisfiedOwnership(admin);
      await admin.query("BEGIN");
      await admin.query(`INSERT INTO communities (
        community_id,display_name,status,created_by_user_id,canonical_route_binding_id,
        route_authority_version,created_at,updated_at,route_slug
      ) VALUES ('community-root-import','Runtime recovery fixture','active',
        'actor-root-import','binding-root-import','route_v1',clock_timestamp(),clock_timestamp(),NULL)`);
      await admin.query(`INSERT INTO community_canonical_route_bindings (
        route_binding_id,community_id,family,root_label,root_label_display,
        ownership_status,route_lifecycle_status,binding_generation,verified_evidence_ref
      ) VALUES ('binding-root-import','community-root-import','hns','newroot','newroot',
        'verified','active',1,'evidence-root-import')`);
      await admin.query("COMMIT");
      await admin.query(
        `CREATE ROLE "${role}" LOGIN PASSWORD '${runtimePassword}'
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
      );
      roleCreated = true;
      await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
      await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
      // Match the saved actual start-path boundary. No proof-table UPDATE grant.
      await admin.query(`GRANT INSERT,UPDATE ON communities,community_canonical_route_bindings,
        community_route_revalidation_start_reservations,community_route_revalidation_sessions TO "${role}"`);
      await admin.query(`GRANT INSERT ON community_route_lifecycle_transitions TO "${role}"`);
      const runtimeUrl = new URL(scoped);
      runtimeUrl.username = role;
      runtimeUrl.password = runtimePassword;
      const identity = new Client({ connectionString: runtimeUrl.toString() });
      try {
        await identity.connect();
        expect((await identity.query("SELECT current_user AS role")).rows[0]?.role).toBe(role);
      } finally {
        await identity.end();
      }
      const failures: QueryFailure[] = [];
      const runtime = makeDirectPostgresControlPlaneLayer(runtimeUrl.toString(), {
        clientFactory: observedClients(failures),
      });
      const facts = async () =>
        (
          await admin.query(
            `SELECT
        has_table_privilege($1,'community_route_lifecycle_transitions','SELECT') AS read,
        has_table_privilege($1,'community_route_lifecycle_transitions','INSERT') AS insert,
        has_table_privilege($1,'community_route_lifecycle_transitions','UPDATE') AS update,
        has_table_privilege($1,'community_route_lifecycle_transitions','DELETE') AS delete`,
            [role],
          )
        ).rows[0];
      expect(await facts()).toEqual({ read: true, insert: true, update: false, delete: false });
      const remaining = (
        await admin.query(`SELECT ceil(extract(epoch FROM
        expires_at-clock_timestamp())*1000)::int AS ms FROM community_route_ownership_evidence
        WHERE evidence_ref='evidence-root-import'`)
      ).rows[0]?.ms;
      if (!Number.isSafeInteger(remaining) || remaining <= 0 || remaining > 15000) {
        throw new Error("Fixture did not reach real expiry before its bound");
      }
      await Bun.sleep(remaining + 50);
      expect(
        await Effect.runPromise(
          makeControlPlaneCommunityRouteExpiryStore(runtime).expire({
            family: "hns",
            limit: 1,
            principal_id: "runtime-expiry-fixture",
          }),
        ),
      ).toEqual({ selected: 1, transitioned: 1, stale: 0 });
      const input = {
        actor_id: "actor-root-import",
        community_id: "community-root-import",
        expected_generation: 2,
        idempotency_key: "runtime-owner-recovery",
      } as const;
      const authority = makeControlPlaneHnsOwnerRecoveryAuthorityResolver(runtime);
      const store = makeControlPlaneHnsOwnerRecoveryStartStore(runtime);
      const resolved = await Effect.runPromise(authority.resolve(input));
      expect(resolved).toMatchObject({
        expected_binding_generation: 2,
        recovery_authority_kind: "database_time_expiry_transition",
      });
      if (resolved === null) throw new Error("Real expiry authority unavailable");
      let providerCalls = 0;
      const services = {
        authority,
        store,
        provider: {
          start: (request: { challenge_expires_at: string }) => {
            providerCalls++;
            return Effect.succeed({
              upstream_session_ref: "runtime-owner-upstream",
              expires_at: request.challenge_expires_at,
              presentation: {
                kind: "embedded_sdk" as const,
                session_id: "runtime-owner-upstream",
                protocol: "hns-txt-challenge" as const,
                version: "1" as const,
                payload: {
                  ownership_source: "hns_parent_chain_txt" as const,
                  challenge_name: "newroot",
                  challenge_value: "pirate-verification=runtime-owner-upstream",
                  expires_at: request.challenge_expires_at,
                },
              },
            });
          },
        },
      };
      expect(
        await Effect.runPromise(
          startHnsOwnerRecovery({ ...input, actor_id: "other-actor" }, services).pipe(Effect.flip),
        ),
      ).toMatchObject({ reason: "not_found" });
      expect(
        await Effect.runPromise(
          startHnsOwnerRecovery({ ...input, expected_generation: 1 }, services).pipe(Effect.flip),
        ),
      ).toMatchObject({ reason: "not_found" });
      const reserveInput = {
        request: input,
        expected_authority: resolved,
        requirement_hash: "a".repeat(64),
        public_start_hash: "b".repeat(64),
        reservation_id: "fixture-reservation",
        route_recovery_id: "fixture-recovery",
        session_id: "fixture-session",
        lease_ms: 8000,
      };
      expect(
        await Effect.runPromise(
          store.reserve({
            ...reserveInput,
            expected_authority: {
              ...resolved,
              recovery_authority_reference: "wrong-transition",
            },
          }),
        ),
      ).toEqual({ kind: "conflict" });
      expect(providerCalls).toBe(0);
      let started: unknown;
      try {
        started = await Effect.runPromise(startHnsOwnerRecovery(input, services));
      } catch (error) {
        // Baseline red must identify this exact native guard/permission failure,
        // rather than counting a fixture or connection failure as reproduction.
        console.error("HNS_RECOVERY_RUNTIME_QUERY_FAILURE", JSON.stringify(failures));
        const durable = (
          await admin.query(`SELECT
          (SELECT count(*)::int FROM community_route_revalidation_start_reservations) AS reservations,
          (SELECT count(*)::int FROM community_route_revalidation_sessions) AS sessions`)
        ).rows[0];
        console.error(
          "HNS_RECOVERY_RUNTIME_RED_BOUNDARY",
          JSON.stringify({ provider_calls: providerCalls, durable }),
        );
        throw error;
      }
      expect(started).toMatchObject({ status: "pending", generation: 2, replayed: false });
      expect(providerCalls).toBe(1);
      expect(await Effect.runPromise(startHnsOwnerRecovery(input, services))).toMatchObject({
        replayed: true,
      });
      expect(providerCalls).toBe(1);
      expect(await facts()).toEqual({ read: true, insert: true, update: false, delete: false });
      const before = (await admin.query("SELECT * FROM community_route_lifecycle_transitions"))
        .rows;
      await expect(
        admin.query("UPDATE community_route_lifecycle_transitions SET principal_id=principal_id"),
      ).rejects.toThrow("append-only");
      await expect(
        admin.query("DELETE FROM community_route_lifecycle_transitions"),
      ).rejects.toThrow("append-only");
      expect(
        (await admin.query("SELECT * FROM community_route_lifecycle_transitions")).rows,
      ).toEqual(before);
      // A separate actual runtime connection must still wait for mutable owner
      // authority; removing an immutable-proof lock must not remove these locks.
      const blockedUrl = new URL(runtimeUrl);
      blockedUrl.searchParams.set("options", `-c search_path=${schema} -c lock_timeout=150ms`);
      const blockedFailures: QueryFailure[] = [];
      const blockedStore = makeControlPlaneHnsOwnerRecoveryStartStore(
        makeDirectPostgresControlPlaneLayer(blockedUrl.toString(), {
          clientFactory: observedClients(blockedFailures),
        }),
      );
      await admin.query("BEGIN");
      try {
        await admin.query(
          "SELECT 1 FROM communities WHERE community_id='community-root-import' FOR UPDATE",
        );
        await expect(Effect.runPromise(blockedStore.reserve(reserveInput))).rejects.toBeDefined();
        expect(blockedFailures.some((error) => error.code === "55P03")).toBe(true);
      } finally {
        await admin.query("ROLLBACK");
      }
    } finally {
      await admin.query("ROLLBACK").catch(() => undefined);
      if (roleCreated) await admin.query(`DROP OWNED BY "${role}"`);
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      if (roleCreated) await admin.query(`DROP ROLE "${role}"`);
      await admin.end();
    }
  }, 120000);
});
