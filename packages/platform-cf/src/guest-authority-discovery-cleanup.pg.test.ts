// Private authority transitions against an owned PostgreSQL fixture.
// Minimal five-family FK fixture proves transitions, not populated 0249 backfill.
import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "pg";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = url ? describe : describe.skip;
const origin = "https://community.example";
const families = [
  "study_sessions_v2",
  "study_review_items",
  "study_session_items_v2",
  "study_spoken_answer_commands",
  "learner_audio_artifacts",
] as const;
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
] as const;
const transitions = [
  "discover_guest_authority_v1(text,text[],text,text,text)",
  "cleanup_guest_authority_v1(text,text[],text[],text,text[],text[])",
] as const;
const owner = (n: number) => `owner_00000000-0000-0000-0000-${n.toString().padStart(12, "0")}`;
const requestHash = "a".repeat(64);
type Proof = Readonly<{ id: string; digest: string }>;
function proof(): Proof {
  return {
    id: btoa(String.fromCharCode(...randomBytes(16)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", ""),
    digest: createHash("sha256").update(randomBytes(32)).digest("hex"),
  };
}
type Metadata = {
  owner_id: string;
  credential_id: string;
  credential_state: string;
  session_until: string | null;
};
type Result = {
  state?: string;
  operation_id?: string;
  operation?: { sourceOwnerId: string; kind: string; idempotencyKey: string; requestHash: string };
  authority?: { state: string; selected: Metadata | null; proved_credentials: Metadata[] };
  cookie_effects?: { kind: string; action: string; credentialId: string }[];
};
type Fixture = { admin: Client; runtime: Client; runtimeUrl: string; schema: string; role: string };
async function result(client: Client, query: string, params: unknown[]): Promise<Result> {
  const value = (await client.query<{ result: Result }>(query, params)).rows[0]?.result;
  if (value === undefined) throw new Error("missing transition result");
  return value;
}
async function proved(
  admin: Client,
  proofs: readonly Proof[],
  productOrigin = origin,
  cleanup = false,
): Promise<string[]> {
  const rows = await admin.query<{ credential_id: string }>(
    "SELECT credential_id FROM read_guest_credential_proof_matches_v1($1,$2::jsonb,$3)",
    [
      productOrigin,
      JSON.stringify(proofs.map((p) => ({ credentialId: p.id, digest: p.digest }))),
      cleanup,
    ],
  );
  // Models the actual verifier's trusted, origin-bound context extraction.
  // Browser locator arguments alone never populate these arrays.
  return rows.rows.map((row) => row.credential_id);
}
async function fixture(use: (f: Fixture) => Promise<void>) {
  if (!url) throw new Error("test URL missing");
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const schema = `guest_transition_${suffix}`;
  const role = `guest_login_${suffix}`;
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
    // Utility CREATE ROLE does not accept query parameters. PostgreSQL %I/%L
    // safely quote fixture identifiers and this private ephemeral credential.
    const command = (
      await admin.query<{ command: string }>(
        "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD %L',$1::name,$2::text) AS command",
        [role, password],
      )
    ).rows[0]?.command;
    if (!command) throw new Error("fixture role command missing");
    await admin.query(command);
    createdRole = true;
    await admin.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}";
      ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT ALL ON TABLES TO "${role}";
      ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT EXECUTE ON FUNCTIONS TO "${role}";
      CREATE TABLE users(user_id TEXT PRIMARY KEY);
      CREATE TABLE communities(community_id TEXT PRIMARY KEY,status TEXT NOT NULL);
      CREATE TABLE posts(community_id TEXT,post_id TEXT,post_type TEXT,status TEXT,visibility TEXT,content_rating TEXT);
      GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
    await admin.query(
      await Bun.file(
        `${process.cwd()}/db/postgres/migrations/0248_guest_learning_authority_foundation.sql`,
      ).text(),
    );
    for (const family of families) {
      await admin.query(`CREATE TABLE ${family}(
        fixture_id TEXT PRIMARY KEY,
        participation_owner_id TEXT NOT NULL,
        participation_owner_kind TEXT NOT NULL CHECK(participation_owner_kind IN ('account','guest')),
        FOREIGN KEY(participation_owner_id,participation_owner_kind)
          REFERENCES participation_owners(owner_id,kind));
        REVOKE ALL ON ${family} FROM PUBLIC,"${role}"`);
    }
    await admin.query(`REVOKE ALL ON users,communities,posts FROM PUBLIC,"${role}"`);
    await admin.query(
      await Bun.file(
        `${process.cwd()}/db/postgres/migrations/0250_guest_browser_authority_transitions.sql`,
      ).text(),
    );
    for (const signature of transitions)
      await admin.query(`GRANT EXECUTE ON FUNCTION ${signature} TO "${role}"`);
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
    const identity = (
      await runtime.query<{ current: string; session: string }>(
        "SELECT current_user AS current,session_user AS session",
      )
    ).rows[0];
    expect(identity).toEqual({ current: role, session: role });
    // Scalar hash is safe for a receipt; role/password/connection string are
    // deliberately not logged/exported by this fixture.
    const roleSha256 = createHash("sha256")
      .update(identity?.current ?? "")
      .digest("hex");
    expect(roleSha256).toMatch(/^[0-9a-f]{64}$/u);
    process.stdout.write(
      `${JSON.stringify({ fixture: "guest-authority-restricted-login", roleSha256, currentEqualsSession: true })}\n`,
    );
    await use({ admin, runtime, runtimeUrl, schema, role });
  } finally {
    if (runtime) {
      await runtime.query("ROLLBACK").catch(() => undefined);
      await runtime.end().catch(() => undefined);
    }
    await admin.query("ROLLBACK").catch(() => undefined);
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (createdRole) {
      await admin.query(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
    }
    await admin.end();
  }
}
async function clocks(f: Fixture, id: string) {
  return (
    await f.admin.query<{ confirmed: string; lease: string }>(
      "SELECT confirmed_at::text AS confirmed,session_until::text AS lease FROM guest_credentials WHERE credential_id=$1",
      [id],
    )
  ).rows[0];
}

type Authority = {
  state: string;
  selected: Metadata | null;
  proved_credentials: Metadata[];
  pointer_repair: {
    previous_credential_id: string;
    credential_id: string;
    owner_id: string;
  } | null;
};
type Cleanup = {
  authority: Authority;
  cookieEffects: { kind: string; action: string; credentialId?: string; intentId?: string }[];
};
async function seed(f: Fixture, n: number, p: Proof, confirmed = false) {
  await result(f.admin, "SELECT issue_guest_pending_v1($1,'{}',NULL,$2,$3,$4,$5,$6,$7) AS result", [
    origin,
    `seed-${n}`,
    requestHash,
    `seed-operation-${n}`,
    owner(n),
    p.id,
    p.digest,
  ]);
  if (confirmed)
    await result(f.admin, "SELECT confirm_guest_pending_v1($1,$2::text[],$3,$4) AS result", [
      origin,
      await proved(f.admin, [p]),
      p.id,
      owner(n),
    ]);
}
async function discover(
  f: Fixture,
  carried: Proof[],
  selected: string | null = null,
  expected: string | null = null,
  previous: string | null = null,
) {
  const value = (
    await f.runtime.query<{ authority: Authority }>(
      "SELECT discover_guest_authority_v1($1,$2::text[],$3,$4,$5) AS authority",
      [origin, await proved(f.admin, carried), selected, expected, previous],
    )
  ).rows[0]?.authority;
  if (!value) throw new Error("missing discovery authority");
  return value;
}
async function provedIntents(f: Fixture, carried: Proof[]) {
  const snapshot = (
    await f.admin.query<{ snapshot: { provedIntents: { intentId: string }[] } }>(
      "SELECT read_guest_browser_proof_snapshot_v1($1,'[]',$2::jsonb,TRUE) AS snapshot",
      [origin, JSON.stringify(carried.map((p) => ({ intentId: p.id, digest: p.digest })))],
    )
  ).rows[0]?.snapshot;
  if (!snapshot) throw new Error("missing intent proof snapshot");
  return snapshot.provedIntents.map((p) => p.intentId);
}
async function cleanup(
  f: Fixture,
  carried: Proof[],
  selected: string | null,
  candidates: string[],
  intents: Proof[] = [],
  candidateIntents: string[] = [],
) {
  const value = (
    await f.runtime.query<{ result: Cleanup }>(
      "SELECT cleanup_guest_authority_v1($1,$2::text[],$3::text[],$4,$5::text[],$6::text[]) AS result",
      [
        origin,
        await proved(f.admin, carried, origin, true),
        await provedIntents(f, intents),
        selected,
        candidates,
        candidateIntents,
      ],
    )
  ).rows[0]?.result;
  if (!value) throw new Error("missing cleanup result");
  return value;
}
async function seedIntent(
  f: Fixture,
  source: string,
  credential: Proof,
  state: "live" | "elapsed" | "superseded",
) {
  const nonce = proof();
  const intent = { id: `gai_${nonce.id}`, digest: nonce.digest };
  await f.admin.query(
    `WITH instant AS (SELECT clock_timestamp() at)
    INSERT INTO guest_attachment_intents(intent_id,owner_id,credential_source_owner_id,credential_id,
      origin,nonce_digest,state,created_at,expires_at)
    SELECT $1,$2,$2,$3,$4,$5,'awaiting_account',at,at+INTERVAL '15 minutes' FROM instant`,
    [intent.id, source, credential.id, origin, intent.digest],
  );
  if (state === "superseded")
    await f.admin.query(
      "UPDATE guest_attachment_intents SET state='superseded' WHERE intent_id=$1",
      [intent.id],
    );
  if (state === "elapsed") {
    // Historical expiry setup belongs only to this owned fixture. Restore the
    // real guard before any runtime action, never set a runtime privilege flag.
    await f.admin.query("ALTER TABLE guest_attachment_intents DISABLE TRIGGER guest_intent_guard");
    try {
      await f.admin.query(
        `WITH historical AS (SELECT clock_timestamp()-INTERVAL '20 minutes' at)
        UPDATE guest_attachment_intents SET created_at=at,expires_at=at+INTERVAL '15 minutes'
        FROM historical WHERE intent_id=$1`,
        [intent.id],
      );
    } finally {
      await f.admin.query("ALTER TABLE guest_attachment_intents ENABLE TRIGGER guest_intent_guard");
    }
  }
  return intent;
}

suite("guest authority discovery and cleanup", () => {
  test("discovery creates no authority and null context does not select singleton or several owners", async () => {
    await fixture(async (f) => {
      expect((await discover(f, [])).state).toBe("absent");
      expect((await discover(f, [], null, owner(1), proof().id)).state).toBe("recovery_required");
      expect(
        (await f.admin.query("SELECT count(*)::int n FROM participation_owners")).rows,
      ).toEqual([{ n: 0 }]);
      const first = proof();
      const second = proof();
      await seed(f, 1, first, true);
      const before = await clocks(f, first.id);
      const singleton = await discover(f, [first]);
      expect(singleton.selected).toBeNull();
      expect(singleton.proved_credentials).toHaveLength(1);
      await seed(f, 2, second, true);
      expect((await discover(f, [first, second])).selected).toBeNull();
      const selected = await discover(f, [first, second], first.id, owner(1));
      expect(selected.selected?.owner_id).toBe(owner(1));
      await expect(discover(f, [first, second], first.id, owner(2))).rejects.toMatchObject({
        code: "GP002",
      });
      expect(await clocks(f, first.id)).toEqual(before);
      expect(
        (await f.admin.query("SELECT count(*)::int n FROM guest_participation_operations")).rows,
      ).toEqual([{ n: 2 }]);
      expect(
        (await f.admin.query("SELECT count(*)::int n FROM participation_owners")).rows,
      ).toEqual([{ n: 2 }]);
    });
  });

  test("proved rotation successor repairs old revoked pointer without changing lease or original source", async () => {
    await fixture(async (f) => {
      const old = proof();
      const successor = proof();
      await seed(f, 1, old, true);
      await result(
        f.admin,
        "SELECT issue_guest_rotation_v1($1,$2::text[],$3,$4,$5,$6,$7,$8,$9) AS result",
        [
          origin,
          await proved(f.admin, [old]),
          old.id,
          owner(1),
          "repair-rotate",
          requestHash,
          "repair-rotate-op",
          successor.id,
          successor.digest,
        ],
      );
      await result(
        f.admin,
        "SELECT acknowledge_guest_rotation_v1($1,$2::text[],$3,$4,$5) AS result",
        [origin, await proved(f.admin, [successor]), old.id, successor.id, owner(1)],
      );
      const before = await clocks(f, successor.id);
      const repaired = await discover(f, [old, successor], successor.id, owner(1), old.id);
      expect(repaired.pointer_repair).toEqual({
        previous_credential_id: old.id,
        credential_id: successor.id,
        owner_id: owner(1),
      });
      const oldHeader = await discover(f, [old, successor], old.id, owner(1), old.id);
      expect(oldHeader.selected?.credential_id).toBe(old.id);
      expect(oldHeader.selected?.credential_state).toBe("revoked");
      expect(oldHeader.pointer_repair).toEqual({
        previous_credential_id: old.id,
        credential_id: successor.id,
        owner_id: owner(1),
      });
      expect(await clocks(f, successor.id)).toEqual(before);
      expect(
        (
          await f.admin.query(
            "SELECT owner_id,state FROM guest_credentials WHERE credential_id=$1",
            [old.id],
          )
        ).rows,
      ).toEqual([{ owner_id: owner(1), state: "revoked" }]);
      expect((await discover(f, [old], old.id, owner(1), old.id)).pointer_repair).toBeNull();
      expect((await discover(f, [successor], null, owner(1), old.id)).selected).toBeNull();
      const other = proof();
      await seed(f, 2, other, true);
      await expect(
        discover(f, [successor, other], other.id, owner(1), old.id),
      ).rejects.toMatchObject({ code: "GP002" });
    });
  });

  test("cleanup confirmed EMPTY unselected candidate retains its audit while null singleton selection stays null", async () => {
    await fixture(async (f) => {
      const selected = proof();
      const candidate = proof();
      await seed(f, 1, selected, true);
      await seed(f, 2, candidate, true);
      const before = (
        await f.admin.query(
          "SELECT owner_id,origin,secret_digest,created_at::text,confirmed_at::text,session_until::text FROM guest_credentials WHERE credential_id=$1",
          [candidate.id],
        )
      ).rows;
      const cleaned = await cleanup(f, [selected, candidate], selected.id, [candidate.id]);
      expect(cleaned.authority.selected?.credential_id).toBe(selected.id);
      expect(cleaned.cookieEffects).toEqual([
        { kind: "credential", action: "expire", credentialId: candidate.id },
      ]);
      expect(
        (
          await f.admin.query(
            "SELECT owner_id,origin,secret_digest,created_at::text,confirmed_at::text,session_until::text FROM guest_credentials WHERE credential_id=$1",
            [candidate.id],
          )
        ).rows,
      ).toEqual(before);
      expect(
        (
          await f.admin.query(
            "SELECT state,revocation_reason FROM guest_credentials WHERE credential_id=$1",
            [candidate.id],
          )
        ).rows,
      ).toEqual([{ state: "revoked", revocation_reason: "empty_cleanup" }]);
      expect((await cleanup(f, [selected], null, [])).authority.selected).toBeNull();
      await expect(cleanup(f, [selected], selected.id, [selected.id])).rejects.toMatchObject({
        code: "GP003",
      });
    });
  });

  test("selected pending successor retains predecessor and unproved locators cannot receive expiry", async () => {
    await fixture(async (f) => {
      const predecessor = proof();
      const successor = proof();
      await seed(f, 1, predecessor, true);
      await result(
        f.admin,
        "SELECT issue_guest_rotation_v1($1,$2::text[],$3,$4,$5,$6,$7,$8,$9) AS result",
        [
          origin,
          await proved(f.admin, [predecessor]),
          predecessor.id,
          owner(1),
          "pending",
          requestHash,
          "pending-op",
          successor.id,
          successor.digest,
        ],
      );
      await expect(
        cleanup(f, [predecessor, successor], successor.id, [predecessor.id]),
      ).rejects.toMatchObject({ code: "GP003" });
      await expect(cleanup(f, [predecessor], null, [successor.id])).rejects.toMatchObject({
        code: "GP001",
      });
      expect(
        (
          await f.admin.query("SELECT state FROM guest_credentials WHERE credential_id=$1", [
            predecessor.id,
          ])
        ).rows,
      ).toEqual([{ state: "confirmed" }]);
    });
  });

  test("single-component zero check retains all five original child histories", async () => {
    for (const family of families) {
      await fixture(async (f) => {
        const root = proof();
        const child = proof();
        await seed(f, 1, root);
        await seed(f, 2, child);
        await result(f.admin, "SELECT confirm_guest_pending_v1($1,$2::text[],$3,$4) AS result", [
          origin,
          await proved(f.admin, [root, child]),
          child.id,
          owner(2),
        ]);
        await f.admin.query(`INSERT INTO ${family} VALUES('retained',$1,'guest')`, [owner(2)]);
        await expect(cleanup(f, [child], null, [child.id])).rejects.toMatchObject({
          code: "GP003",
        });
        expect(
          (await f.admin.query(`SELECT fixture_id,participation_owner_id FROM ${family}`)).rows,
        ).toEqual([{ fixture_id: "retained", participation_owner_id: owner(2) }]);
        expect(
          (
            await f.admin.query("SELECT state FROM guest_credentials WHERE credential_id=$1", [
              child.id,
            ])
          ).rows,
        ).toEqual([{ state: "confirmed" }]);
      });
    }
  }, 20000);

  test("non-aborted operation and live intent block active credential cleanup without partial mutation", async () => {
    await fixture(async (f) => {
      const active = proof();
      await seed(f, 1, active, true);
      await f.admin.query(
        `INSERT INTO guest_participation_operations(operation_id,source_owner_id,operation_kind,resource_scope,idempotency_key,request_hash,state,created_at)
        VALUES('uncertain-start',$1,'study_start','post','start-key',$2,'reserved',clock_timestamp())`,
        [owner(1), requestHash],
      );
      await expect(cleanup(f, [active], null, [active.id])).rejects.toMatchObject({
        code: "GP003",
      });
      expect(
        (
          await f.admin.query(
            "SELECT state FROM guest_participation_operations WHERE operation_id='uncertain-start'",
          )
        ).rows,
      ).toEqual([{ state: "reserved" }]);
    });
    await fixture(async (f) => {
      const eligible = proof();
      const live = proof();
      await seed(f, 1, eligible, true);
      await seed(f, 2, live, true);
      const intent = await seedIntent(f, owner(2), live, "live");
      await expect(
        cleanup(f, [eligible, live], null, [eligible.id, live.id], [intent], [intent.id]),
      ).rejects.toMatchObject({ code: "GP003" });
      expect(
        (await f.admin.query("SELECT state FROM guest_credentials ORDER BY credential_id")).rows,
      ).toEqual([{ state: "confirmed" }, { state: "confirmed" }]);
      expect(
        (
          await f.admin.query("SELECT state FROM guest_attachment_intents WHERE intent_id=$1", [
            intent.id,
          ])
        ).rows,
      ).toEqual([{ state: "awaiting_account" }]);
    });
  }, 10000);

  test("independently proved elapsed and superseded ceremony cookies expire while original audit survives", async () => {
    for (const terminal of ["elapsed", "superseded"] as const) {
      await fixture(async (f) => {
        const credential = proof();
        await seed(f, 1, credential, true);
        const intent = await seedIntent(f, owner(1), credential, terminal);
        const before = (
          await f.admin.query(
            "SELECT owner_id,credential_source_owner_id,credential_id,nonce_digest,target_revision,target_account_id,target_session_digest FROM guest_attachment_intents WHERE intent_id=$1",
            [intent.id],
          )
        ).rows;
        await expect(
          cleanup(f, [], null, [], [{ id: intent.id, digest: "b".repeat(64) }], [intent.id]),
        ).rejects.toMatchObject({ code: "GP001" });
        const expired = await cleanup(f, [], null, [], [intent], [intent.id]);
        expect(expired.cookieEffects).toEqual([
          { kind: "intent", action: "expire", intentId: intent.id },
        ]);
        expect(expired.authority.selected).toBeNull();
        expect(
          (
            await f.admin.query(
              "SELECT owner_id,credential_source_owner_id,credential_id,nonce_digest,target_revision,target_account_id,target_session_digest FROM guest_attachment_intents WHERE intent_id=$1",
              [intent.id],
            )
          ).rows,
        ).toEqual(before);
      });
    }
  }, 10000);

  test("already revoked proof-cookie expiry preserves retained source history", async () => {
    await fixture(async (f) => {
      const old = proof();
      const successor = proof();
      await seed(f, 1, old, true);
      await result(
        f.admin,
        "SELECT issue_guest_rotation_v1($1,$2::text[],$3,$4,$5,$6,$7,$8,$9) AS result",
        [
          origin,
          [old.id],
          old.id,
          owner(1),
          "history",
          requestHash,
          "history-op",
          successor.id,
          successor.digest,
        ],
      );
      await result(
        f.admin,
        "SELECT acknowledge_guest_rotation_v1($1,$2::text[],$3,$4,$5) AS result",
        [origin, [successor.id], old.id, successor.id, owner(1)],
      );
      await f.admin.query("UPDATE participation_owners SET state='established' WHERE owner_id=$1", [
        owner(1),
      ]);
      await f.admin.query("INSERT INTO study_sessions_v2 VALUES('retained',$1,'guest')", [
        owner(1),
      ]);
      const expired = await cleanup(f, [old], null, [old.id]);
      expect(expired.cookieEffects).toEqual([
        { kind: "credential", action: "expire", credentialId: old.id },
      ]);
      expect((await f.admin.query("SELECT fixture_id FROM study_sessions_v2")).rows).toEqual([
        { fixture_id: "retained" },
      ]);
      expect(
        (
          await f.admin.query("SELECT state FROM participation_owners WHERE owner_id=$1", [
            owner(1),
          ])
        ).rows,
      ).toEqual([{ state: "established" }]);
    });
  });

  test("sixteen exact proofs clean in one pass and seventeenth malformed context is refused", async () => {
    await fixture(async (f) => {
      const proofs: Proof[] = [];
      for (let n = 1; n <= 17; n++) {
        const p = proof();
        proofs.push(p);
        await seed(f, n, p);
      }
      await expect(
        f.runtime.query(
          "SELECT cleanup_guest_authority_v1($1,$2::text[],'{}',NULL,$2::text[],'{}')",
          [origin, proofs.map((p) => p.id)],
        ),
      ).rejects.toMatchObject({ code: "22023" });
      const cleaned = await cleanup(
        f,
        proofs.slice(0, 16),
        null,
        proofs.slice(0, 16).map((p) => p.id),
      );
      expect(cleaned.cookieEffects).toHaveLength(16);
      expect(cleaned.authority.selected).toBeNull();
      expect(
        (await f.admin.query("SELECT count(*)::int n FROM guest_credentials WHERE state='revoked'"))
          .rows,
      ).toEqual([{ n: 16 }]);
      expect(
        (
          await f.admin.query("SELECT state FROM guest_credentials WHERE credential_id=$1", [
            proofs[16]?.id,
          ])
        ).rows,
      ).toEqual([{ state: "pending_bootstrap" }]);
      // Parser-level 17 carried-cookie/header rejection remains a separate
      // transport test; this assertion covers only malformed trusted SQL context.
    });
  }, 10000);

  test("actual runtime gets only discover/cleanup execute and no helper or raw history permission", async () => {
    await fixture(async (f) => {
      for (const table of [...privateTables, ...families])
        await expect(f.runtime.query(`DELETE FROM ${table}`)).rejects.toMatchObject({
          code: "42501",
        });
      await expect(
        f.runtime.query("SELECT guest_authority_component_is_empty_v1($1)", [owner(1)]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        f.runtime.query("SELECT lock_guest_cleanup_components_v1($1,'{}','{}')", [origin]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        f.runtime.query("SELECT confirm_guest_pending_v1($1,'{}',$2,$3)", [
          origin,
          proof().id,
          owner(1),
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        f.runtime.query(`CREATE TABLE "${f.schema}".fake(id text)`),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(f.runtime.query("SET ROLE postgres")).rejects.toMatchObject({ code: "42501" });
    });
  });
});
