// PRIVATE FOUNDATION FIXTURE PROPOSAL, never executed by the proposing agent.
// Intended placement: packages/platform-cf/src after root source adoption.
// Actual248+250+251 plus source-bound actual253; deliberately minimal parent rows.
// This is not genuine247/populated249, actual producer, RLS252, provider or R2 proof.
import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

const databaseUrl = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !databaseUrl)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = databaseUrl ? describe : describe.skip;
const origin = "https://community.example";
const owner = (n: number) => `owner_00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const requestHash = "a".repeat(64);
const audioTables = [
  "learner_audio_owner_fences",
  "learner_audio_delete_commands",
  "learner_audio_delete_sources",
  "learner_audio_delete_target_artifacts",
  "learner_audio_object_names",
  "learner_audio_upload_attempts",
  "learner_audio_delete_batches",
  "learner_audio_delete_batch_items",
  "learner_audio_deleted_objects",
] as const;
const fkTargets = [
  "participation_owners",
  "guest_credentials",
  "guest_empty_owner_aliases",
  "participation_owner_clocks",
  "guest_learning_preferences",
  "guest_participation_operations",
  "guest_secret_issuance_operations",
  "guest_attachment_intents",
  "guest_resource_session_reservations",
  "guest_resource_provider_calls",
  "guest_resource_release_receipts",
  ...audioTables,
] as const;
const audioFunctions = [
  "learner_audio_source_component_private_v1(text[])",
  "lock_learner_audio_sources_private_v1(text[])",
  "register_learner_audio_upload_private_v1(text,text,text,text,text,text,text,text,bigint)",
  "claim_learner_audio_upload_private_v1(text)",
  "settle_learner_audio_upload_private_v1(text,text,boolean,text)",
  "prepare_learner_audio_delete_private_v1(text,text,text,text,text[],text,integer,text)",
  "confirm_learner_audio_delete_private_v1(text,bigint,text,timestamp with time zone)",
  "fail_learner_audio_delete_private_v1(text,text)",
  "learner_audio_component_has_history_private_v1(text[])",
] as const;
type Fixture = {
  admin: Client;
  runtime: Client;
  schema: string;
  role: string;
  connectAdmin: () => Promise<Client>;
};
async function transaction(client: Client, work: () => Promise<void>) {
  await client.query("BEGIN");
  try {
    await work();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
async function fixture(use: (f: Fixture) => Promise<void>) {
  if (!databaseUrl) throw new Error("fixture URL missing");
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const schema = `audio_foundation_${suffix}`;
  const role = `audio_login_${suffix}`;
  const password = Array.from(randomBytes(32), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  ); // ephemeral synthetic; never printed
  const admin = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 3000,
    query_timeout: 5000,
  });
  const clients: Client[] = [];
  let roleCreated = false;
  await admin.connect();
  try {
    const roleSql = (
      await admin.query<{ command: string }>(
        "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD %L',$1::name,$2::text) AS command",
        [role, password],
      )
    ).rows[0]?.command;
    if (!roleSql) throw new Error("role command absent");
    await admin.query(roleSql);
    roleCreated = true;
    await admin.query(`CREATE SCHEMA ${quote(schema)}; SET search_path TO ${quote(schema)};
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${quote(schema)} GRANT ALL ON TABLES TO ${quote(role)};
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${quote(schema)} GRANT ALL ON SEQUENCES TO ${quote(role)};
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${quote(schema)} GRANT EXECUTE ON FUNCTIONS TO ${quote(role)};
      CREATE TABLE users(user_id TEXT PRIMARY KEY);
      CREATE TABLE communities(community_id TEXT PRIMARY KEY,status TEXT NOT NULL);
      CREATE TABLE posts(community_id TEXT,post_id TEXT,post_type TEXT,status TEXT,visibility TEXT,content_rating TEXT);
      GRANT USAGE ON SCHEMA ${quote(schema)} TO ${quote(role)}`);
    const migration = (name: string) =>
      readFile(`${process.cwd()}/db/postgres/migrations/${name}`, "utf8");
    await transaction(admin, async () => {
      await admin.query(await migration("0248_guest_learning_authority_foundation.sql"));
    });
    await admin.query(`CREATE TABLE study_sessions_v2(session_id TEXT PRIMARY KEY,
      participation_owner_id TEXT NOT NULL,participation_owner_kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',expires_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()+INTERVAL '24 hours',
      FOREIGN KEY(participation_owner_id,participation_owner_kind) REFERENCES participation_owners(owner_id,kind));
      CREATE TABLE study_review_items(fixture_id TEXT PRIMARY KEY,participation_owner_id TEXT NOT NULL REFERENCES participation_owners);
      CREATE TABLE study_session_items_v2(fixture_id TEXT PRIMARY KEY,participation_owner_id TEXT NOT NULL REFERENCES participation_owners);
      CREATE TABLE study_spoken_answer_commands(command_id TEXT PRIMARY KEY,participation_owner_id TEXT NOT NULL REFERENCES participation_owners,state TEXT NOT NULL);
      CREATE TABLE learner_audio_artifacts(learner_audio_artifact_id TEXT PRIMARY KEY,participation_owner_id TEXT NOT NULL REFERENCES participation_owners,
        account_id TEXT,source_kind TEXT NOT NULL,attempt_ref TEXT NOT NULL,expected_object_ref TEXT NOT NULL,object_ref TEXT,
        recording_state TEXT NOT NULL,deleted_at TIMESTAMPTZ);
      CREATE TABLE karaoke_recordings(session_id TEXT PRIMARY KEY,attempt_id TEXT UNIQUE NOT NULL,account_id TEXT NOT NULL REFERENCES users,
        artifact_id TEXT UNIQUE NOT NULL,state TEXT NOT NULL DEFAULT 'pending',object_ref TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),reconciled_at TIMESTAMPTZ);
      REVOKE ALL ON users,communities,posts,study_sessions_v2,study_review_items,study_session_items_v2,
        study_spoken_answer_commands,learner_audio_artifacts,karaoke_recordings FROM PUBLIC,${quote(role)};
      INSERT INTO users VALUES('legacy-karaoke-account')`);
    await admin.query(
      "INSERT INTO participation_owners(owner_id,kind,account_id,state) VALUES($1,'account','legacy-karaoke-account','established')",
      [owner(1)],
    );
    await admin.query(`INSERT INTO karaoke_recordings(session_id,attempt_id,account_id,artifact_id,state,created_at,reconciled_at)
      VALUES('legacy-pending','legacy-pending','legacy-karaoke-account','missing-pending','pending',clock_timestamp()-INTERVAL '2 days',NULL),
        ('legacy-failed','legacy-failed','legacy-karaoke-account','missing-failed','failed',clock_timestamp()-INTERVAL '2 days',clock_timestamp())`);
    await transaction(admin, async () => {
      await admin.query(await migration("0250_guest_browser_authority_transitions.sql"));
    });
    await transaction(admin, async () => {
      await admin.query(await migration("0251_guest_learning_resource_reservations.sql"));
    });
    // The owned snapshot's actual adopted migration is mandatory. No baseline,
    // proposal override or unpublished environment filename selects its source.
    const candidate = await migration("0253_learner_audio_deletion_fence.sql");
    const candidateHash = createHash("sha256").update(candidate).digest("hex");
    expect(candidateHash).toBe("27ce4e1c6e3185badb27e23bad96b84a3c9c5a226c7678d736d05072138f6cdb");
    await transaction(admin, async () => {
      await admin.query(candidate);
    });
    // Only explicitly reviewed fixture wrappers receive EXECUTE. Their caller
    // scope is the finite synthetic owner set; this is not browser authentication.
    const allowedOwners = [1, 10, 11, 20, 21, 30, 31, 32, 33, 34].map(owner);
    const scopeLiteral = allowedOwners.map((id) => `'${id}'`).join(",");
    await admin.query(`CREATE FUNCTION fixture_audio_scope_v1(source_id TEXT) RETURNS VOID
      LANGUAGE plpgsql SET search_path TO pg_catalog,${quote(schema)},pg_temp AS $$ BEGIN
      IF source_id IS NULL OR NOT source_id=ANY(ARRAY[${scopeLiteral}]) THEN
        RAISE EXCEPTION 'outside sealed fixture scope'; END IF; END $$;
      REVOKE ALL ON FUNCTION fixture_audio_scope_v1(text) FROM PUBLIC,${quote(role)};
      CREATE FUNCTION fixture_audio_upload_v1(source_id TEXT,artifact TEXT,kind TEXT,attempt TEXT,command TEXT,
        reservation TEXT,object_name TEXT,upload_id TEXT,revision BIGINT) RETURNS BIGINT
      LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,${quote(schema)},pg_temp AS $$ BEGIN
        PERFORM fixture_audio_scope_v1(source_id);
        IF kind<>'study' THEN RAISE EXCEPTION 'fixture Study upload only'; END IF;
        RETURN register_learner_audio_upload_private_v1(source_id,artifact,kind,attempt,command,reservation,object_name,upload_id,revision);
      END $$;
      CREATE FUNCTION fixture_audio_claim_v1(upload_id TEXT) RETURNS BOOLEAN
      LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,${quote(schema)},pg_temp AS $$ DECLARE source_id TEXT; BEGIN
        SELECT owner_id INTO STRICT source_id FROM learner_audio_upload_attempts WHERE upload_attempt_id=upload_id;
        PERFORM fixture_audio_scope_v1(source_id); RETURN claim_learner_audio_upload_private_v1(upload_id);
      END $$;
      CREATE FUNCTION fixture_audio_settle_v1(upload_id TEXT,disposition TEXT,no_more_io BOOLEAN,multipart_id TEXT) RETURNS BOOLEAN
      LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,${quote(schema)},pg_temp AS $$ DECLARE source_id TEXT; BEGIN
        SELECT owner_id INTO STRICT source_id FROM learner_audio_upload_attempts WHERE upload_attempt_id=upload_id;
        PERFORM fixture_audio_scope_v1(source_id); RETURN settle_learner_audio_upload_private_v1(upload_id,disposition,no_more_io,multipart_id);
      END $$;
      CREATE FUNCTION fixture_audio_prepare_v1(source_id TEXT,key TEXT,request_digest TEXT,command TEXT,
        seed_ids TEXT[],batch TEXT,maximum INTEGER,provider TEXT) RETURNS TEXT
      LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,${quote(schema)},pg_temp AS $$ BEGIN
        PERFORM fixture_audio_scope_v1(source_id);
        IF seed_ids IS DISTINCT FROM ARRAY[source_id] THEN RAISE EXCEPTION 'fixture seed scope differs'; END IF;
        RETURN prepare_learner_audio_delete_private_v1(source_id,key,request_digest,command,ARRAY[source_id],batch,maximum,provider);
      END $$;
      CREATE FUNCTION fixture_audio_confirm_v1(batch TEXT,revision BIGINT,fact TEXT,at_time TIMESTAMPTZ) RETURNS BOOLEAN
      LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,${quote(schema)},pg_temp AS $$ DECLARE source_id TEXT; BEGIN
        FOR source_id IN SELECT s.owner_id FROM learner_audio_delete_sources s JOIN learner_audio_delete_batches b USING(command_id)
          WHERE b.batch_id=batch LOOP PERFORM fixture_audio_scope_v1(source_id); END LOOP;
        RETURN confirm_learner_audio_delete_private_v1(batch,revision,fact,at_time);
      END $$;
      CREATE FUNCTION fixture_audio_lock_v1(source_ids TEXT[]) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,${quote(schema)},pg_temp AS $$ DECLARE source_id TEXT; BEGIN
        FOREACH source_id IN ARRAY source_ids LOOP PERFORM fixture_audio_scope_v1(source_id); END LOOP;
        PERFORM lock_learner_audio_sources_private_v1(source_ids);
      END $$;`);
    for (const signature of [
      "fixture_audio_upload_v1(text,text,text,text,text,text,text,text,bigint)",
      "fixture_audio_claim_v1(text)",
      "fixture_audio_settle_v1(text,text,boolean,text)",
      "fixture_audio_prepare_v1(text,text,text,text,text[],text,integer,text)",
      "fixture_audio_confirm_v1(text,bigint,text,timestamp with time zone)",
      "fixture_audio_lock_v1(text[])",
    ])
      await admin.query(
        `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC; GRANT EXECUTE ON FUNCTION ${signature} TO ${quote(role)}`,
      );
    const runtimeUrl = new URL(databaseUrl);
    runtimeUrl.username = role;
    runtimeUrl.password = password;
    const runtime = new Client({
      connectionString: runtimeUrl.toString(),
      connectionTimeoutMillis: 3000,
      query_timeout: 5000,
    });
    await runtime.connect();
    clients.push(runtime);
    await runtime.query(
      `SET search_path TO ${quote(schema)}; SET lock_timeout='250ms'; SET statement_timeout='3s'`,
    );
    expect(
      (await runtime.query("SELECT current_user AS current,session_user AS session")).rows[0],
    ).toEqual({ current: role, session: role });
    const connectAdmin = async () => {
      const other = new Client({
        connectionString: databaseUrl,
        connectionTimeoutMillis: 3000,
        query_timeout: 3000,
      });
      await other.connect();
      clients.push(other);
      await other.query(
        `SET search_path TO ${quote(schema)}; SET lock_timeout='150ms'; SET statement_timeout='2s'`,
      );
      return other;
    };
    await use({ admin, runtime, schema, role, connectAdmin });
  } finally {
    for (const client of clients.reverse()) {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end().catch(() => undefined);
    }
    await admin.query("ROLLBACK").catch(() => undefined);
    await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
    if (roleCreated) await admin.query(`DROP OWNED BY ${quote(role)}; DROP ROLE ${quote(role)}`);
    await admin.end();
  }
}
async function seedGuest(f: Fixture, n: number) {
  await f.admin.query(
    "INSERT INTO participation_owners(owner_id,kind,guest_origin,state,created_at) VALUES($1,'guest',$2,'empty',clock_timestamp()+$3::interval)",
    [owner(n), origin, `${n} milliseconds`],
  );
}
async function upload(f: Fixture, n: number, id: string) {
  return (
    await f.runtime.query(
      "SELECT fixture_audio_upload_v1($1,$2,'study',$3,$4,$5,$6,$7,0) AS revision",
      [
        owner(n),
        `artifact-${id}`,
        `attempt-${id}`,
        `command-${id}`,
        `reservation-${id}`,
        `object/${id}`,
        id,
      ],
    )
  ).rows[0]?.revision;
}
async function prepare(f: Fixture, n: number, id: string, maximum = 1000) {
  const batch = (
    await f.runtime.query(
      "SELECT fixture_audio_prepare_v1($1,$2,$3,$4,$5::text[],$6,$7,'unavailable') AS batch",
      [owner(n), `key-${id}`, requestHash, `command-${id}`, [owner(n)], `batch-${id}`, maximum],
    )
  ).rows[0]?.batch;
  if (typeof batch !== "string") throw new Error("batch absent");
  const revision = (
    await f.admin.query("SELECT revision FROM learner_audio_delete_batches WHERE batch_id=$1", [
      batch,
    ])
  ).rows[0]?.revision;
  return { batch, revision };
}
const confirm = (f: Fixture, batch: string, revision: string) =>
  f.runtime.query(
    "SELECT fixture_audio_confirm_v1($1,$2::bigint,'absent',clock_timestamp()) AS done",
    [batch, revision],
  );

suite("private source-owned audio foundation", () => {
  test(
    "private ACL and positive phase cover every owner/control FK target and sequence consumer",
    () =>
      fixture(async (f) => {
        expect(
          (await f.admin.query("SELECT phase FROM guest_learning_schema_phase")).rows[0]?.phase,
        ).toBe("practice_only_owner_audio_history_v3");
        await f.admin.query("SELECT require_guest_practice_only_schema_phase_v1()");
        for (const relation of audioTables) {
          await expect(f.runtime.query(`SELECT * FROM ${quote(relation)}`)).rejects.toMatchObject({
            code: "42501",
          });
          await expect(f.runtime.query(`DELETE FROM ${quote(relation)}`)).rejects.toMatchObject({
            code: "42501",
          });
          expect(
            (
              await f.admin.query(
                "SELECT has_table_privilege($1,$2,'INSERT,UPDATE,DELETE,SELECT') AS allowed",
                [f.role, relation],
              )
            ).rows[0]?.allowed,
          ).toBe(false);
        }
        for (const signature of audioFunctions) {
          expect(
            (
              await f.admin.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [
                f.role,
                signature,
              ])
            ).rows[0]?.allowed,
          ).toBe(false);
        }
        await expect(
          f.runtime.query("SELECT nextval('learner_audio_fence_revision_v1')"),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          f.runtime.query(
            `SET ROLE ${quote((await f.admin.query("SELECT current_user AS name")).rows[0].name)}`,
          ),
        ).rejects.toMatchObject({ code: "42501" });
        expect(fkTargets).toHaveLength(20);
        for (const target of fkTargets) {
          const keys = (
            await f.admin.query<{ name: string; type: string }>(
              `SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type
        FROM pg_constraint key JOIN LATERAL unnest(key.conkey) WITH ORDINALITY k(attnum,ordinal) ON TRUE
        JOIN pg_attribute a ON a.attrelid=key.conrelid AND a.attnum=k.attnum
        WHERE key.contype='p' AND key.conrelid=$1::regclass ORDER BY k.ordinal`,
              [target],
            )
          ).rows;
          if (!keys.length) throw new Error("FK target primary key absent");
          const definitions = keys
            .map((key, index) => `${quote(`ref_${index}`)} ${key.type}`)
            .join(",");
          const refs = keys.map((_, index) => quote(`ref_${index}`)).join(",");
          const targetRefs = keys.map((key) => quote(key.name)).join(",");
          await f.admin.query(
            `CREATE TABLE unexpected_reference(${definitions},FOREIGN KEY(${refs}) REFERENCES ${quote(target)}(${targetRefs}))`,
          );
          await expect(
            f.admin.query("SELECT require_guest_practice_only_schema_phase_v1()"),
          ).rejects.toMatchObject({ code: "GP003" });
          await f.admin.query("DROP TABLE unexpected_reference");
        }
        await f.admin.query(
          "CREATE TABLE unexpected_sequence_user(n BIGINT DEFAULT nextval('learner_audio_fence_revision_v1'))",
        );
        await expect(
          f.admin.query("SELECT require_guest_practice_only_schema_phase_v1()"),
        ).rejects.toMatchObject({ code: "GP003" });
        await f.admin.query("DROP TABLE unexpected_sequence_user");
        for (const forbidden of [
          "guest_owner_associations",
          "participation_eligibility_decisions",
          "megapot_owner_shares",
          "megapot_owner_snapshot_leaves",
          "megapot_owner_allocations",
          "reward_credit_persona_bindings",
          "reward_credit_recipient_selections",
        ]) {
          await f.admin.query(`CREATE TABLE ${quote(forbidden)}(fixture TEXT)`);
          await expect(
            f.admin.query("SELECT require_guest_practice_only_schema_phase_v1()"),
          ).rejects.toMatchObject({ code: "GP003" });
          await f.admin.query(`DROP TABLE ${quote(forbidden)}`);
        }
        await f.admin.query("SELECT require_guest_practice_only_schema_phase_v1()");
      }),
    180_000,
  );

  test(
    "singleton locking expands reverse aliases, blocks their rows and creates no history",
    () =>
      fixture(async (f) => {
        await seedGuest(f, 10);
        await seedGuest(f, 11);
        await transaction(f.admin, async () => {
          await f.admin.query(
            "INSERT INTO guest_empty_owner_aliases(source_owner_id,canonical_owner_id,origin,created_at) VALUES($1,$2,$3,clock_timestamp())",
            [owner(11), owner(10), origin],
          );
          await f.admin.query(
            "UPDATE participation_owners SET state='aliased_empty' WHERE owner_id=$1",
            [owner(11)],
          );
        });
        const before = (
          await f.admin.query(
            "SELECT to_jsonb(o) AS row FROM participation_owners o WHERE owner_id=ANY($1::text[]) ORDER BY owner_id",
            [[owner(10), owner(11)]],
          )
        ).rows;
        const other = await f.connectAdmin();
        await f.runtime.query("BEGIN");
        try {
          await f.runtime.query("SELECT fixture_audio_lock_v1($1::text[])", [[owner(10)]]);
          await expect(
            other.query("SELECT 1 FROM participation_owners WHERE owner_id=$1 FOR UPDATE", [
              owner(11),
            ]),
          ).rejects.toMatchObject({ code: "55P03" });
          expect(
            (
              await f.admin.query(
                "SELECT count(*)::int AS count FROM learner_audio_owner_fences WHERE owner_id=ANY($1::text[])",
                [[owner(10), owner(11)]],
              )
            ).rows[0]?.count,
          ).toBe(0);
        } finally {
          await f.runtime.query("COMMIT");
        }
        expect(
          (
            await f.admin.query(
              "SELECT to_jsonb(o) AS row FROM participation_owners o WHERE owner_id=ANY($1::text[]) ORDER BY owner_id",
              [[owner(10), owner(11)]],
            )
          ).rows,
        ).toEqual(before);
        expect(
          (
            await f.admin.query("SELECT guest_authority_component_is_empty_v1($1) AS empty", [
              owner(11),
            ])
          ).rows[0]?.empty,
        ).toBe(true);
        await expect(upload(f, 11, "alias-new-source")).rejects.toMatchObject({ code: "P0001" });
        await f.admin.query("INSERT INTO learner_audio_owner_fences(owner_id) VALUES($1)", [
          owner(11),
        ]);
        expect(
          (
            await f.admin.query("SELECT guest_authority_component_is_empty_v1($1) AS empty", [
              owner(10),
            ])
          ).rows[0]?.empty,
        ).toBe(false);
      }),
    180_000,
  );

  test(
    "retained child resource and object histories prevent root empty cleanup without reparenting",
    () =>
      fixture(async (f) => {
        for (const [root, child] of [
          [31, 32],
          [33, 34],
        ] as const) {
          await seedGuest(f, root);
          await seedGuest(f, child);
          await transaction(f.admin, async () => {
            await f.admin.query(
              "INSERT INTO guest_empty_owner_aliases(source_owner_id,canonical_owner_id,origin,created_at) VALUES($1,$2,$3,clock_timestamp())",
              [owner(child), owner(root), origin],
            );
            await f.admin.query(
              "UPDATE participation_owners SET state='aliased_empty' WHERE owner_id=$1",
              [owner(child)],
            );
          });
          expect(
            (
              await f.admin.query("SELECT guest_authority_component_is_empty_v1($1) AS empty", [
                owner(root),
              ])
            ).rows[0]?.empty,
          ).toBe(true);
        }
        const ownersBefore = (
          await f.admin.query(
            "SELECT to_jsonb(o) AS row FROM participation_owners o WHERE owner_id=ANY($1::text[]) ORDER BY owner_id",
            [[owner(31), owner(32), owner(33), owner(34)]],
          )
        ).rows;
        const aliasesBefore = (
          await f.admin.query(
            "SELECT to_jsonb(a) AS row FROM guest_empty_owner_aliases a WHERE source_owner_id=ANY($1::text[]) ORDER BY source_owner_id",
            [[owner(32), owner(34)]],
          )
        ).rows;
        await f.admin.query(`INSERT INTO guest_resource_edge_locks VALUES('retained-child-edge');
      INSERT INTO guest_resource_policy_snapshots VALUES('retained-child-policy','{}'::jsonb);
      INSERT INTO guest_resource_cost_policy_snapshots VALUES('retained-child-cost',1000)`);
        await f.admin.query(
          `INSERT INTO guest_resource_session_reservations(reservation_id,source_owner_id,operation_kind,idempotency_key,
      request_hash,session_id,edge_fingerprint,policy_version,cost_policy_version,initial_units,remaining_units,unit_hold_micros,
      worst_case_cost_micros,state,original_result,created_at,reservation_expires_at)
      VALUES('retained-child-reservation',$1,'study_start','retained-child-key',$2,'retained-child-session','retained-child-edge',
        'retained-child-policy','retained-child-cost',1,1,1000,1000,'active','{}'::jsonb,transaction_timestamp(),transaction_timestamp()+INTERVAL '24 hours')`,
          [owner(32), requestHash],
        );
        expect(
          (
            await f.admin.query("SELECT guest_authority_component_is_empty_v1($1) AS empty", [
              owner(31),
            ])
          ).rows[0]?.empty,
        ).toBe(false);
        await f.admin.query(
          "INSERT INTO learner_audio_object_names(object_ref,owner_id,artifact_id,source_kind,attempt_ref) VALUES('retained-child-object',$1,'retained-child-artifact','study','retained-child-attempt')",
          [owner(34)],
        );
        expect(
          (
            await f.admin.query("SELECT guest_authority_component_is_empty_v1($1) AS empty", [
              owner(33),
            ])
          ).rows[0]?.empty,
        ).toBe(false);
        expect(
          (
            await f.admin.query(
              "SELECT to_jsonb(o) AS row FROM participation_owners o WHERE owner_id=ANY($1::text[]) ORDER BY owner_id",
              [[owner(31), owner(32), owner(33), owner(34)]],
            )
          ).rows,
        ).toEqual(ownersBefore);
        expect(
          (
            await f.admin.query(
              "SELECT to_jsonb(a) AS row FROM guest_empty_owner_aliases a WHERE source_owner_id=ANY($1::text[]) ORDER BY source_owner_id",
              [[owner(32), owner(34)]],
            )
          ).rows,
        ).toEqual(aliasesBefore);
        await expect(
          f.runtime.query("SELECT fixture_audio_lock_v1($1::text[])", [[owner(40)]]),
        ).rejects.toMatchObject({ code: "P0001" });
      }),
    180_000,
  );

  test(
    "registered never starts after fence; late stored invalidates old absence and needs a new exact batch",
    () =>
      fixture(async (f) => {
        await seedGuest(f, 20);
        await upload(f, 20, "unclaimed");
        expect(
          (
            await f.admin.query("SELECT state FROM participation_owners WHERE owner_id=$1", [
              owner(20),
            ])
          ).rows[0]?.state,
        ).toBe("established");
        const canceled = await prepare(f, 20, "cancel");
        // Native GENERATED ALWAYS identity and application key remain immutable.
        await expect(
          f.admin.query(
            "UPDATE learner_audio_delete_commands SET operation_kind='learning_retention' WHERE command_id='command-cancel'",
          ),
        ).rejects.toMatchObject({ code: "428C9" });
        await expect(
          f.admin.query(
            "UPDATE learner_audio_delete_commands SET idempotency_key='replacement' WHERE command_id='command-cancel'",
          ),
        ).rejects.toMatchObject({ code: "P0001" });

        expect(
          (await f.runtime.query("SELECT fixture_audio_claim_v1('unclaimed') AS claimed")).rows[0]
            ?.claimed,
        ).toBe(false);
        expect((await confirm(f, canceled.batch, canceled.revision)).rows[0]?.done).toBe(true);
        await seedGuest(f, 21);
        await upload(f, 21, "writing");
        expect(
          (await f.runtime.query("SELECT fixture_audio_claim_v1('writing') AS claimed")).rows[0]
            ?.claimed,
        ).toBe(true);
        // Deterministic adapter simulates a stalled pre-fence PUT without network.
        // SQL transactions have ended before any storage action.
        const objects = new Map<string, Uint8Array>();
        const first = await prepare(f, 21, "late");
        expect((await confirm(f, first.batch, first.revision)).rows[0]?.done).toBe(false);
        expect(
          (
            await f.runtime.query(
              "SELECT fixture_audio_settle_v1('writing','failed',FALSE,'captured-multipart-id') AS publish",
            )
          ).rows[0]?.publish,
        ).toBe(false);
        expect(
          (
            await f.admin.query(
              "SELECT io_state FROM learner_audio_upload_attempts WHERE upload_attempt_id='writing'",
            )
          ).rows[0]?.io_state,
        ).toBe("unknown");
        const freeTopology = await f.connectAdmin();
        await transaction(freeTopology, async () => {
          await freeTopology.query("SELECT pg_advisory_xact_lock(83000003,1)");
        });
        objects.set("object/writing", new Uint8Array([1, 2, 3]));
        expect(
          (
            await f.runtime.query(
              "SELECT fixture_audio_settle_v1('writing','stored',TRUE,'captured-multipart-id') AS publish",
            )
          ).rows[0]?.publish,
        ).toBe(false);
        expect(
          (
            await f.admin.query(
              "SELECT count(*)::int AS count FROM learner_audio_deleted_objects WHERE object_ref='object/writing'",
            )
          ).rows[0]?.count,
        ).toBe(0);
        expect((await confirm(f, first.batch, first.revision)).rows[0]?.done).toBe(false);
        const secondBatch = (
          await f.runtime.query(
            "SELECT fixture_audio_prepare_v1($1,'key-late',$2,'ignored-successor',$3::text[],'batch-late-successor',1000,'unavailable') AS batch",
            [owner(21), requestHash, [owner(21)]],
          )
        ).rows[0]?.batch;
        expect(secondBatch).toBe("batch-late-successor");
        for (const item of (
          await f.admin.query(
            "SELECT object_ref FROM learner_audio_delete_batch_items WHERE batch_id=$1",
            [secondBatch],
          )
        ).rows)
          objects.delete(item.object_ref); // controlled external adapter, outside SQL
        expect(objects.has("object/writing")).toBe(false);
        expect((await confirm(f, secondBatch, first.revision)).rows[0]?.done).toBe(true);
        await expect(
          f.admin.query(
            "UPDATE learner_audio_delete_commands SET final_result='{}'::jsonb WHERE command_id='command-late'",
          ),
        ).rejects.toMatchObject({ code: "P0001" });
        await expect(
          f.admin.query(
            "UPDATE learner_audio_upload_attempts SET io_state='writing',storage_disposition=NULL,closed_at=NULL WHERE upload_attempt_id='writing'",
          ),
        ).rejects.toMatchObject({ code: "P0001" });
      }),
    180_000,
  );

  test(
    "legacy pending/failed Karaoke without common artifacts stays unknown and prevents completion",
    () =>
      fixture(async (f) => {
        expect(
          (
            await f.admin.query(
              "SELECT count(*)::int AS count FROM learner_audio_artifacts WHERE learner_audio_artifact_id IN('missing-pending','missing-failed')",
            )
          ).rows[0]?.count,
        ).toBe(0);
        const imported = (
          await f.admin.query(
            "SELECT artifact_id,io_state,object_ref FROM learner_audio_upload_attempts WHERE owner_id=$1 ORDER BY artifact_id",
            [owner(1)],
          )
        ).rows;
        expect(imported).toHaveLength(2);
        expect(imported.every((row) => row.io_state === "unknown")).toBe(true);
        expect(
          imported.every((row) =>
            String(row.object_ref).startsWith("karaoke/legacy-karaoke-account/"),
          ),
        ).toBe(true);
        const batch = await prepare(f, 1, "legacy");
        expect(
          (
            await f.admin.query(
              "SELECT count(*)::int AS count FROM learner_audio_delete_target_artifacts WHERE command_id='command-legacy'",
            )
          ).rows[0]?.count,
        ).toBe(2);
        expect((await confirm(f, batch.batch, batch.revision)).rows[0]?.done).toBe(false);
        expect(
          (
            await f.admin.query(
              "SELECT state FROM learner_audio_delete_commands WHERE command_id='command-legacy'",
            )
          ).rows[0]?.state,
        ).toBe("pending");
        // Even a captured positive producer-close fact does not invent the later
        // actual recording guard/tombstone adapter. Missing artifacts never suffice.
        for (const row of (
          await f.admin.query(
            "SELECT upload_attempt_id FROM learner_audio_upload_attempts WHERE owner_id=$1",
            [owner(1)],
          )
        ).rows)
          await f.runtime.query("SELECT fixture_audio_settle_v1($1,'absent',TRUE,NULL)", [
            row.upload_attempt_id,
          ]);
        expect((await confirm(f, batch.batch, batch.revision)).rows[0]?.done).toBe(false);
        expect(
          (
            await f.admin.query(
              "SELECT active_delete_command_id FROM learner_audio_owner_fences WHERE owner_id=$1",
              [owner(1)],
            )
          ).rows[0]?.active_delete_command_id,
        ).toBe("command-legacy");
      }),
    180_000,
  );

  test(
    "bounds batches to1000, keeps fence across unresolved batches",
    () =>
      fixture(async (f) => {
        await seedGuest(f, 30);
        await f.admin.query(
          "INSERT INTO learner_audio_object_names(object_ref,owner_id,artifact_id,source_kind,attempt_ref) SELECT 'bulk/'||n,$1,'bulk-artifact-'||n,'study','bulk-attempt-'||n FROM generate_series(1,1001)n",
          [owner(30)],
        );
        await expect(prepare(f, 30, "bad-bound", 1001)).rejects.toMatchObject({ code: "P0001" });
        const first = await prepare(f, 30, "bulk");
        expect(
          (
            await f.admin.query(
              "SELECT count(*)::int AS count,max(ordinal)::int AS maximum FROM learner_audio_delete_batch_items WHERE batch_id=$1",
              [first.batch],
            )
          ).rows[0],
        ).toEqual({ count: 1000, maximum: 1000 });
        expect((await confirm(f, first.batch, first.revision)).rows[0]?.done).toBe(false);
        const next = (
          await f.runtime.query(
            "SELECT fixture_audio_prepare_v1($1,'key-bulk',$2,'ignored',$3::text[],'batch-bulk-next',1000,'unavailable') AS batch",
            [owner(30), requestHash, [owner(30)]],
          )
        ).rows[0]?.batch;
        expect(
          (
            await f.admin.query(
              "SELECT count(*)::int AS count FROM learner_audio_delete_batch_items WHERE batch_id=$1",
              [next],
            )
          ).rows[0]?.count,
        ).toBe(1);
        expect((await confirm(f, next, first.revision)).rows[0]?.done).toBe(true);
      }),
    180_000,
  );
});
