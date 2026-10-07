import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeHnsMemberPublicationRunner } from "./member-publication.ts";
import type { PowerDnsRootProvisionConfig } from "./powerdns.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (!url && process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1")
  throw new Error("Postgres test URL required");
const suite = url ? describe : describe.skip;
const config: PowerDnsRootProvisionConfig = {
  api_url: "http://unused.invalid",
  api_key: "test",
  server_id: "localhost",
  soa_content: "unused",
  axfr_tsig_key_name: "test",
  gateway_ipv4: "192.0.2.10",
  shared_tlsa_association: `3 1 1 ${"a".repeat(64)}`,
  gateway_deployment_reference: "test",
  gateway_certificate_spki_sha256: "a".repeat(64),
  ttl_seconds: 300,
};

async function withQueue(use: (admin: Client, connection: string) => Promise<void>) {
  if (!url) throw new Error("Postgres test URL required");
  const schema = `member_publication_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const connection = `${url}${url.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
  try {
    await applyPostgresTestBaselineConnection({ connectionString: connection });
    await admin.query(`SET search_path TO "${schema}"`);
    // Only FK/issuance-fixture guards are bypassed; the real publication trigger runs.
    // Ordinary issuance is separately exercised in handle-sales-repository.pg.test.ts.
    await admin.query(
      "ALTER TABLE handle_grants ENABLE ALWAYS TRIGGER hns_member_host_publication_enqueue",
    );
    await admin.query("SET session_replication_role=replica");
    await admin.query(`INSERT INTO handle_grants (
      grant_id,grant_generation,community_id,offering_id,offering_hash,claim_id,
      owner_account_id,owner_persona_id,sale_namespace_activation_id,sale_namespace_activation_generation,
      fulfillment_kind,family,namespace_root,handle_label,display_identifier,status,issued_at,updated_at
    ) VALUES ('member-grant',1,'community-test','offering-test',repeat('a',64),'claim-test',
      'account-test','persona-test','sale-test',1,'hosted_persona_v1','hns','example','member',
      'member.example','active',clock_timestamp(),clock_timestamp())`);
    await admin.query("SET session_replication_role=origin");
    await use(admin, connection);
  } finally {
    await admin.query("ROLLBACK");
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}

suite("durable HNS member publication", () => {
  test("the migration backfills existing grants through the same durable queue", async () => {
    await withQueue(async (admin) => {
      await admin.query(`DROP TRIGGER hns_member_host_publication_enqueue ON handle_grants;
        DROP FUNCTION enqueue_hns_member_host_publication_v1();
        DROP FUNCTION prepare_hns_member_host_publication_v1();
        DROP FUNCTION hns_member_host_ready_v1(TEXT);
        DROP FUNCTION hns_member_host_authorized_v1(TEXT);
        DROP TABLE hns_member_host_publications`);
      await admin.query(
        await readFile(
          new URL(
            "../../../db/postgres/migrations/0244_hns_member_host_publication.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      expect(
        (await admin.query("SELECT grant_id,state FROM hns_member_host_publications")).rows,
      ).toEqual([{ grant_id: "member-grant", state: "preparing" }]);
      expect((await admin.query("SELECT status FROM handle_grants")).rows[0]?.status).toBe(
        "active",
      );
    });
  }, 30000);

  test("queues atomically, excludes duplicate executors and releases crashed work for retry", async () => {
    await withQueue(async (admin, connection) => {
      expect((await admin.query("SELECT state FROM hns_member_host_publications")).rows).toEqual([
        { state: "preparing" },
      ]);
      const first = new Client({ connectionString: connection });
      const second = new Client({ connectionString: connection });
      await first.connect();
      await second.connect();
      try {
        await first.query("BEGIN");
        const held = await first.query("SELECT prepare_hns_member_host_publication_v1() AS job");
        expect(held.rows[0]?.job.grant_id).toBe("member-grant");
        expect(held.rows[0]?.job.authorized).toBe(false);
        expect(
          (await second.query("SELECT prepare_hns_member_host_publication_v1() AS job")).rows[0]
            ?.job,
        ).toBeNull();
        await first.query("ROLLBACK");
        expect(
          (await second.query("SELECT prepare_hns_member_host_publication_v1() AS job")).rows[0]
            ?.job.grant_id,
        ).toBe("member-grant");
        await admin.query("BEGIN");
        await admin.query("SET LOCAL session_replication_role=replica");
        await admin.query(
          "UPDATE handle_grants SET status='revoked' WHERE grant_id='member-grant'",
        );
        await admin.query("ROLLBACK");
        expect((await admin.query("SELECT status FROM handle_grants")).rows[0]?.status).toBe(
          "active",
        );
      } finally {
        await first.end();
        await second.end();
      }
    });
  }, 30000);

  test("missing authority schedules an automatic retry and preserves the grant", async () => {
    await withQueue(async (admin, connection) => {
      const run = makeHnsMemberPublicationRunner(connection, config, null);
      expect(await run()).toEqual({ claimed: true, outcome: "preparing" });
      const row = (
        await admin.query(`SELECT state,attempts,due_at>clock_timestamp() AS later,
        safe_reason FROM hns_member_host_publications`)
      ).rows[0];
      expect(row).toEqual({
        state: "preparing",
        attempts: 1,
        later: true,
        safe_reason: "authority_unavailable",
      });
      expect(await run()).toEqual({ claimed: false, outcome: "idle" });
      expect((await admin.query("SELECT status FROM handle_grants")).rows[0]?.status).toBe(
        "active",
      );
      expect(
        (await admin.query("SELECT hns_member_host_ready_v1('member-grant') AS ready")).rows[0]
          ?.ready,
      ).toBe(false);
    });
  }, 30000);
});
