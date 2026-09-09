import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { makeControlPlaneHnsCommunityRootImportRepository } from "./hns-community-root-import-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString ? describe : describe.skip;
const signature = "hns_community_root_import_consumes_actor_budget_v1(text)";
const binding = {
  requirement: "namespace_ownership" as const,
  family: "hns" as const,
  provider_id: "hns.owner.v1",
  provider_configuration: { kind: "managed" as const, reference: "hns-owner-test", version: "1" },
  protocol_version: "hns-txt-v1",
};

suite("HNS admission runtime execution privileges", () => {
  test("an explicit helper grant repairs preparation without admitting a reader", async () => {
    if (!connectionString) throw new Error("Postgres test URL missing");
    const suffix = randomUUID().replaceAll("-", "");
    const schema = `hns_admission_${suffix}`;
    const runtimeRole = `hns_runtime_${suffix}`;
    const readerRole = `hns_reader_${suffix}`;
    const admin = new Client({ connectionString });
    await admin.connect();
    try {
      await admin.query("BEGIN");
      await admin.query(`CREATE SCHEMA ${schema}`);
      await admin.query(`SET search_path TO ${schema}, pg_temp`);
      // The structural baseline strips ACLs. Apply the real forward ledger.
      for (const migration of await loadPostgresMigrations()) await admin.query(migration.sql);
      await admin.query(`CREATE ROLE ${runtimeRole} NOLOGIN`);
      await admin.query(`CREATE ROLE ${readerRole} NOLOGIN`);
      await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRole}, ${readerRole}`);
      await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${readerRole}`);
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${runtimeRole}`,
      );
      await admin.query(
        `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${runtimeRole}`,
      );
      await admin.query("COMMIT");

      const scoped = (role?: string) => {
        const url = new URL(connectionString);
        url.searchParams.set(
          "options",
          `-c search_path=${schema},pg_temp${role ? ` -c role=${role}` : ""}`,
        );
        return url.toString();
      };
      const store = makeControlPlaneHnsCommunityRootImportRepository({
        environment: "test",
        provider_binding: binding,
      });
      const actor = "hns-admission-actor";
      await admin.query("INSERT INTO users (user_id,status,account) VALUES ($1,'active','{}')", [
        actor,
      ]);
      const request = async (number: number) => {
        const community = `community_${randomUUID()}`;
        await admin.query(
          `INSERT INTO communities
          (community_id,display_name,status,created_by_user_id,canonical_route_binding_id,route_authority_version,created_at,updated_at)
          VALUES ($1,'Admission privilege test','active',$2,NULL,'optional_route_v2',clock_timestamp(),clock_timestamp())`,
          [community, actor],
        );
        await admin.query(
          `INSERT INTO community_route_authority_grants
          (grant_id,community_id,principal_user_id,authority,source_kind,status,granted_by_user_id,granted_at)
          VALUES ($1,$2,$3,'manage_routes','creator_owner','active',$3,clock_timestamp())`,
          [`grant-${number}`, community, actor],
        );
        return {
          request: {
            actor_id: actor,
            community_id: community,
            root_label: `aclroot${number}`,
            idempotency_key: `acl-start-${number}`,
          },
          attachment_intent_id: `acl-attachment-${number}`,
          ceremony_intent_id: `acl-ceremony-${number}`,
          root_import_session_id: `acl-import-${number}`,
          provision_job_id: `acl-provision-${number}`,
          request_sha256: number.toString(16).padStart(64, "0"),
        };
      };
      const prepare = (input: Awaited<ReturnType<typeof request>>, role?: string) =>
        Effect.runPromise(
          Effect.scoped(
            store
              .prepare(input)
              .pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(scoped(role)))),
          ),
        );
      // The actor already has a preparation: admission must evaluate its budget helper.
      expect((await prepare(await request(1))).kind).toBe("created");
      const next = await request(2);
      await expect(prepare(next, runtimeRole)).rejects.toMatchObject({
        _tag: "ControlPlaneStatementFailed",
        label: "hns.community-root-import.admit",
        sqlState: "42501",
      });
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM hns_community_root_import_preparations WHERE community_id=$1",
            [next.request.community_id],
          )
        ).rows,
      ).toEqual([{ count: 0 }]);

      await admin.query(`GRANT EXECUTE ON FUNCTION ${schema}.${signature} TO ${runtimeRole}`);
      expect((await prepare(next, runtimeRole)).kind).toBe("created");
      expect((await prepare(next, runtimeRole)).kind).toBe("replay");
      // Reapplication is safe and does not grant to PUBLIC or the monitor role.
      await admin.query(`GRANT EXECUTE ON FUNCTION ${schema}.${signature} TO ${runtimeRole}`);
      expect(
        (
          await admin.query(
            `SELECT has_function_privilege($1,$3,'EXECUTE') AS runtime,
        has_function_privilege($2,$3,'EXECUTE') AS reader`,
            [runtimeRole, readerRole, `${schema}.${signature}`],
          )
        ).rows,
      ).toEqual([{ runtime: true, reader: false }]);
      const reader = new Client({ connectionString: scoped(readerRole) });
      await reader.connect();
      try {
        await expect(
          reader.query(
            `SELECT ${schema}.hns_community_root_import_consumes_actor_budget_v1(NULL::text)`,
          ),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await reader.end();
      }
    } finally {
      await admin.query("ROLLBACK");
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS ${runtimeRole}`);
      await admin.query(`DROP ROLE IF EXISTS ${readerRole}`);
      await admin.end();
    }
  }, 120_000);
});
