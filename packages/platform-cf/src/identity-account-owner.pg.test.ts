// REVIEW PROPOSAL ONLY: root must adopt/review before the maintained owned PG gate.
// Reconstruct genuine0001..0250; no regenerated baseline or immutable-guard bypass.
import { describe, expect, test } from "bun:test";
import type { IdentityAccountDocument } from "@pirate/application/use-cases/identity-account";
import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Client } from "pg";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import {
  type IdentityRegistrationInput,
  makeControlPlaneIdentityRepository,
} from "./identity-repository.ts";
import { type ControlPlaneDb, makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import type { PostgresMigration } from "./postgres-migrations.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = url ? describe : describe.skip;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const OwnerId = Schema.String.check(
  Schema.isPattern(/^owner_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
);
const Owner = Schema.Struct({
  owner: OwnerId,
  account: Schema.String,
  kind: Schema.Literal("account"),
  state: Schema.Literals(["empty", "established"]),
  created: Schema.String,
});
type Fixture = Readonly<{
  admin: Client;
  runtime: Client;
  scoped: string;
  role: string;
  ownerRole: string;
}>;
async function result<A>(
  client: Client,
  text: string,
  values: unknown[],
  schema: Schema.ConstraintDecoder<A>,
): Promise<A> {
  const response = await client.query(text, values);
  if (response.rows.length !== 1) throw new Error("expected one owned-fixture row");
  const envelope = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Unknown }), {
    onExcessProperty: "error",
  })(response.rows[0]);
  return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(envelope.result);
}
async function code(action: Promise<unknown>) {
  try {
    await action;
  } catch (error) {
    return Schema.decodeUnknownSync(Schema.Struct({ code: Schema.String }))(error).code;
  }
  throw new Error("expected SQL refusal");
}
async function typedFailure<A, E>(effect: Effect.Effect<A, E, never>) {
  const exit = await Effect.runPromiseExit(effect);
  if (!Exit.isFailure(exit)) throw new Error("expected repository failure");
  const error = Cause.findErrorOption(exit.cause);
  if (!Option.isSome(error)) throw new Error("expected typed repository failure");
  return error.value;
}
const account = (userId: string, label: string): IdentityAccountDocument => ({
  user: {
    user_id: userId,
    primary_wallet_attachment_id: null,
    capability_provider: null,
    verification_capabilities_json: null,
    verified_at: null,
    created_at: "2026-10-12T00:00:00.000Z",
  },
  profile: {
    user_id: userId,
    display_name: "Captain",
    bio: null,
    bio_source: "none",
    avatar_ref: null,
    avatar_source: "none",
    cover_ref: null,
    cover_source: "none",
    preferred_locale: "en",
    display_verified_nationality_badge: 0,
    global_handle_id: `handle-${userId}`,
    primary_linked_handle_id: null,
    xmtp_inbox_id: null,
    created_at: "2026-10-12T00:00:00.000Z",
  },
  global_handle: {
    global_handle_id: `handle-${userId}`,
    label_display: `${label}.pirate`,
    status: "active",
    tier: "generated",
    issuance_source: "generated_signup",
    redirect_target_global_handle_id: null,
    price_paid_cents: null,
    free_rename_consumed: 0,
    issued_at: "2026-10-12T00:00:00.000Z",
    replaced_at: null,
  },
  linked_handles: [],
  wallet_attachments: [],
  onboarding: {
    generated_handle_assigned: true,
    cleanup_rename_available: false,
    unique_human_verification_status: "not_started",
    namespace_verification_status: "not_started",
    community_creation_ready: false,
    missing_requirements: [],
    reddit_verification_status: "not_started",
    reddit_import_status: "not_started",
  },
});
function input(
  userId: string,
  suffix = userId,
  subject = `did:privy:${suffix}`,
): IdentityRegistrationInput {
  return {
    provider: "privy",
    providerAppId: "owned-owner-fixture",
    providerSubject: subject,
    credentialId: `credential-${suffix}`,
    userId,
    account: account(userId, `generated-${userId}`),
  };
}
async function migrations() {
  const directory = new URL("../../../db/postgres/migrations/", import.meta.url);
  const manifest = Schema.decodeUnknownSync(
    Schema.Struct({
      algorithm: Schema.Literal("sha256"),
      migrations: Schema.Record(Schema.String, Schema.String),
    }),
  )(JSON.parse(await readFile(new URL("checksums.json", directory), "utf8")));
  const names = (await readdir(directory))
    .filter((n) => /^\d{4}_.+\.sql$/u.test(n) && Number(n.slice(0, 4)) <= 250)
    .sort();
  expect(names.map((n) => Number(n.slice(0, 4)))).toEqual(
    Array.from({ length: 250 }, (_, i) => i + 1),
  );
  expect(names[246]).toBe("0247_karaoke_instrumental_qualification_policy.sql");
  expect(names[247]).toBe("0248_guest_learning_authority_foundation.sql");
  expect(names[248]).toBe("0249_study_participation_owner_preservation.sql");
  expect(names[249]).toBe("0250_guest_browser_authority_transitions.sql");
  const packet: PostgresMigration[] = [];
  for (const version of names) {
    const sql = await readFile(new URL(version, directory), "utf8");
    const checksum = sha256(sql);
    const expectedChecksum = manifest.migrations[version];
    if (Number(version.slice(0, 4)) <= 247 && expectedChecksum === undefined)
      throw new Error("Immutable migration checksum missing");
    if (expectedChecksum !== undefined) expect(checksum).toBe(expectedChecksum);
    packet.push({ version, sql, checksum });
  }
  return { historical: packet.slice(0, 247), foundation: packet.slice(247) };
}
async function fixture(use: (f: Fixture) => Promise<void>) {
  if (!url) throw new Error("owned PG URL absent");
  const packet = await migrations();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const schema = `identity_owner_${suffix}`;
  const role = `identity_owner_login_${suffix}`;
  const password = Array.from(randomBytes(32), (b) => b.toString(16).padStart(2, "0")).join("");
  const admin = new Client({
    connectionString: url,
    connectionTimeoutMillis: 3000,
    query_timeout: 15000,
  });
  let runtime: Client | undefined;
  let createdRole = false;
  await admin.connect();
  const scoped = new URL(url);
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  try {
    await admin.query(`CREATE SCHEMA ${quote(schema)}; SET search_path TO ${quote(schema)}`);
    await runPostgresMigrations({
      connectionString: scoped.toString(),
      migrations: packet.historical,
      expectedLedger: [],
    });
    const command = await result(
      admin,
      "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD %L',$1::name,$2::text) AS result",
      [role, password],
      Schema.String,
    );
    await admin.query(command);
    createdRole = true;
    // Existing account writer permissions only. Deliberately broad new default
    // grants must be removed by actual0248/0249 private binders, as in production.
    await admin.query(`GRANT USAGE ON SCHEMA ${quote(schema)} TO ${quote(role)};
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${quote(schema)} TO ${quote(role)};
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${quote(schema)} TO ${quote(role)};
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${quote(schema)} GRANT ALL ON TABLES TO ${quote(role)};
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${quote(schema)} GRANT EXECUTE ON FUNCTIONS TO ${quote(role)}`);
    await runPostgresMigrations({
      connectionString: scoped.toString(), // Actual250 supplies its accepted SECURITY DEFINER deferred validator;
      // no fixture ALTER or raw participation_owners privilege workaround.
      migrations: packet.foundation,
      expectedLedger: packet.historical.map(({ version, checksum }) => ({ version, checksum })),
    });
    await admin.query(
      `GRANT EXECUTE ON FUNCTION provision_account_participation_owner_v1(text) TO ${quote(role)}`,
    );
    const runtimeUrl = new URL(scoped);
    runtimeUrl.username = role;
    runtimeUrl.password = password;
    runtime = new Client({
      connectionString: runtimeUrl.toString(),
      connectionTimeoutMillis: 3000,
      query_timeout: 3000,
    });
    await runtime.connect();
    const identity = await result(
      runtime,
      "SELECT jsonb_build_object('current',current_user,'session',session_user) AS result",
      [],
      Schema.Struct({ current: Schema.String, session: Schema.String }),
    );
    expect(identity).toEqual({ current: role, session: role });
    const ownerRole = await result(admin, "SELECT current_user AS result", [], Schema.String);
    process.stdout.write(
      `${JSON.stringify({
        fixture: "identity-owner-restricted-login",
        roleSha256: sha256(role),
        currentEqualsSession: true,
        genuineHistoricalMigrations: 247,
        actualOwnerMigrations: 3,
      })}\n`,
    );
    await use({ admin, runtime, scoped: runtimeUrl.toString(), role, ownerRole });
  } finally {
    if (runtime) {
      await runtime.query("ROLLBACK").catch(() => undefined);
      await runtime.end().catch(() => undefined);
    }
    await admin.query("ROLLBACK").catch(() => undefined);
    await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
    if (createdRole) await admin.query(`DROP OWNED BY ${quote(role)}; DROP ROLE ${quote(role)}`);
    await admin.end();
  }
}
async function mapping(f: Fixture, accountId: string) {
  return result(
    f.admin,
    `SELECT COALESCE(jsonb_agg(jsonb_build_object('owner',owner_id,'account',account_id,
    'kind',kind,'state',state,'created',created_at::text) ORDER BY owner_id COLLATE "C"),'[]'::jsonb) AS result
    FROM participation_owners WHERE kind='account' AND account_id=$1`,
    [accountId],
    Schema.Array(Owner),
  );
}
async function footprint(f: Fixture, userId: string) {
  return result(
    f.admin,
    `SELECT jsonb_build_object(
    'users',(SELECT count(*) FROM users WHERE user_id=$1),
    'owners',(SELECT count(*) FROM participation_owners WHERE kind='account' AND account_id=$1),
    'credentials',(SELECT count(*) FROM identity_credentials WHERE canonical_user_id=$1),
    'pendingHandles',(SELECT count(*) FROM persona_pending_first_handles h JOIN personas p USING(persona_id) WHERE p.account_id=$1),
    'ageAssertions',(SELECT count(*) FROM account_minimum_age_attestations WHERE account_id=$1)) AS result`,
    [userId],
    Schema.Struct({
      users: Schema.Number,
      owners: Schema.Number,
      credentials: Schema.Number,
      pendingHandles: Schema.Number,
      ageAssertions: Schema.Number,
    }),
  );
}

suite("genuine PostgreSQL account-creation owner admission", () => {
  test("new account and owner commit together; replay preserves owner; later conflicts/handle refusal roll both back; aliases cannot reparent original maps", async () => {
    await fixture(async (f) => {
      const repository = makeControlPlaneIdentityRepository();
      const transactionTraces: string[][] = [];
      const runtime = makeDirectPostgresControlPlaneLayer(f.scoped, {
        clientFactory: (connectionString, config) => {
          const client = new Client({ ...config, connectionString });
          const texts: string[] = [];
          transactionTraces.push(texts);
          return {
            connect: async () => {
              await client.connect();
            },
            end: async () => {
              await client.end();
            },
            query: async (query) => {
              // Capture SQL text only, never account/credential parameter data.
              texts.push(query.text);
              return client.query(query.text, [...(query.values ?? [])]);
            },
          };
        },
      });
      const run = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
        Effect.scoped(Effect.provide(runtime)(effect));
      const createdInput = input("created");
      expect(
        await Effect.runPromise(run(repository.registerCredential(createdInput))),
      ).toMatchObject({ kind: "created", canonicalUserId: "created" });
      const original = await mapping(f, "created");
      expect(original).toHaveLength(1);
      expect(await footprint(f, "created")).toMatchObject({
        users: 1,
        owners: 1,
        credentials: 1,
        ageAssertions: 0,
      });
      const same = await result(
        f.runtime,
        "SELECT provision_account_participation_owner_v1($1) AS result",
        ["created"],
        OwnerId,
      );
      expect(same).toBe(original[0]?.owner);
      const replayInput = input("replay-candidate", "replay", createdInput.providerSubject);
      expect(
        await Effect.runPromise(run(repository.registerCredential(replayInput))),
      ).toMatchObject({ kind: "already_registered", canonicalUserId: "created" });
      expect(await mapping(f, "created")).toEqual(original);
      expect(await footprint(f, "replay-candidate")).toEqual({
        users: 0,
        owners: 0,
        credentials: 0,
        pendingHandles: 0,
        ageAssertions: 0,
      });

      // Existing credential ID belongs to another subject: failure occurs AFTER
      // successful candidate users INSERT + provision, then owning TX rolls back.
      const conflict = { ...input("rollback-candidate"), credentialId: createdInput.credentialId };
      expect(await Effect.runPromise(run(repository.registerCredential(conflict)))).toEqual({
        kind: "candidate_collision",
        field: "credential_id",
      });
      expect(await footprint(f, "rollback-candidate")).toEqual({
        users: 0,
        owners: 0,
        credentials: 0,
        pendingHandles: 0,
        ageAssertions: 0,
      });
      expect(await mapping(f, "created")).toEqual(original);
      // User ID conflict precedes owner provisioning and never remaps a winner.
      expect(
        await Effect.runPromise(
          run(repository.registerCredential(input("created", "other-subject"))),
        ),
      ).toEqual({ kind: "candidate_collision", field: "user_id" });
      expect(await mapping(f, "created")).toEqual(original);

      // upsert has a genuine later stable-handle authority refusal. A fresh user
      // has no accepted active persona-owned public handle, so the new mapping
      // must roll back with that user; no forged persona/handle is seeded.
      expect(
        await typedFailure(
          run(
            repository.upsertAccount({
              userId: "upsert-rollback",
              account: account("upsert-rollback", "upsert-rollback"),
            }),
          ),
        ),
      ).toMatchObject({ _tag: "IdentityRepositoryError", reason: "invalid" });
      expect(await footprint(f, "upsert-rollback")).toEqual({
        users: 0,
        owners: 0,
        credentials: 0,
        pendingHandles: 0,
        ageAssertions: 0,
      });

      // Two actual concurrent registrations serialize before credentials/rows,
      // admit one account, then return its persisted identity without new map.
      const contenders = [
        input("concurrent-a", "concurrent-a", "did:privy:shared-owner"),
        input("concurrent-b", "concurrent-b", "did:privy:shared-owner"),
      ];
      const outcomes = await Promise.all(
        contenders.map((candidate) =>
          Effect.runPromise(run(repository.registerCredential(candidate))),
        ),
      );
      expect(outcomes.map((o) => o.kind).sort()).toEqual(["already_registered", "created"]);
      const winners = outcomes.flatMap((o) => ("canonicalUserId" in o ? [o.canonicalUserId] : []));
      expect(new Set(winners).size).toBe(1);
      for (const candidate of contenders) {
        expect(await footprint(f, candidate.userId)).toMatchObject({
          users: candidate.userId === winners[0] ? 1 : 0,
          owners: candidate.userId === winners[0] ? 1 : 0,
          credentials: candidate.userId === winners[0] ? 1 : 0,
          ageAssertions: 0,
        });
      }

      // Active source aliases, in-progress/finished merges, and dangling targets
      // are not canonical admission. Existing original maps remain immutable.
      expect(
        await Effect.runPromise(run(repository.registerCredential(input("canonical")))),
      ).toMatchObject({ kind: "created" });
      const canonicalMap = await mapping(f, "canonical");
      for (const [kind, status, target] of [
        ["alias", "active", "canonical"],
        ["merge", "finalizing", "canonical"],
        ["merge", "completed", "canonical"],
        ["alias", "active", "missing-target"],
      ]) {
        await f.admin.query(
          "INSERT INTO account_aliases(source_user_id,canonical_user_id,kind,status) VALUES($1,$2,$3,$4) ON CONFLICT(source_user_id) DO UPDATE SET canonical_user_id=EXCLUDED.canonical_user_id,kind=EXCLUDED.kind,status=EXCLUDED.status",
          ["created", target, kind, status],
        );
        expect(
          await code(
            f.runtime.query("SELECT provision_account_participation_owner_v1($1)", ["created"]),
          ),
        ).toBe("P0001");
        expect(await mapping(f, "created")).toEqual(original);
        expect(await mapping(f, "canonical")).toEqual(canonicalMap);
      }
      expect(
        await code(
          f.runtime.query("SELECT provision_account_participation_owner_v1('missing-account')"),
        ),
      ).toBe("P0001");
      // Fresh deleted-status fixture row exercises admission refusal without
      // invoking or altering the application's account-deletion/network path.
      await f.admin.query("INSERT INTO users(user_id,status) VALUES('inactive-account','deleted')");
      expect(
        await code(
          f.runtime.query("SELECT provision_account_participation_owner_v1('inactive-account')"),
        ),
      ).toBe("P0001");
      expect(await mapping(f, "inactive-account")).toEqual([]);
      // The actual alias relation has no users FK. Even a pre-existing alias for
      // a proposed new user must make new users+owner admission abort atomically.
      await f.admin.query(
        "INSERT INTO account_aliases(source_user_id,canonical_user_id,kind,status) VALUES('prealiased','canonical','alias','active')",
      );
      expect(
        await typedFailure(run(repository.registerCredential(input("prealiased")))),
      ).toMatchObject({ _tag: "ControlPlaneStatementFailed", sqlState: "P0001" });
      expect(await footprint(f, "prealiased")).toEqual({
        users: 0,
        owners: 0,
        credentials: 0,
        pendingHandles: 0,
        ageAssertions: 0,
      });

      // This is an actual nonowner login, not SET ROLE on a migration-owner
      // connection. Its only new private owner function grant is provision.
      expect(await code(f.runtime.query("SELECT * FROM participation_owners"))).toBe("42501");
      expect(await code(f.runtime.query("DELETE FROM participation_owners WHERE FALSE"))).toBe(
        "42501",
      );
      expect(
        await code(
          f.runtime.query("SELECT require_existing_account_participation_owner_v1('canonical')"),
        ),
      ).toBe("42501");
      expect(
        await code(
          f.runtime.query(
            "SELECT resolve_guest_empty_owner_root_v1('owner_00000000-0000-0000-0000-000000000001')",
          ),
        ),
      ).toBe("42501");
      expect(await code(f.runtime.query(`SET ROLE ${quote(f.ownerRole)}`))).toBe("42501");
      expect(await code(f.runtime.query("CREATE TABLE runtime_must_not_create(x integer)"))).toBe(
        "42501",
      );
      const grants = await result(
        f.admin,
        `SELECT jsonb_build_object(
        'provision',has_function_privilege($1,'provision_account_participation_owner_v1(text)','EXECUTE'),
        'existing',has_function_privilege($1,'require_existing_account_participation_owner_v1(text)','EXECUTE'),
        'raw',has_table_privilege($1,'participation_owners','SELECT')) AS result`,
        [f.role],
        Schema.Struct({ provision: Schema.Boolean, existing: Schema.Boolean, raw: Schema.Boolean }),
      );
      expect(grants).toEqual({ provision: true, existing: false, raw: false });
      const barrier = "SELECT pg_advisory_xact_lock(83000003,1)";
      const ownerCall = "SELECT provision_account_participation_owner_v1($1) AS owner_id";
      const creationTraces = transactionTraces.filter((texts) =>
        texts.some((text) => text.includes("INSERT INTO users")),
      );
      expect(creationTraces.length).toBeGreaterThan(0);
      for (const texts of transactionTraces.filter((texts) => texts.includes("BEGIN"))) {
        const firstBusiness = texts.find(
          (text) =>
            !["BEGIN", "COMMIT", "ROLLBACK"].includes(text) &&
            !text.startsWith("SELECT set_config("),
        );
        expect(firstBusiness).toBe(barrier);
      }
      for (const texts of creationTraces) {
        const inserted = texts.findIndex((text) => text.includes("INSERT INTO users"));
        expect(texts.indexOf(barrier)).toBeLessThan(inserted);
        if (texts.includes(ownerCall)) expect(texts.indexOf(ownerCall)).toBe(inserted + 1);
        // User-id collision is a known rollback before helper; successful
        // creations and later credential/handle refusals call helper in same TX.
        expect(texts.at(-1) === "COMMIT" || texts.includes("ROLLBACK")).toBe(true);
      }
    });
  }, 240000);
});
