// REVIEW PROPOSAL ONLY. Intended packages/platform-cf/src/guest-attachment-preparation.pg.test.ts.
// Runnable owned PG17 fixture after root adoption. No database/gate was run by this reviewer.
// Minimal owner/identity/five-family fixture; not populated 0249 backfill acceptance.
import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { GuestAttachmentIntentV1, GuestAttachmentPreparedV1 } from "@pirate/contracts";
import { Schema } from "effect";
import { Client } from "pg";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = url ? describe : describe.skip;
const origin = "https://community.example";
const guestOwner = "owner_00000000-0000-0000-0000-000000000001";
const accountOwnerA = "owner_00000000-0000-0000-0000-000000000110";
const accountOwnerB = "owner_00000000-0000-0000-0000-000000000120";
const accountA = "account-a";
const accountB = "account-b";
const sessionA = "a".repeat(64);
const sessionB = "b".repeat(64);
const requestHash = "c".repeat(64);
const families = [
  "study_sessions_v2",
  "study_review_items",
  "study_session_items_v2",
  "study_spoken_answer_commands",
  "learner_audio_artifacts",
];
const privateTables = [
  "guest_learning_schema_phase",
  "participation_owners",
  "guest_credentials",
  "guest_empty_owner_aliases",
  "participation_owner_clocks",
  "guest_learning_preferences",
  "guest_participation_operations",
  "guest_secret_issuance_operations",
  "guest_attachment_intents",
];
const transitions = [
  "issue_guest_pending_v1(text,text[],text,text,text,text,text,text,text)",
  "confirm_guest_pending_v1(text,text[],text,text)",
  "create_guest_attachment_intent_v1(text,text[],text,text,text[],text,text,text,text,text)",
  "prepare_guest_attachment_target_v1(text,text[],text,text,text[],text,text,text)",
];
const Operation = Schema.Struct({
  sourceOwnerId: Schema.String,
  kind: Schema.Literals(["attachment_intent", "attachment_prepare"]),
  idempotencyKey: Schema.String,
  requestHash: Schema.String,
});
const Created = Schema.Struct({
  state: Schema.Literal("completed"),
  operation_id: Schema.String,
  operation: Operation,
  intent: GuestAttachmentIntentV1,
  cookie_effects: Schema.Array(
    Schema.Struct({
      kind: Schema.Literal("intent"),
      action: Schema.Literal("issue"),
      intentId: Schema.String,
    }),
  ),
});
const CreateReply = Schema.Union([
  Created,
  Schema.Struct({ state: Schema.Literal("issuance_requires_restart") }),
]);
const Prepared = Schema.Struct({
  state: Schema.Literal("completed"),
  operation_id: Schema.String,
  operation: Operation,
  prepared: GuestAttachmentPreparedV1,
});
const TrustedIds = Schema.Struct({
  credentials: Schema.Array(Schema.String),
  intents: Schema.Array(Schema.String),
});
type Proof = Readonly<{ id: string; digest: string }>;
type Fixture = Readonly<{
  admin: Client;
  runtime: Client;
  runtimeUrl: string;
  schema: string;
  role: string;
}>;
function proof(intent = false): Proof {
  return {
    id: `${intent ? "gai_" : ""}${btoa(String.fromCharCode(...randomBytes(16)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "")}`,
    digest: createHash("sha256").update(randomBytes(32)).digest("hex"),
  };
}
async function result<A>(
  client: Client,
  text: string,
  values: unknown[],
  schema: Schema.ConstraintDecoder<A>,
): Promise<A> {
  const response = await client.query(text, values);
  if (response.rows.length !== 1) throw new Error("expected exactly one fixture result row");
  return Schema.decodeUnknownSync(Schema.Struct({ result: schema }), { onExcessProperty: "error" })(
    response.rows[0],
  ).result;
}
async function errorCode(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    return Schema.decodeUnknownSync(Schema.Struct({ code: Schema.String }))(error).code;
  }
  throw new Error("expected SQL rejection");
}
async function trusted(
  f: Fixture,
  credentials: readonly Proof[],
  intents: readonly Proof[],
  productOrigin = origin,
) {
  // Real digest-matched owner-only reader; locators alone never manufacture proved IDs.
  return result(
    f.admin,
    `SELECT jsonb_build_object(
    'credentials', COALESCE((SELECT jsonb_agg(v->>'credentialId') FROM jsonb_array_elements(s->'provedCredentials') v),'[]'::jsonb),
    'intents', COALESCE((SELECT jsonb_agg(v->>'intentId') FROM jsonb_array_elements(s->'provedIntents') v),'[]'::jsonb)
    ) AS result FROM (SELECT read_guest_browser_proof_snapshot_v1($1,$2::jsonb,$3::jsonb,FALSE) AS s) q`,
    [
      productOrigin,
      JSON.stringify(credentials.map((p) => ({ credentialId: p.id, digest: p.digest }))),
      JSON.stringify(intents.map((p) => ({ intentId: p.id, digest: p.digest }))),
    ],
    TrustedIds,
  );
}
async function fixture(use: (f: Fixture) => Promise<void>) {
  if (!url) throw new Error("owned fixture URL missing");
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const schema = `guest_preparation_${suffix}`;
  const role = `guest_prepare_login_${suffix}`;
  const password = Array.from(randomBytes(32), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  const admin = new Client({
    connectionString: url,
    connectionTimeoutMillis: 3000,
    query_timeout: 3000,
  });
  let runtime: Client | undefined;
  let createdRole = false;
  await admin.connect();
  try {
    const command = await result(
      admin,
      `SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD %L',$1::name,$2::text) AS result`,
      [role, password],
      Schema.String,
    );
    await admin.query(command);
    createdRole = true;
    await admin.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}";
      ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT ALL ON TABLES TO "${role}";
      ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT EXECUTE ON FUNCTIONS TO "${role}";
      CREATE TABLE users(user_id TEXT PRIMARY KEY,status TEXT NOT NULL CHECK(status IN ('active','deleted')));
      -- Mirrors actual 0002 identity: deliberately NO users FK.
      CREATE TABLE account_aliases(source_user_id TEXT PRIMARY KEY,canonical_user_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('alias','merge')),
        status TEXT NOT NULL CHECK(status IN ('active','finalizing','completed','inactive')));
      CREATE TABLE communities(community_id TEXT PRIMARY KEY,status TEXT NOT NULL);
      CREATE TABLE posts(community_id TEXT,post_id TEXT,post_type TEXT,status TEXT,visibility TEXT,content_rating TEXT);
      GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
    await admin.query(
      await Bun.file(
        `${process.cwd()}/db/postgres/migrations/0248_guest_learning_authority_foundation.sql`,
      ).text(),
    );
    for (const family of families)
      await admin.query(`CREATE TABLE ${family}(
      fixture_id TEXT PRIMARY KEY,participation_owner_id TEXT NOT NULL,
      participation_owner_kind TEXT NOT NULL CHECK(participation_owner_kind IN ('account','guest')),
      FOREIGN KEY(participation_owner_id,participation_owner_kind) REFERENCES participation_owners(owner_id,kind));
      REVOKE ALL ON ${family} FROM PUBLIC,"${role}"`);
    await admin.query(
      `REVOKE ALL ON users,account_aliases,communities,posts FROM PUBLIC,"${role}"`,
    );
    // Loads root-adopted current source, including the account_aliases SHARE lock.
    // Never applies the unsealed original proposal or disables an immutable guard.
    await admin.query(
      await Bun.file(
        `${process.cwd()}/db/postgres/migrations/0250_guest_browser_authority_transitions.sql`,
      ).text(),
    );
    for (const signature of transitions)
      await admin.query(`GRANT EXECUTE ON FUNCTION ${signature} TO "${role}"`);
    await admin.query("INSERT INTO users VALUES($1,'active'),($2,'active')", [accountA, accountB]);
    // Explicit existing active-canonical baseline mapping for this focused fixture.
    // Full populated 0249 admission/backfill is independently tested by its owning suite.
    await admin.query(
      `INSERT INTO participation_owners(owner_id,kind,account_id,state)
      VALUES($1,'account',$2,'empty'),($3,'account',$4,'empty')`,
      [accountOwnerA, accountA, accountOwnerB, accountB],
    );
    const parsed = new URL(url);
    parsed.username = role;
    parsed.password = password;
    const runtimeUrl = parsed.toString();
    runtime = new Client({
      connectionString: runtimeUrl,
      connectionTimeoutMillis: 3000,
      query_timeout: 3000,
    });
    await runtime.connect();
    await runtime.query(
      `SET search_path TO "${schema}"; SET lock_timeout='250ms'; SET statement_timeout='3s'`,
    );
    const identity = await result(
      runtime,
      "SELECT jsonb_build_object('current',current_user,'session',session_user) AS result",
      [],
      Schema.Struct({ current: Schema.String, session: Schema.String }),
    );
    expect(identity).toEqual({ current: role, session: role });
    process.stdout.write(
      `${JSON.stringify({
        fixture: "guest-preparation-restricted-login",
        roleSha256: createHash("sha256").update(identity.current).digest("hex"),
        currentEqualsSession: true,
      })}\n`,
    );
    await use({ admin, runtime, runtimeUrl, schema, role });
  } finally {
    if (runtime) {
      await runtime.query("ROLLBACK").catch(() => undefined);
      await runtime.end().catch(() => undefined);
    }
    await admin.query("ROLLBACK").catch(() => undefined);
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (createdRole) await admin.query(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
    await admin.end();
  }
}
async function confirmed(f: Fixture, p: Proof) {
  await f.runtime.query(
    "SELECT issue_guest_pending_v1($1,ARRAY[]::text[],NULL,$2,$3,$4,$5,$6,$7)",
    [origin, "bootstrap", requestHash, "bootstrap-operation", guestOwner, p.id, p.digest],
  );
  const ids = await trusted(f, [p], []);
  expect(ids.credentials).toEqual([p.id]);
  await f.runtime.query("SELECT confirm_guest_pending_v1($1,$2::text[],$3,$4)", [
    origin,
    ids.credentials,
    p.id,
    guestOwner,
  ]);
}
async function create(
  f: Fixture,
  credential: Proof,
  nonce: Proof,
  key = "ceremony-key",
  carried: Proof[] = [],
  hash = requestHash,
) {
  const ids = await trusted(f, [credential], carried);
  return result(
    f.runtime,
    "SELECT create_guest_attachment_intent_v1($1,$2::text[],$3,$4,$5::text[],$6,$7,$8,$9,$10) AS result",
    [
      origin,
      ids.credentials,
      credential.id,
      guestOwner,
      ids.intents,
      key,
      hash,
      `intent-operation-${key}`,
      nonce.id,
      nonce.digest,
    ],
    CreateReply,
  );
}
async function prepare(
  f: Fixture,
  credential: Proof,
  nonce: Proof,
  account = accountA,
  session = sessionA,
  nonceProof: Proof = nonce,
) {
  const ids = await trusted(f, [credential], [nonceProof]);
  return result(
    f.runtime,
    "SELECT prepare_guest_attachment_target_v1($1,$2::text[],$3,$4,$5::text[],$6,$7,$8) AS result",
    [origin, ids.credentials, credential.id, guestOwner, ids.intents, nonce.id, account, session],
    Prepared,
  );
}
async function target(f: Fixture, intentId: string) {
  return result(
    f.admin,
    `SELECT jsonb_build_object('state',state,'revision',target_revision,
    'account',target_account_id,'session',target_session_digest,'operation',prepared_operation_id) AS result
    FROM guest_attachment_intents WHERE intent_id=$1`,
    [intentId],
    Schema.Struct({
      state: Schema.String,
      revision: Schema.Number,
      account: Schema.NullOr(Schema.String),
      session: Schema.NullOr(Schema.String),
      operation: Schema.NullOr(Schema.String),
    }),
  );
}
async function operations(f: Fixture) {
  return result(
    f.admin,
    `SELECT COALESCE(jsonb_agg(jsonb_build_object('id',operation_id,'source',source_owner_id,
    'kind',operation_kind,'scope',resource_scope,'snapshot',result_snapshot) ORDER BY operation_id),'[]'::jsonb) AS result
    FROM guest_participation_operations`,
    [],
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        source: Schema.String,
        kind: Schema.String,
        scope: Schema.String,
        snapshot: Schema.Unknown,
      }),
    ),
  );
}

suite("private guest attachment intent and preparation", () => {
  test("creation has no target; proved receipt replay is immutable and cookie-free; lost nonce requires deliberate restart", async () => {
    await fixture(async (f) => {
      const c = proof();
      const first = proof(true);
      await confirmed(f, c);
      const created = await create(f, c, first);
      expect(created.state).toBe("completed");
      if (created.state !== "completed") throw new Error("expected issuance");
      expect(created.cookie_effects).toEqual([
        { kind: "intent", action: "issue", intentId: first.id },
      ]);
      expect(await target(f, first.id)).toEqual({
        state: "awaiting_account",
        revision: 0,
        account: null,
        session: null,
        operation: null,
      });
      const prepared = await prepare(f, c, first);
      const snapshot = await target(f, first.id);
      const replacementRandom = proof(true);
      const replay = await create(f, c, replacementRandom, "ceremony-key", [first]);
      expect(replay).toEqual({ ...created, cookie_effects: [] });
      expect(await target(f, first.id)).toEqual(snapshot);
      expect(await create(f, c, proof(true))).toEqual({ state: "issuance_requires_restart" });
      expect(
        await errorCode(create(f, c, proof(true), "ceremony-key", [first], "d".repeat(64))),
      ).toBe("GP005");
      const restarted = await create(f, c, replacementRandom, "new-deliberate-key");
      expect(restarted.state).toBe("completed");
      expect(await target(f, first.id)).toEqual({ ...snapshot, state: "superseded" });
      expect(await target(f, replacementRandom.id)).toEqual({
        state: "awaiting_account",
        revision: 0,
        account: null,
        session: null,
        operation: null,
      });
      expect(await errorCode(prepare(f, c, first))).toBe("GP006");
      expect((await operations(f)).find((op) => op.id === prepared.operation_id)?.snapshot).toEqual(
        { prepared: prepared.prepared },
      );
    });
  }, 15000);

  test("same current tuple returns exact original operation; changed session/account and return to prior session advance monotonically", async () => {
    await fixture(async (f) => {
      const c = proof();
      const nonce = proof(true);
      await confirmed(f, c);
      await create(f, c, nonce);
      const first = await prepare(f, c, nonce);
      expect(first.prepared.target_revision).toBe(1);
      expect(await prepare(f, c, nonce)).toEqual(first);
      const second = await prepare(f, c, nonce, accountA, sessionB);
      const third = await prepare(f, c, nonce, accountA, sessionA);
      const fourth = await prepare(f, c, nonce, accountB, sessionA);
      expect([second, third, fourth].map((r) => r.prepared.target_revision)).toEqual([2, 3, 4]);
      expect(new Set([first, second, third, fourth].map((r) => r.operation_id)).size).toBe(4);
      expect(await prepare(f, c, nonce, accountB, sessionA)).toEqual(fourth);
      const rows = (await operations(f)).filter((op) => op.kind === "attachment_prepare");
      expect(rows.length).toBe(4);
      for (const r of [first, second, third, fourth]) {
        expect(rows.find((op) => op.id === r.operation_id)?.snapshot).toEqual({
          prepared: r.prepared,
        });
        expect(JSON.stringify(r)).not.toContain(sessionA);
        expect(JSON.stringify(r)).not.toContain(sessionB);
        expect(JSON.stringify(r)).not.toContain(nonce.digest);
      }
      const authority = await result(
        f.admin,
        `SELECT jsonb_build_object('credential',c.state,'guest',o.state,
        'associations',EXISTS(SELECT 1 FROM pg_class WHERE relnamespace=current_schema()::regnamespace
          AND relname IN ('guest_owner_associations','reward_credit_persona_bindings','participation_eligibility_decisions')))
        AS result FROM guest_credentials c JOIN participation_owners o ON o.owner_id=c.owner_id WHERE credential_id=$1`,
        [c.id],
        Schema.Struct({
          credential: Schema.String,
          guest: Schema.String,
          associations: Schema.Boolean,
        }),
      );
      expect(authority).toEqual({ credential: "confirmed", guest: "empty", associations: false });
    });
  }, 15000);

  test("digest/origin mismatches do not prove nonce; inactive, missing-owner and committed alias targets refuse without mutation", async () => {
    await fixture(async (f) => {
      const c = proof();
      const nonce = proof(true);
      await confirmed(f, c);
      await create(f, c, nonce);
      expect((await trusted(f, [c], [{ ...nonce, digest: "e".repeat(64) }])).intents).toEqual([]);
      expect(await trusted(f, [c], [nonce], "https://other.example")).toEqual({
        credentials: [],
        intents: [],
      });
      const before = await target(f, nonce.id);
      expect(
        await errorCode(
          prepare(f, c, nonce, accountA, sessionA, { ...nonce, digest: "e".repeat(64) }),
        ),
      ).toBe("GP001");
      await f.admin.query(
        "INSERT INTO users VALUES('unmapped-account','active'),('deleted-account','deleted')",
      );
      for (const account of ["unmapped-account", "deleted-account"])
        expect(await errorCode(prepare(f, c, nonce, account))).toBe("GP008");
      await f.admin.query("INSERT INTO account_aliases VALUES($1,$2,'merge','finalizing')", [
        accountA,
        accountB,
      ]);
      expect(await errorCode(prepare(f, c, nonce))).toBe("GP008");
      expect(await target(f, nonce.id)).toEqual(before);
      expect((await operations(f)).filter((op) => op.kind === "attachment_prepare")).toEqual([]);
    });
  }, 15000);

  test("restricted server login has only ceremony transitions, no helper/raw table authority", async () => {
    await fixture(async (f) => {
      const c = proof();
      const nonce = proof(true);
      await confirmed(f, c);
      const created = await create(f, c, nonce);
      if (created.state !== "completed") throw new Error("expected issuance");
      for (const table of [...privateTables, ...families, "users", "account_aliases"]) {
        expect(await errorCode(f.runtime.query(`SELECT * FROM ${table} LIMIT 1`))).toBe("42501");
        expect(await errorCode(f.runtime.query(`DELETE FROM ${table} WHERE FALSE`))).toBe("42501");
      }
      expect(
        await errorCode(
          f.runtime.query("SELECT guest_attachment_operation_identity_v1($1)", [
            created.operation_id,
          ]),
        ),
      ).toBe("42501");
      expect(
        await errorCode(
          f.runtime.query(
            "SELECT read_guest_browser_proof_snapshot_v1($1,'[]'::jsonb,'[]'::jsonb,FALSE)",
            [origin],
          ),
        ),
      ).toBe("42501");
    });
  }, 15000);

  for (const mutation of ["insert", "status-update"]) {
    test(`prepare holds actual SHARE relation lock against ${mutation} ROW EXCLUSIVE writer; committed alias then yields GP008`, async () => {
      await fixture(async (f) => {
        const c = proof();
        const nonce = proof(true);
        await confirmed(f, c);
        await create(f, c, nonce);
        if (mutation === "status-update")
          await f.admin.query("INSERT INTO account_aliases VALUES($1,$2,'alias','inactive')", [
            accountA,
            accountB,
          ]);
        // Owner connection is a separate local fixture alias writer, not the restricted server role.
        const writer = new Client({
          connectionString: url,
          connectionTimeoutMillis: 3000,
          query_timeout: 3000,
        });
        await writer.connect();
        let pending: Promise<unknown> | undefined;
        let settled = false;
        try {
          await writer.query(
            `SET search_path TO "${f.schema}"; SET lock_timeout='2s'; SET statement_timeout='3s'`,
          );
          const writerPid = await result(
            writer,
            "SELECT pg_backend_pid() AS result",
            [],
            Schema.Number,
          );
          const holderPid = await result(
            f.runtime,
            "SELECT pg_backend_pid() AS result",
            [],
            Schema.Number,
          );
          await f.runtime.query("BEGIN");
          const prepared = await prepare(f, c, nonce);
          const before = await operations(f);
          await writer.query("BEGIN");
          pending = (
            mutation === "insert"
              ? writer.query("INSERT INTO account_aliases VALUES($1,$2,'alias','active')", [
                  accountA,
                  accountB,
                ])
              : writer.query("UPDATE account_aliases SET status='active' WHERE source_user_id=$1", [
                  accountA,
                ])
          ).finally(() => {
            settled = true;
          });
          // Attach rejection handling immediately, so timeout failure cannot become unhandled.
          void pending.catch(() => undefined);
          const deadline = performance.now() + 1000;
          let observed = false;
          do {
            const trace = await result(
              f.admin,
              `SELECT jsonb_build_object(
              'blockedByHolder',$1=ANY(pg_blocking_pids($2)),
              'holderShare',EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND relation='account_aliases'::regclass AND mode='ShareLock' AND granted),
              'writerRowExclusiveWait',EXISTS(SELECT 1 FROM pg_locks WHERE pid=$2 AND relation='account_aliases'::regclass AND mode='RowExclusiveLock' AND NOT granted),
              'writerLockWait',EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$2 AND wait_event_type='Lock')) AS result`,
              [holderPid, writerPid],
              Schema.Struct({
                blockedByHolder: Schema.Boolean,
                holderShare: Schema.Boolean,
                writerRowExclusiveWait: Schema.Boolean,
                writerLockWait: Schema.Boolean,
              }),
            );
            if (
              trace.blockedByHolder &&
              trace.holderShare &&
              trace.writerRowExclusiveWait &&
              trace.writerLockWait
            ) {
              observed = true;
              process.stdout.write(
                `${JSON.stringify({
                  fixture: "guest-prepare-alias-relation-lock",
                  mutation,
                  holderPid,
                  writerPid,
                  ...trace,
                })}\n`,
              );
              break;
            }
            // Poll actual lock state to a deadline; elapsed time never establishes success.
            await Bun.sleep(5);
          } while (performance.now() < deadline && !settled);
          expect(observed).toBe(true);
          expect(settled).toBe(false);
          await f.runtime.query("COMMIT");
          await pending;
          await writer.query("COMMIT");
          const committedOperations = await operations(f);
          const expectedOperations = [
            ...before,
            {
              id: prepared.operation_id,
              source: guestOwner,
              kind: "attachment_prepare",
              scope: nonce.id,
              snapshot: { prepared: prepared.prepared },
            },
          ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          expect(committedOperations).toEqual(expectedOperations);
          const preserved = await target(f, nonce.id);
          expect(preserved).toMatchObject({
            state: "awaiting_confirmation",
            revision: 1,
            account: accountA,
            session: sessionA,
            operation: prepared.operation_id,
          });
          expect(await errorCode(prepare(f, c, nonce))).toBe("GP008");
          expect(await target(f, nonce.id)).toEqual(preserved);
          expect(await operations(f)).toEqual(committedOperations);
        } finally {
          // Release holder first so a failed observation cannot strand its owned writer.
          await f.runtime.query("ROLLBACK").catch(() => undefined);
          if (pending) await pending.catch(() => undefined);
          await writer.query("ROLLBACK").catch(() => undefined);
          await writer.end();
        }
      });
    }, 15000);
  }
});
