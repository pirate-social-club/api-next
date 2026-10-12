// Private authority transitions against an owned PostgreSQL fixture.
// Minimal five-family FK fixture proves transitions, not populated 0249 backfill.
import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { createConnection, createServer, type Socket } from "node:net";
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
  "issue_guest_pending_v1(text,text[],text,text,text,text,text,text,text)",
  "confirm_guest_pending_v1(text,text[],text,text)",
  "renew_guest_authority_v1(text,text[],text,text)",
  "issue_guest_rotation_v1(text,text[],text,text,text,text,text,text,text)",
  "acknowledge_guest_rotation_v1(text,text[],text,text,text)",
] as const;
const owner = (n: number) => `owner_00000000-0000-0000-0000-${n.toString().padStart(12, "0")}`;
const requestHash = "a".repeat(64);
type Proof = Readonly<{ id: string; digest: string }>;
function proof(): Proof {
  return {
    id: randomBytes(16).toString("base64url"),
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
): Promise<string[]> {
  const rows = await admin.query<{ credential_id: string }>(
    "SELECT credential_id FROM read_guest_credential_proof_matches_v1($1,$2::jsonb,FALSE)",
    [productOrigin, JSON.stringify(proofs.map((p) => ({ credentialId: p.id, digest: p.digest })))],
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
  const password = randomBytes(32).toString("hex");
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
async function issue(
  f: Fixture,
  n: number,
  p: Proof,
  key: string,
  carried: Proof[] = [],
  selected: string | null = null,
  hash = requestHash,
) {
  return result(
    f.runtime,
    "SELECT issue_guest_pending_v1($1,$2::text[],$3,$4,$5,$6,$7,$8,$9) AS result",
    [
      origin,
      await proved(f.admin, carried),
      selected,
      key,
      hash,
      `bootstrap-${key}`,
      owner(n),
      p.id,
      p.digest,
    ],
  );
}
async function confirm(f: Fixture, p: Proof, expectedOwner: string, carried: Proof[] = [p]) {
  return result(f.runtime, "SELECT confirm_guest_pending_v1($1,$2::text[],$3,$4) AS result", [
    origin,
    await proved(f.admin, carried),
    p.id,
    expectedOwner,
  ]);
}
async function rotate(
  f: Fixture,
  predecessor: Proof,
  expectedOwner: string,
  next: Proof,
  key: string,
  carried = [predecessor],
) {
  return result(
    f.runtime,
    "SELECT issue_guest_rotation_v1($1,$2::text[],$3,$4,$5,$6,$7,$8,$9) AS result",
    [
      origin,
      await proved(f.admin, carried),
      predecessor.id,
      expectedOwner,
      key,
      requestHash,
      `rotation-${key}`,
      next.id,
      next.digest,
    ],
  );
}
async function acknowledge(
  f: Fixture,
  predecessor: Proof,
  successor: Proof,
  expectedOwner: string,
  carried = [predecessor, successor],
) {
  return result(
    f.runtime,
    "SELECT acknowledge_guest_rotation_v1($1,$2::text[],$3,$4,$5) AS result",
    [origin, await proved(f.admin, carried), predecessor.id, successor.id, expectedOwner],
  );
}
async function clocks(f: Fixture, id: string) {
  return (
    await f.admin.query<{ confirmed: string; lease: string }>(
      "SELECT confirmed_at::text AS confirmed,session_until::text AS lease FROM guest_credentials WHERE credential_id=$1",
      [id],
    )
  ).rows[0];
}

// Plain local protocol proxy for a single owned connection. It observes the
// real backend COMMIT tag and idle ReadyForQuery, then destroys only this pair
// before forwarding those acknowledgments. No PostgreSQL/provider side effects
// are inferred from a timeout, and no production connection may be used here.
async function commitAckDropProxy(upstreamUrl: string) {
  const parsed = new URL(upstreamUrl);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname))
    throw new Error("COMMIT fault fixture requires owned loopback PostgreSQL");
  const sockets = new Set<Socket>();
  let armed = false;
  let sawCommit = false;
  let sawIdle = false;
  const server = createServer((downstream) => {
    const upstream = createConnection({
      host: parsed.hostname,
      port: Number(parsed.port || "5432"),
    });
    sockets.add(downstream);
    sockets.add(upstream);
    downstream.on("error", () => upstream.destroy());
    upstream.on("error", () => downstream.destroy());
    downstream.on("close", () => {
      sockets.delete(downstream);
      upstream.destroy();
    });
    upstream.on("close", () => {
      sockets.delete(upstream);
      downstream.destroy();
    });
    downstream.pipe(upstream);
    let pending = Buffer.alloc(0);
    upstream.on("data", (data: Buffer) => {
      pending = Buffer.concat([pending, data]);
      while (pending.length >= 5) {
        const length = pending.readUInt32BE(1);
        if (length < 4 || length > 16 * 1024 * 1024) {
          downstream.destroy();
          upstream.destroy();
          return;
        }
        if (pending.length < length + 1) return;
        const frame = pending.subarray(0, length + 1);
        pending = pending.subarray(length + 1);
        if (armed && frame[0] === 0x43 && frame.subarray(5).toString("utf8") === "COMMIT\0") {
          sawCommit = true;
          continue;
        }
        if (armed && sawCommit && frame[0] === 0x5a && frame[5] === 0x49) {
          sawIdle = true;
          downstream.destroy();
          upstream.destroy();
          return;
        }
        downstream.write(frame);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("proxy address missing");
  parsed.hostname = "127.0.0.1";
  parsed.port = String(address.port);
  parsed.searchParams.set("sslmode", "disable");
  return {
    connectionString: parsed.toString(),
    arm: () => {
      armed = true;
    },
    observed: () => ({ sawCommit, sawIdle }),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

suite("guest controlled browser authority transitions", () => {
  test("actual restricted LOGIN has only transition authority and trusted schema defeats pg_temp shadow", async () => {
    await fixture(async (f) => {
      for (const table of [...privateTables, ...families]) {
        await expect(f.runtime.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({
          code: "42501",
        });
        await expect(f.runtime.query(`DELETE FROM ${table}`)).rejects.toMatchObject({
          code: "42501",
        });
      }
      await expect(
        f.runtime.query("SELECT resolve_guest_empty_owner_root_v1($1)", [owner(1)]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        f.runtime.query("SELECT lock_guest_authority_sources_v1($1,'{}')", [origin]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        f.runtime.query(`CREATE TABLE "${f.schema}".shadow_test(id text)`),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(f.runtime.query("SET ROLE postgres")).rejects.toMatchObject({ code: "42501" });
      await f.runtime.query(
        "CREATE TEMP TABLE guest_credentials(credential_id TEXT); INSERT INTO guest_credentials VALUES('shadow'); SET search_path TO pg_temp," +
          `"${f.schema}"`,
      );
      const p = proof();
      const issued = await issue(f, 1, p, "shadow");
      expect(issued.authority?.selected?.credential_id).toBe(p.id);
      expect(
        (await f.admin.query("SELECT count(*)::int AS n FROM guest_credentials")).rows,
      ).toEqual([{ n: 1 }]);
      expect((await f.runtime.query("SELECT * FROM pg_temp.guest_credentials")).rows).toEqual([
        { credential_id: "shadow" },
      ]);
    });
  });

  test("empty convergence requires positive schema phase and refuses unreviewed owner history", async () => {
    await fixture(async (f) => {
      const first = proof();
      const second = proof();
      await issue(f, 1, first, "phase-first");
      await issue(f, 2, second, "phase-second");
      await f.admin.query("DELETE FROM guest_learning_schema_phase");
      await expect(confirm(f, second, owner(2), [first, second])).rejects.toMatchObject({
        code: "GP003",
      });
      await f.admin.query(
        "INSERT INTO guest_learning_schema_phase VALUES(TRUE,'practice_only_owner_history_v1')",
      );
      await f.admin.query(
        "CREATE TABLE unreviewed_financial_history(owner_id TEXT REFERENCES participation_owners(owner_id))",
      );
      await expect(confirm(f, second, owner(2), [first, second])).rejects.toMatchObject({
        code: "GP003",
      });
      expect(
        (await f.admin.query("SELECT count(*)::int AS n FROM guest_empty_owner_aliases")).rows,
      ).toEqual([{ n: 0 }]);
      await f.admin.query("DROP TABLE unreviewed_financial_history");
      await f.admin.query("CREATE TABLE megapot_owner_allocations(fixture_id TEXT)");
      await expect(confirm(f, second, owner(2), [first, second])).rejects.toMatchObject({
        code: "GP003",
      });
      await f.admin.query("DROP TABLE megapot_owner_allocations");
      expect(
        (await confirm(f, second, owner(2), [first, second])).authority?.selected?.owner_id,
      ).toBe(owner(1));
    });
  });

  test("digest-only issuance replay records immutable identity and never recreates a lost secret", async () => {
    await fixture(async (f) => {
      const first = proof();
      const replacement = proof();
      const created = await issue(f, 1, first, "receipt");
      expect(created.state).toBe("completed");
      expect(created.cookie_effects).toEqual([
        { kind: "credential", action: "issue", credentialId: first.id },
      ]);
      expect(JSON.stringify(created)).not.toContain(first.digest);
      const before = (
        await f.admin.query("SELECT to_jsonb(o) AS row FROM guest_participation_operations o")
      ).rows;
      const lost = await issue(f, 2, replacement, "receipt");
      expect(lost).toEqual({ state: "issuance_requires_restart" });
      const replay = await issue(f, 2, replacement, "receipt", [first]);
      expect(replay.operation_id).toBe(created.operation_id);
      expect(replay.cookie_effects).toEqual([]);
      expect(
        (await f.admin.query("SELECT to_jsonb(o) AS row FROM guest_participation_operations o"))
          .rows,
      ).toEqual(before);
      expect(
        (await f.admin.query("SELECT count(*)::int AS n FROM guest_credentials")).rows,
      ).toEqual([{ n: 1 }]);
      await expect(
        issue(f, 2, replacement, "receipt", [first], null, "b".repeat(64)),
      ).rejects.toMatchObject({ code: "GP005" });
      const existing = await issue(f, 2, replacement, "selected", [first], first.id);
      expect(existing.state).toBe("completed");
      expect(existing.operation_id).toBe("bootstrap-selected");
      expect(existing.cookie_effects).toEqual([]);
      expect(
        (await f.admin.query("SELECT count(*)::int AS n FROM participation_owners")).rows,
      ).toEqual([{ n: 1 }]);
    });
  });

  test("same-key replay cannot override explicit different source even when historical source is established", async () => {
    await fixture(async (f) => {
      const first = proof();
      const selected = proof();
      await issue(f, 1, first, "historical");
      await confirm(f, first, owner(1));
      await f.admin.query("UPDATE participation_owners SET state='established' WHERE owner_id=$1", [
        owner(1),
      ]);
      await issue(f, 2, selected, "other");
      const before = (
        await f.admin.query(
          "SELECT to_jsonb(c) AS row FROM guest_credentials c ORDER BY credential_id",
        )
      ).rows;
      await expect(
        issue(f, 3, proof(), "historical", [first, selected], selected.id),
      ).rejects.toMatchObject({ code: "GP002" });
      expect(
        (
          await f.admin.query(
            "SELECT to_jsonb(c) AS row FROM guest_credentials c ORDER BY credential_id",
          )
        ).rows,
      ).toEqual(before);
      expect(
        (await f.admin.query("SELECT count(*)::int AS n FROM participation_owners")).rows,
      ).toEqual([{ n: 2 }]);
    });
  });

  test("initial confirmation converges empty components and replay preserves provenance and exact lease", async () => {
    await fixture(async (f) => {
      const older = proof();
      const younger = proof();
      await issue(f, 1, older, "older");
      await issue(f, 2, younger, "younger");
      const confirmed = await confirm(f, younger, owner(2), [younger, older]);
      expect(confirmed.authority?.selected?.owner_id).toBe(owner(1));
      expect(
        (
          await f.admin.query("SELECT owner_id FROM guest_credentials WHERE credential_id=$1", [
            younger.id,
          ])
        ).rows,
      ).toEqual([{ owner_id: owner(2) }]);
      expect(
        (
          await f.admin.query(
            "SELECT source_owner_id,canonical_owner_id FROM guest_empty_owner_aliases",
          )
        ).rows,
      ).toEqual([{ source_owner_id: owner(2), canonical_owner_id: owner(1) }]);
      const before = await clocks(f, younger.id);
      await confirm(f, younger, owner(1), [younger, older]);
      expect(await clocks(f, younger.id)).toEqual(before);
      const sameRoot = await issue(f, 3, proof(), "older", [older, younger], younger.id);
      expect(sameRoot.operation_id).toBe("bootstrap-older");
      expect(sameRoot.cookie_effects).toEqual([]);
      await expect(confirm(f, younger, owner(2), [younger, older])).rejects.toMatchObject({
        code: "GP002",
      });
    });
  });

  test("co-present established source and preserved child history refuse automatic convergence", async () => {
    await fixture(async (f) => {
      const established = proof();
      const pending = proof();
      await issue(f, 1, established, "established");
      await confirm(f, established, owner(1));
      await f.admin.query("UPDATE participation_owners SET state='established' WHERE owner_id=$1", [
        owner(1),
      ]);
      await issue(f, 2, pending, "pending");
      await expect(confirm(f, pending, owner(2), [pending, established])).rejects.toMatchObject({
        code: "GP003",
      });
      expect(
        (
          await f.admin.query("SELECT state FROM guest_credentials WHERE credential_id=$1", [
            pending.id,
          ])
        ).rows,
      ).toEqual([{ state: "pending_bootstrap" }]);
    });
    for (const family of families) {
      await fixture(async (f) => {
        const root = proof();
        const child = proof();
        const other = proof();
        await issue(f, 1, root, "root");
        await issue(f, 2, child, "child");
        await confirm(f, child, owner(2), [root, child]);
        // Model preserved original child provenance even if root state was stale.
        // Exact owner FK remains valid. Root zero predicate must inspect members.
        await f.admin.query(`INSERT INTO ${family} VALUES('retained',$1,'guest')`, [owner(2)]);
        await issue(f, 3, other, "other");
        await expect(confirm(f, other, owner(3), [child, other])).rejects.toMatchObject({
          code: "GP003",
        });
        expect(
          (await f.admin.query(`SELECT fixture_id,participation_owner_id FROM ${family}`)).rows,
        ).toEqual([{ fixture_id: "retained", participation_owner_id: owner(2) }]);
      });
    }
  }, 20000);

  test("old unbound recovery proof renews deliberately while confirmed replay does not extend its lease", async () => {
    await fixture(async (f) => {
      const p = proof();
      await issue(f, 1, p, "old");
      await confirm(f, p, owner(1));
      // Isolated historical fixture seed only. Restore guard BEFORE runtime call.
      await f.admin.query("ALTER TABLE guest_credentials DISABLE TRIGGER guest_credential_guard");
      await f.admin.query(
        "ALTER TABLE participation_owners DISABLE TRIGGER participation_owner_guard",
      );
      try {
        await f.admin.query(
          "UPDATE participation_owners SET created_at=clock_timestamp()-INTERVAL '21 days' WHERE owner_id=$1",
          [owner(1)],
        );
        await f.admin.query(
          `WITH historical AS (SELECT clock_timestamp()-INTERVAL '20 days' AS at)
          UPDATE guest_credentials SET created_at=at,pending_expires_at=at+INTERVAL '15 minutes',
            confirmed_at=at+INTERVAL '1 minute',session_until=at+INTERVAL '61 minutes'
          FROM historical WHERE credential_id=$1`,
          [p.id],
        );
      } finally {
        await f.admin.query("ALTER TABLE guest_credentials ENABLE TRIGGER guest_credential_guard");
        await f.admin.query(
          "ALTER TABLE participation_owners ENABLE TRIGGER participation_owner_guard",
        );
      }
      expect(
        (
          await f.admin.query(
            "SELECT tgenabled FROM pg_trigger WHERE tgrelid='guest_credentials'::regclass AND tgname='guest_credential_guard'",
          )
        ).rows,
      ).toEqual([{ tgenabled: "O" }]);
      const before = await clocks(f, p.id);
      expect((await confirm(f, p, owner(1))).authority?.state).toBe("recovery_required");
      expect(await clocks(f, p.id)).toEqual(before);
      const renewed = await result(
        f.runtime,
        "SELECT renew_guest_authority_v1($1,$2::text[],$3,$4) AS result",
        [origin, await proved(f.admin, [p]), p.id, owner(1)],
      );
      expect(renewed.authority?.state).toBe("confirmed");
      expect(renewed.cookie_effects).toEqual([
        { kind: "credential", action: "refresh", credentialId: p.id },
      ]);
      expect(
        (
          await f.admin.query(
            "SELECT session_until>clock_timestamp() AND session_until<=clock_timestamp()+INTERVAL '1 hour' AS bounded FROM guest_credentials WHERE credential_id=$1",
            [p.id],
          )
        ).rows,
      ).toEqual([{ bounded: true }]);
      const after = await clocks(f, p.id);
      await confirm(f, p, owner(1));
      expect(await clocks(f, p.id)).toEqual(after);
    });
  });

  test("expired pending proof cannot become confirmed or turn a receipt replay into new issuance", async () => {
    await fixture(async (f) => {
      const p = proof();
      await issue(f, 1, p, "expired");
      await f.admin.query("ALTER TABLE guest_credentials DISABLE TRIGGER guest_credential_guard");
      try {
        await f.admin.query(
          `WITH historical AS (SELECT clock_timestamp()-INTERVAL '20 minutes' AS at)
          UPDATE guest_credentials SET created_at=at,pending_expires_at=at+INTERVAL '15 minutes'
          FROM historical WHERE credential_id=$1`,
          [p.id],
        );
      } finally {
        await f.admin.query("ALTER TABLE guest_credentials ENABLE TRIGGER guest_credential_guard");
      }
      await expect(confirm(f, p, owner(1))).rejects.toMatchObject({ code: "GP001" });
      const replay = await issue(f, 2, proof(), "expired", [p]);
      expect(replay).toEqual({ state: "issuance_requires_restart" });
      expect(
        (await f.admin.query("SELECT state FROM guest_credentials WHERE credential_id=$1", [p.id]))
          .rows,
      ).toEqual([{ state: "pending_bootstrap" }]);
      expect(
        (await f.admin.query("SELECT count(*)::int AS n FROM participation_owners")).rows,
      ).toEqual([{ n: 1 }]);
    });
  });

  test("rotation replaces only pending successor and acknowledgment revokes predecessor before confirmation", async () => {
    await fixture(async (f) => {
      const predecessor = proof();
      const first = proof();
      const second = proof();
      await issue(f, 1, predecessor, "start");
      await confirm(f, predecessor, owner(1));
      await rotate(f, predecessor, owner(1), first, "one");
      expect(await rotate(f, predecessor, owner(1), proof(), "one")).toEqual({
        state: "issuance_requires_restart",
      });
      const received = await rotate(f, predecessor, owner(1), proof(), "one", [predecessor, first]);
      expect(received.cookie_effects).toEqual([]);
      await rotate(f, predecessor, owner(1), second, "two", [predecessor, first]);
      expect(
        (
          await f.admin.query(
            "SELECT state,revocation_reason FROM guest_credentials WHERE credential_id=$1",
            [first.id],
          )
        ).rows,
      ).toEqual([{ state: "revoked", revocation_reason: "successor_superseded" }]);
      expect(
        (
          await f.admin.query("SELECT state FROM guest_credentials WHERE credential_id=$1", [
            predecessor.id,
          ])
        ).rows,
      ).toEqual([{ state: "confirmed" }]);
      await expect(acknowledge(f, predecessor, first, owner(1))).rejects.toMatchObject({
        code: "GP001",
      });
      // Existing partial uniqueness means confirming second before predecessor
      // revocation would fail 23505. Successful ack proves the required order.
      await expect(acknowledge(f, first, second, owner(1), [second])).rejects.toMatchObject({
        code: "GP002",
      });
      // Frozen028 accepts the correctly proved successor alone. Stored linked
      // predecessor must still be confirmed under the same component locks.
      await acknowledge(f, predecessor, second, owner(1), [second]);
      expect(
        (
          await f.admin.query(
            "SELECT state,revocation_reason FROM guest_credentials WHERE credential_id=$1",
            [predecessor.id],
          )
        ).rows,
      ).toEqual([{ state: "revoked", revocation_reason: "rotation_acknowledged" }]);
      const lease = await clocks(f, second.id);
      const replay = await acknowledge(f, predecessor, second, owner(1), [second]);
      expect(replay.cookie_effects).toEqual([]);
      expect(await clocks(f, second.id)).toEqual(lease);
      await expect(rotate(f, predecessor, owner(1), proof(), "late")).rejects.toMatchObject({
        code: "GP001",
      });
      expect(
        (
          await f.admin.query(
            "SELECT count(*)::int AS n FROM guest_credentials WHERE state='confirmed'",
          )
        ).rows,
      ).toEqual([{ n: 1 }]);
    });
  });

  test("exclusive topology lock timeout is internal and does not create an issuance fact", async () => {
    await fixture(async (f) => {
      await f.admin.query("BEGIN");
      try {
        await f.admin.query("SELECT pg_advisory_xact_lock(83000003,1)");
        await expect(issue(f, 1, proof(), "blocked")).rejects.toMatchObject({ code: "55P03" });
        expect(
          (await f.admin.query("SELECT count(*)::int AS n FROM guest_participation_operations"))
            .rows,
        ).toEqual([{ n: 0 }]);
      } finally {
        await f.admin.query("ROLLBACK");
      }
      const accepted = await issue(f, 1, proof(), "blocked");
      expect(accepted.state).toBe("completed");
    });
  });

  test("actual committed issuance with lost COMMIT acknowledgment reconciles exact receipt without new secret", async () => {
    await fixture(async (f) => {
      const proxy = await commitAckDropProxy(f.runtimeUrl);
      const uncertain = new Client({
        connectionString: proxy.connectionString,
        ssl: false,
        connectionTimeoutMillis: 3000,
        query_timeout: 3000,
      });
      uncertain.on("error", () => undefined);
      try {
        await uncertain.connect();
        await uncertain.query(
          `SET search_path TO "${f.schema}"; SET lock_timeout='250ms'; SET statement_timeout='3s'; BEGIN`,
        );
        const p = proof();
        const statementResult = await result(
          uncertain,
          "SELECT issue_guest_pending_v1($1,'{}'::text[],NULL,$2,$3,$4,$5,$6,$7) AS result",
          [origin, "lost-commit", requestHash, "lost-commit-operation", owner(1), p.id, p.digest],
        );
        expect(statementResult.state).toBe("completed");
        expect(
          (await f.admin.query("SELECT count(*)::int AS n FROM guest_secret_issuance_operations"))
            .rows,
        ).toEqual([{ n: 0 }]);
        proxy.arm();
        await expect(uncertain.query("COMMIT")).rejects.toBeInstanceOf(Error);
        expect(proxy.observed()).toEqual({ sawCommit: true, sawIdle: true });
        expect(
          (await f.admin.query("SELECT credential_id FROM guest_secret_issuance_operations")).rows,
        ).toEqual([{ credential_id: p.id }]);
        const noProof = await issue(f, 2, proof(), "lost-commit");
        expect(noProof).toEqual({ state: "issuance_requires_restart" });
        const recovered = await issue(f, 2, proof(), "lost-commit", [p]);
        expect(recovered.operation_id).toBe("lost-commit-operation");
        expect(recovered.cookie_effects).toEqual([]);
        expect(
          (await f.admin.query("SELECT count(*)::int AS n FROM guest_credentials")).rows,
        ).toEqual([{ n: 1 }]);
        // This raw-pg fault proves SQL facts after real acknowledgment loss.
        // It does NOT assert the frozen transaction-unknown adapter class or
        // controller cookie suppression; those need separate adapter tests.
      } finally {
        await uncertain.end().catch(() => undefined);
        await proxy.close();
      }
    });
  });
});
