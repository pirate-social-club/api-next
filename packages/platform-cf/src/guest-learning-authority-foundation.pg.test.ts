import { describe, expect, test } from "bun:test";
import { Client } from "pg";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = url ? describe : describe.skip;
const origin = "https://community.example";
const owner = (n: number) => `owner_00000000-0000-0000-0000-${n.toString().padStart(12, "0")}`;
const credential = (n: number) => `${String.fromCharCode(65 + n).repeat(21)}A`;
const hash = "a".repeat(64);

async function fixture(use: (admin: Client, runtime: Client) => Promise<void>) {
  if (!url) throw new Error("test URL missing");
  const suffix = `${process.pid}_${crypto.randomUUID().replaceAll("-", "")}`;
  const schema = `guest_core_${suffix}`;
  const role = `guest_runtime_${suffix}`;
  const admin = new Client({ connectionString: url });
  const runtime = new Client({ connectionString: url });
  await Promise.all([admin.connect(), runtime.connect()]);
  try {
    await admin.query(`CREATE ROLE "${role}"; CREATE SCHEMA "${schema}"; SET search_path TO "${schema}";
      ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT ALL ON TABLES TO "${role}";
      ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT EXECUTE ON FUNCTIONS TO "${role}";
      CREATE TABLE users(user_id TEXT PRIMARY KEY);
      CREATE TABLE communities(community_id TEXT PRIMARY KEY,status TEXT NOT NULL);
      CREATE TABLE posts(community_id TEXT,post_id TEXT,post_type TEXT,status TEXT,visibility TEXT,content_rating TEXT);
      GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
    await admin.query(
      await Bun.file(
        new URL(
          "../../../db/postgres/migrations/0248_guest_learning_authority_foundation.sql",
          import.meta.url,
        ),
      ).text(),
    );
    await runtime.query(`SET search_path TO "${schema}"; SET ROLE "${role}"`);
    await admin.query("INSERT INTO users VALUES('account-a'),('account-b')");
    await admin.query(
      `INSERT INTO participation_owners(owner_id,kind,account_id,state,created_at)
        VALUES($1,'account','account-a','established','2026-01-01T00:00:00Z'),($2,'account','account-b','empty','2026-01-01T00:00:00Z')`,
      [owner(1), owner(2)],
    );
    await admin.query(
      `INSERT INTO participation_owners(owner_id,kind,guest_origin,state,created_at)
      VALUES($1,'guest',$3,'empty','2026-01-01T00:00:00Z'),($2,'guest',$3,'empty','2026-01-02T00:00:00Z')`,
      [owner(3), owner(4), origin],
    );
    await use(admin, runtime);
  } finally {
    await admin.query("ROLLBACK").catch(() => undefined);
    await runtime.query("ROLLBACK").catch(() => undefined);
    await runtime.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE;
      DROP OWNED BY "${role}"; DROP ROLE IF EXISTS "${role}"`);
    await admin.end();
  }
}

async function issue(admin: Client, source: string, id: string) {
  await admin.query(
    `WITH instant AS (SELECT clock_timestamp() AS at)
    INSERT INTO guest_credentials(credential_id,owner_id,origin,secret_digest,state,created_at,pending_expires_at)
    SELECT $1,$2,$3,$4,'pending_bootstrap',at,at+INTERVAL '15 minutes' FROM instant`,
    [id, source, origin, hash],
  );
}

suite("guest learning authority foundation", () => {
  test("inherited raw runtime grants and public/private routine execution are removed", async () => {
    await fixture(async (_admin, runtime) => {
      for (const table of [
        "participation_owners",
        "guest_credentials",
        "guest_empty_owner_aliases",
        "participation_owner_clocks",
        "guest_learning_preferences",
        "guest_participation_operations",
        "guest_secret_issuance_operations",
        "guest_attachment_intents",
      ]) {
        await expect(runtime.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({
          code: "42501",
        });
        await expect(runtime.query(`DELETE FROM ${table}`)).rejects.toMatchObject({
          code: "42501",
        });
      }
      await expect(
        runtime.query("SELECT read_guest_credential_proof_matches_v1($1,'[]',FALSE)", [origin]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        runtime.query("SELECT resolve_guest_empty_owner_root_v1($1)", [owner(3)]),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });

  test("pending receipt, confirmation and immutable proof enforce separate clock fields", async () => {
    await fixture(async (admin) => {
      const id = credential(0);
      await issue(admin, owner(3), id);
      await expect(
        admin.query(`UPDATE guest_credentials SET secret_digest=$2 WHERE credential_id=$1`, [
          id,
          "b".repeat(64),
        ]),
      ).rejects.toThrow("credential identity is immutable");
      await expect(
        admin.query(
          `UPDATE guest_credentials SET state='confirmed',confirmed_at=clock_timestamp(),session_until=clock_timestamp()+INTERVAL '2 hours' WHERE credential_id=$1`,
          [id],
        ),
      ).rejects.toThrow("invalid pending confirmation");
      await admin.query(
        `WITH instant AS (SELECT clock_timestamp() AS at)
        UPDATE guest_credentials SET state='confirmed',confirmed_at=at,session_until=at+INTERVAL '1 hour'
        FROM instant WHERE credential_id=$1`,
        [id],
      );
      const matched = await admin.query(
        `SELECT credential_state FROM read_guest_credential_proof_matches_v1($1,$2,FALSE)`,
        [origin, JSON.stringify([{ credentialId: id, digest: hash }])],
      );
      expect(matched.rows).toEqual([{ credential_state: "confirmed" }]);
      expect(
        (
          await admin.query(`SELECT * FROM read_guest_credential_proof_matches_v1($1,$2,FALSE)`, [
            "https://name.example",
            JSON.stringify([{ credentialId: id, digest: hash }]),
          ])
        ).rows,
      ).toEqual([]);
      await admin.query("BEGIN");
      await admin.query(
        `WITH instant AS (SELECT clock_timestamp() AS at)
        INSERT INTO guest_credentials(credential_id,owner_id,origin,secret_digest,state,created_at,pending_expires_at,predecessor_id)
        SELECT $1,$2,$3,$4,'pending_successor',at,at+INTERVAL '15 minutes',$5 FROM instant`,
        [credential(2), owner(3), origin, hash, id],
      );
      await admin.query(
        `UPDATE guest_credentials SET state='revoked',revoked_at=clock_timestamp(),revocation_reason='rotation_acknowledged' WHERE credential_id=$1`,
        [id],
      );
      await admin.query(
        `WITH instant AS (SELECT clock_timestamp() AS at)
        UPDATE guest_credentials SET state='confirmed',confirmed_at=at,session_until=at+INTERVAL '1 hour'
        FROM instant WHERE credential_id=$1`,
        [credential(2)],
      );
      await admin.query("COMMIT");
      await expect(
        admin.query(
          `UPDATE guest_credentials SET state='confirmed',revoked_at=NULL,revocation_reason=NULL WHERE credential_id=$1`,
          [id],
        ),
      ).rejects.toThrow("credential revocation is final");
      await expect(
        admin.query(
          `WITH instant AS (SELECT clock_timestamp() AS at)
        INSERT INTO guest_credentials(credential_id,owner_id,origin,secret_digest,state,created_at,pending_expires_at,confirmed_at,session_until)
        SELECT $1,$2,$3,$4,'confirmed',at,at+INTERVAL '15 minutes',at,at+INTERVAL '9 hours' FROM instant`,
          [credential(1), owner(4), origin, hash],
        ),
      ).rejects.toThrow("live pending protocol");
    });
  });

  test("operation owner/kind/key identity cannot fork across resources or cross issuance lineage", async () => {
    await fixture(async (admin) => {
      await issue(admin, owner(3), credential(0));
      await issue(admin, owner(4), credential(1));
      await admin.query(
        `INSERT INTO guest_participation_operations
        (operation_id,source_owner_id,operation_kind,resource_scope,idempotency_key,request_hash,state,created_at)
        VALUES('original',$1,'bootstrap_issue',$2,'original-key',$3,'reserved',clock_timestamp()),
          ('start',$1,'study_start','post-a','start-key',$3,'reserved',clock_timestamp())`,
        [owner(3), origin, hash],
      );
      await expect(
        admin.query(
          `INSERT INTO guest_participation_operations
        (operation_id,source_owner_id,operation_kind,resource_scope,idempotency_key,request_hash,state,created_at)
        VALUES('fork',$1,'study_start','post-b','start-key',$2,'reserved',clock_timestamp())`,
          [owner(3), hash],
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        admin.query(
          `INSERT INTO guest_secret_issuance_operations
        (origin,issuance_kind,resource_scope,idempotency_key,request_hash,source_owner_id,credential_source_owner_id,credential_id,operation_id,created_at)
        VALUES($1,'bootstrap',$1,'original-key',$2,$3,$4,$5,'original',clock_timestamp())`,
          [origin, hash, owner(3), owner(4), credential(1)],
        ),
      ).rejects.toThrow("issuance credential source mismatch");
    });
  });

  test("intent identity is immutable and target revision advances only for deliberate session changes", async () => {
    await fixture(async (admin) => {
      const id = credential(0);
      const intent = `gai_${credential(2)}`;
      await issue(admin, owner(3), id);
      await admin.query(
        `WITH instant AS (SELECT clock_timestamp() AS at)
        UPDATE guest_credentials SET state='confirmed',confirmed_at=at,session_until=at+INTERVAL '1 hour'
        FROM instant WHERE credential_id=$1`,
        [id],
      );
      await admin.query(
        `WITH instant AS (SELECT clock_timestamp() AS at)
        INSERT INTO guest_attachment_intents(intent_id,owner_id,credential_source_owner_id,credential_id,
          origin,nonce_digest,state,created_at,expires_at)
        SELECT $1,$2,$2,$3,$4,$5,'awaiting_account',at,at+INTERVAL '15 minutes' FROM instant`,
        [intent, owner(3), id, origin, hash],
      );
      await expect(
        admin.query("UPDATE guest_attachment_intents SET nonce_digest=$1", ["b".repeat(64)]),
      ).rejects.toThrow("ceremony proof identity is immutable");
      await admin.query(
        `INSERT INTO guest_participation_operations
        (operation_id,source_owner_id,operation_kind,resource_scope,idempotency_key,request_hash,state,created_at)
        VALUES('prepare-one',$1,'attachment_prepare',$2,'prepare-one',$3,'reserved',clock_timestamp()),
          ('prepare-two',$1,'attachment_prepare',$2,'prepare-two',$3,'reserved',clock_timestamp())`,
        [owner(3), intent, hash],
      );
      await admin.query(
        `UPDATE guest_attachment_intents SET state='awaiting_confirmation',target_revision=1,
        target_account_id='account-a',target_session_digest=$1,prepared_operation_id='prepare-one'`,
        [hash],
      );
      await expect(
        admin.query("UPDATE guest_attachment_intents SET target_revision=0"),
      ).rejects.toThrow("invalid ceremony preparation");
      await expect(
        admin.query("UPDATE guest_attachment_intents SET target_account_id='account-b'"),
      ).rejects.toThrow("changed target requires next revision");
      await expect(
        admin.query(
          "UPDATE guest_attachment_intents SET target_revision=2,target_account_id='account-b'",
        ),
      ).rejects.toThrow("changed target requires next revision and operation");
      await admin.query(`UPDATE guest_attachment_intents SET target_revision=2,target_account_id='account-b',
        prepared_operation_id='prepare-two'`);
      await admin.query("UPDATE guest_attachment_intents SET state='superseded'");
      await expect(
        admin.query("UPDATE guest_attachment_intents SET state='awaiting_confirmation'"),
      ).rejects.toThrow("ceremony terminal state is final");
      await expect(admin.query("DELETE FROM guest_attachment_intents")).rejects.toThrow(
        "ceremony evidence is retained",
      );
    });
  });

  test("same-origin empty aliases require canonical order and atomic state closure", async () => {
    await fixture(async (admin) => {
      await expect(
        admin.query(
          `INSERT INTO guest_empty_owner_aliases(source_owner_id,canonical_owner_id,origin,created_at)
        VALUES($1,$2,$3,clock_timestamp())`,
          [owner(3), owner(4), origin],
        ),
      ).rejects.toThrow("only same-origin empty sources");
      await expect(
        admin.query(
          `INSERT INTO guest_empty_owner_aliases(source_owner_id,canonical_owner_id,origin,created_at)
        VALUES($1,$2,$3,clock_timestamp())`,
          [owner(4), owner(3), origin],
        ),
      ).rejects.toThrow("state and evidence disagree");
      await admin.query("BEGIN");
      await admin.query(
        `INSERT INTO guest_empty_owner_aliases(source_owner_id,canonical_owner_id,origin,created_at)
        VALUES($1,$2,$3,clock_timestamp())`,
        [owner(4), owner(3), origin],
      );
      await admin.query("UPDATE participation_owners SET state='aliased_empty' WHERE owner_id=$1", [
        owner(4),
      ]);
      await admin.query("COMMIT");
      expect(
        (await admin.query("SELECT resolve_guest_empty_owner_root_v1($1) AS owner", [owner(4)]))
          .rows,
      ).toEqual([{ owner: owner(3) }]);
      await expect(admin.query("DELETE FROM guest_empty_owner_aliases")).rejects.toThrow(
        "immutable",
      );
      await expect(
        admin.query("UPDATE participation_owners SET state='empty' WHERE owner_id=$1", [owner(1)]),
      ).rejects.toThrow("source identity is immutable");
    });
  });
  test("proof snapshot preserves original credential owner through empty alias convergence", async () => {
    await fixture(async (admin) => {
      await issue(admin, owner(4), credential(1));
      await admin.query("BEGIN");
      await admin.query(
        `INSERT INTO guest_empty_owner_aliases
      (source_owner_id,canonical_owner_id,origin,created_at) VALUES($1,$2,$3,clock_timestamp())`,
        [owner(4), owner(3), origin],
      );
      await admin.query("UPDATE participation_owners SET state='aliased_empty' WHERE owner_id=$1", [
        owner(4),
      ]);
      await admin.query("COMMIT");
      const result = await admin.query(
        `WITH result AS (
      SELECT read_guest_browser_proof_snapshot_v1($1,$2::jsonb,'[]',FALSE) AS snapshot)
      SELECT snapshot->'provedCredentials'->0->>'credentialSourceOwnerId' AS original,
        snapshot->'provedCredentials'->0->>'effectiveOwnerId' AS effective,
        snapshot->'provedCredentials'->0->>'ownerId' AS projected,
        snapshot->'provedCredentials'->0->>'state' AS state FROM result`,
        [origin, JSON.stringify([{ credentialId: credential(1), digest: hash }])],
      );
      expect(result.rows).toEqual([
        {
          original: owner(4),
          effective: owner(3),
          projected: owner(3),
          state: "pending_bootstrap",
        },
      ]);
      expect(
        (
          await admin.query("SELECT owner_id FROM guest_credentials WHERE credential_id=$1", [
            credential(1),
          ])
        ).rows,
      ).toEqual([{ owner_id: owner(4) }]);
    });
  });

  test("unknown digest and wrong origin return no authority; no digests enter projection", async () => {
    await fixture(async (admin) => {
      await issue(admin, owner(3), credential(0));
      for (const [productOrigin, digest] of [
        [origin, "b".repeat(64)],
        ["https://other.example", hash],
      ]) {
        const result = await admin.query(
          `SELECT
        read_guest_browser_proof_snapshot_v1($1,$2::jsonb,'[]',FALSE)->'provedCredentials' AS credentials`,
          [productOrigin, JSON.stringify([{ credentialId: credential(0), digest }])],
        );
        expect(result.rows).toEqual([{ credentials: [] }]);
      }
      const good = await admin.query(
        "SELECT read_guest_browser_proof_snapshot_v1($1,$2::jsonb,'[]',FALSE) AS snapshot",
        [origin, JSON.stringify([{ credentialId: credential(0), digest: hash }])],
      );
      const encoded = JSON.stringify(good.rows);
      expect(encoded).not.toContain(hash);
      expect(encoded).not.toContain("secret_digest");
      expect(encoded).not.toContain("nonce_digest");
    });
  });

  test("new readers remove inherited EXECUTE; raw tables remain denied after reader-only grant", async () => {
    await fixture(async (admin, runtime) => {
      await expect(
        runtime.query("SELECT read_guest_browser_proof_snapshot_v1($1,'[]','[]',FALSE)", [origin]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        runtime.query("SELECT read_guest_learning_lease_observation_v1($1,$2,$3)", [
          origin,
          credential(0),
          owner(3),
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      const roleResult = await runtime.query("SELECT current_user AS role");
      expect(roleResult.rows).toHaveLength(1);
      for (const signature of [
        "read_guest_browser_proof_snapshot_v1(text,jsonb,jsonb,boolean)",
        "read_guest_learning_lease_observation_v1(text,text,text)",
      ]) {
        // SQL formatter quotes the fixture-generated role; no application SQL grants.
        const grant = await admin.query(
          "SELECT format('GRANT EXECUTE ON FUNCTION %s TO %I',$1::text,$2::name) AS command",
          [signature, roleResult.rows[0].role],
        );
        await admin.query(grant.rows[0].command);
      }
      await expect(
        runtime.query(
          "SELECT read_guest_browser_proof_snapshot_v1($1,'[]','[]',FALSE) AS snapshot",
          [origin],
        ),
      ).resolves.toMatchObject({
        rows: [{ snapshot: { provedCredentials: [], provedIntents: [] } }],
      });
      for (const table of [
        "guest_credentials",
        "guest_empty_owner_aliases",
        "guest_attachment_intents",
      ])
        await expect(runtime.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({
          code: "42501",
        });
    });
  });

  test("intent nonce proof retains original credential lineage and resolved source owner", async () => {
    await fixture(async (admin) => {
      const id = credential(1);
      const intentId = `gai_${credential(2)}`;
      const nonceDigest = "b".repeat(64);
      await issue(admin, owner(4), id);
      await admin.query(
        `WITH instant AS (SELECT clock_timestamp() AS at)
      UPDATE guest_credentials SET state='confirmed',confirmed_at=at,session_until=at+INTERVAL '1 hour'
      FROM instant WHERE credential_id=$1`,
        [id],
      );
      await admin.query("BEGIN");
      await admin.query(
        `INSERT INTO guest_empty_owner_aliases(source_owner_id,canonical_owner_id,origin,created_at)
      VALUES($1,$2,$3,clock_timestamp())`,
        [owner(4), owner(3), origin],
      );
      await admin.query("UPDATE participation_owners SET state='aliased_empty' WHERE owner_id=$1", [
        owner(4),
      ]);
      await admin.query("COMMIT");
      await admin.query(
        `WITH instant AS (SELECT clock_timestamp() AS at)
      INSERT INTO guest_attachment_intents(intent_id,owner_id,credential_source_owner_id,credential_id,
        origin,nonce_digest,state,created_at,expires_at)
      SELECT $1,$2,$3,$4,$5,$6,'awaiting_account',at,at+INTERVAL '15 minutes' FROM instant`,
        [intentId, owner(3), owner(4), id, origin, nonceDigest],
      );
      const result = await admin.query(
        `WITH result AS (
      SELECT read_guest_browser_proof_snapshot_v1($1,$2::jsonb,$3::jsonb,FALSE) AS snapshot)
      SELECT snapshot->'provedIntents'->0->>'credentialSourceOwnerId' AS original,
        snapshot->'provedIntents'->0->>'effectiveOwnerId' AS effective,
        snapshot->'provedIntents'->0->>'ownerId' AS intent_owner,
        snapshot->'provedIntents'->0->>'credentialId' AS credential_id,
        snapshot->'provedIntents'->0->'active' AS active FROM result`,
        [
          origin,
          JSON.stringify([{ credentialId: id, digest: hash }]),
          JSON.stringify([{ intentId, digest: nonceDigest }]),
        ],
      );
      expect(result.rows).toEqual([
        {
          original: owner(4),
          effective: owner(3),
          intent_owner: owner(3),
          credential_id: id,
          active: true,
        },
      ]);
      const wrong = await admin.query(
        `SELECT read_guest_browser_proof_snapshot_v1($1,'[]',$2::jsonb,FALSE)
      ->'provedIntents' AS intents`,
        [origin, JSON.stringify([{ intentId, digest: hash }])],
      );
      expect(wrong.rows).toEqual([{ intents: [] }]);
    });
  });

  test("database lease observation is fresh and revocation cannot reuse a stale snapshot", async () => {
    await fixture(async (admin) => {
      await issue(admin, owner(3), credential(0));
      await admin.query(
        `WITH instant AS (SELECT clock_timestamp() AS at)
      UPDATE guest_credentials SET state='confirmed',confirmed_at=at,session_until=at+INTERVAL '1 hour'
      FROM instant WHERE credential_id=$1`,
        [credential(0)],
      );
      const live = await admin.query(
        `SELECT
      read_guest_learning_lease_observation_v1($1,$2,$3)->'active' AS active`,
        [origin, credential(0), owner(3)],
      );
      expect(live.rows).toEqual([{ active: true }]);
      await admin.query(
        `UPDATE guest_credentials SET state='revoked',revoked_at=clock_timestamp(),
      revocation_reason='rotation_acknowledged' WHERE credential_id=$1`,
        [credential(0)],
      );
      const after = await admin.query(
        "SELECT read_guest_learning_lease_observation_v1($1,$2,$3) AS observed",
        [origin, credential(0), owner(3)],
      );
      expect(after.rows).toEqual([{ observed: null }]);
      const metadata = await admin.query(
        `SELECT
      read_guest_browser_proof_snapshot_v1($1,$2::jsonb,'[]',TRUE)->'provedCredentials'->0->>'state' AS state`,
        [origin, JSON.stringify([{ credentialId: credential(0), digest: hash }])],
      );
      expect(metadata.rows).toEqual([{ state: "revoked" }]);
    });
  });
});
