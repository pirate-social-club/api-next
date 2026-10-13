// REVIEW PROPOSAL ONLY. Intended apps/http-worker/src placement after root review.
// Actual private composition, decoder, crypto, proof reader and SQL stores.
// No route installation, definition flip, provider call or funded operation.
import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import {
  BadRequest,
  GuestAttachmentIntentV1,
  GuestAuthError,
  GuestAuthorityV1,
  GuestCleanupAuthorityV1,
  GuestConflict,
  GuestPendingConflict,
  guestParticipationRegistry,
} from "@pirate/contracts";
import { digestGuestProof } from "@pirate/platform-cf/guest-proof-crypto";
import { makeControlPlaneIdentityStore } from "@pirate/platform-cf/identity-repository";
import { makeSessionCrypto } from "@pirate/platform-cf/session-crypto";
import { makeRs256SessionTokenVerifier } from "@pirate/platform-cf/session-tokens";
import { Schema } from "effect";
import { Context } from "hono";
import { Client } from "pg";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresClientFactory,
} from "../../../packages/platform-cf/src/postgres.ts";
import type { PostgresMigration } from "../../../packages/platform-cf/src/postgres-migrations.ts";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import {
  guestAccountingNames,
  guestLearningNames,
} from "./guest-authority-controller-composition.ts";
import type { GuestAuthorityControllerName } from "./guest-authority-controllers.ts";
import { makeGuestAuthorityPrivateComposition } from "./guest-authority-private-composition.ts";
import { decodeInput, type EndpointHandlerResult } from "./transport.ts";

type DecoderEnv = Parameters<typeof decodeInput>[1] extends Context<infer E> ? E : never;

const pgUrl = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !pgUrl)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = pgUrl ? describe : describe.skip;
const origin = "https://community.example";
const ordinaryScope = "owned-guest-controller-ordinary-v1";
const q = (value: string) => `"${value.replaceAll('"', '""')}"`;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const approved = [
  "read_guest_browser_proof_snapshot_v1(text,jsonb,jsonb,boolean)",
  "read_guest_learning_lease_observation_v1(text,text,text)",
  "discover_guest_authority_v1(text,text[],text,text,text)",
  "issue_guest_pending_v1(text,text[],text,text,text,text,text,text,text)",
  "confirm_guest_pending_v1(text,text[],text,text)",
  "renew_guest_authority_v1(text,text[],text,text)",
  "issue_guest_rotation_v1(text,text[],text,text,text,text,text,text,text)",
  "acknowledge_guest_rotation_v1(text,text[],text,text,text)",
  "cleanup_guest_authority_v1(text,text[],text[],text,text[],text[])",
  "create_guest_attachment_intent_v1(text,text[],text,text,text[],text,text,text,text,text)",
] as const;
const forbidden = [
  "lock_guest_authority_sources_v1(text,text[])",
  "require_guest_learning_runtime_role_v1(regrole)",
  "require_guest_practice_only_schema_phase_v1()",
  "prepare_guest_attachment_target_v1(text,text[],text,text,text[],text,text,text)",
  "validate_guest_alias_state_v1()",
] as const;

const privateChecksums: Readonly<Record<string, string>> = {
  "0248_guest_learning_authority_foundation.sql":
    "2c99571cedbe0640733b3509c657e81d4a89f505ba6d3fed61ea7e0c4befaed1",
  "0249_study_participation_owner_preservation.sql":
    "8c3578dcbbbdf929fb412e4493e6e16ab5d2af0fe13d518bd3f582892cd0c732",
  "0250_guest_browser_authority_transitions.sql":
    "c025474320a4bc244d974929415fed95ad26b22d0e2cf9657fbd2f328ddafcf9",
  "0251_guest_learning_resource_reservations.sql":
    "2de6e6508ec498a616b2db85ceafef1e2dbde7323a060cfae9956d0353d1aae4",
  "0252_guest_learning_controlled_row_admission.sql":
    "fc49e0678b1a14430455b29c9f1079c10fe8ee6408724edcbad110cd22b9ea7f",
  "0253_learner_audio_deletion_fence.sql":
    "27ce4e1c6e3185badb27e23bad96b84a3c9c5a226c7678d736d05072138f6cdb",
  "0254_guest_prepared_study_session_capture.sql":
    "2c5d3a799eba282ce4c4993f70f86276372424b8dfcc2946a0dfee457c1b2ad3",
  "0255_guest_spoken_success_checkpoints.sql":
    "fb7e3519edf7df95ef8071aaeced8d22509c146edce2f2d0b85d146b06051a2b",
};

async function migrationPacket() {
  const directory = new URL("../../../db/postgres/migrations/", import.meta.url);
  const manifest = Schema.decodeUnknownSync(
    Schema.Struct({
      algorithm: Schema.Literal("sha256"),
      migrations: Schema.Record(Schema.String, Schema.String),
    }),
  )(JSON.parse(await readFile(new URL("checksums.json", directory), "utf8")));
  const names = (await readdir(directory))
    .filter((n) => /^\d{4}_.+\.sql$/u.test(n) && Number(n.slice(0, 4)) <= 255)
    .sort();
  expect(names.map((n) => Number(n.slice(0, 4)))).toEqual(
    Array.from({ length: 255 }, (_, i) => i + 1),
  );
  expect(names[246]).toBe("0247_karaoke_instrumental_qualification_policy.sql");
  expect(names[254]).toBe("0255_guest_spoken_success_checkpoints.sql");
  const packet: PostgresMigration[] = [];
  for (const version of names) {
    const sql = await readFile(new URL(version, directory), "utf8");
    const checksum = sha(sql),
      declared = manifest.migrations[version];
    if (Number(version.slice(0, 4)) <= 247 && declared === undefined)
      throw new Error("Immutable historical checksum absent");
    if (declared !== undefined) expect(checksum).toBe(declared);
    if (Number(version.slice(0, 4)) >= 248) {
      const expectedPrivateChecksum = privateChecksums[version];
      if (expectedPrivateChecksum === undefined)
        throw new Error("Private migration checksum binding absent");
      expect(checksum).toBe(expectedPrivateChecksum);
    }
    packet.push({ version, sql, checksum });
  }
  return packet;
}
function pem(bytes: ArrayBuffer, label: "PRIVATE KEY" | "PUBLIC KEY") {
  const lines = btoa(String.fromCharCode(...new Uint8Array(bytes))).match(/.{1,64}/gu);
  if (lines === null) throw new Error("Disposable key encoding failed");
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`;
}
async function ephemeralCrypto() {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  // Memory only. No key, token, raw proof, password or connection URL in evidence.
  return makeSessionCrypto({
    privateKeyPem: pem(await crypto.subtle.exportKey("pkcs8", pair.privateKey), "PRIVATE KEY"),
    publicKeyPem: pem(await crypto.subtle.exportKey("spki", pair.publicKey), "PUBLIC KEY"),
    issuer: "owned-authority-fixture",
    audience: "owned-authority-fixture",
    defaultScope: ordinaryScope,
    defaultTtlSeconds: 300,
  });
}
type Composition = ReturnType<typeof makeGuestAuthorityPrivateComposition>;
type Fixture = Readonly<{
  admin: Client;
  runtime: Client;
  role: string;
  schema: string;
  composition: (factory?: PostgresClientFactory) => Composition;
  ambientToken: string;
}>;
async function fixture(use: (f: Fixture) => Promise<void>) {
  if (!pgUrl || !["localhost", "127.0.0.1"].includes(new URL(pgUrl).hostname))
    throw new Error("Coordinator-owned loopback PostgreSQL required");
  const packet = await migrationPacket(),
    suffix = crypto.randomUUID().replaceAll("-", "");
  const schema = `guest_http_${suffix}`,
    role = `guest_http_login_${suffix}`;
  const password = Array.from(randomBytes(32), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  const admin = new Client({
    connectionString: pgUrl,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
  });
  let runtime: Client | undefined,
    schemaCreated = false,
    roleCreated = false;
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA ${q(schema)}; SET search_path TO ${q(schema)},pg_catalog`);
    schemaCreated = true;
    const scoped = new URL(pgUrl);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    await runPostgresMigrations({
      connectionString: scoped.toString(),
      migrations: packet,
      expectedLedger: [],
    });
    expect(
      (await admin.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows,
    ).toEqual(packet.map(({ version, checksum }) => ({ version, checksum })));
    const statement = (
      await admin.query(
        "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD %L',$1::name,$2::text) AS result",
        [role, password],
      )
    ).rows[0]?.result;
    if (typeof statement !== "string") throw new Error("Role construction failed");
    await admin.query(statement);
    roleCreated = true;
    await admin.query(`GRANT USAGE ON SCHEMA ${q(schema)} TO ${q(role)}`);
    // Native closed ACL evidence BEFORE binds. No default/table/sequence grants.
    for (const signature of [...approved, ...forbidden]) {
      const row = (
        await admin.query(
          `SELECT p.prosecdef AS definer,
        EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.grantee<>p.proowner AND a.privilege_type='EXECUTE') AS foreign_execute,
        has_function_privilege($2::name,p.oid,'EXECUTE') AS runtime_execute,
        p.proconfig @> ARRAY[$3::text] AS pinned
        FROM pg_proc p WHERE p.oid=$1::regprocedure`,
          [signature, role, `search_path=pg_catalog, ${schema}, pg_temp`],
        )
      ).rows[0];
      expect(row).toEqual({
        definer: true,
        foreign_execute: false,
        runtime_execute: false,
        pinned: true,
      });
    }
    for (const signature of approved)
      await admin.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${q(role)}`);
    // Validate row runtime boundary as migration owner; never grant its helper.
    await admin.query("SELECT require_guest_learning_runtime_role_v1($1::regrole)", [role]);
    const runtimeUrl = new URL(scoped);
    runtimeUrl.username = role;
    runtimeUrl.password = password;
    runtime = new Client({
      connectionString: runtimeUrl.toString(),
      connectionTimeoutMillis: 3000,
      query_timeout: 3000,
    });
    await runtime.connect();
    const identity = (
      await runtime.query(`SELECT current_user AS actor, session_user AS session,
      r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,r.rolreplication,
      has_schema_privilege(current_user,current_schema(),'CREATE') AS schema_create
      FROM pg_roles r WHERE r.rolname=current_user`)
    ).rows[0];
    expect(identity).toEqual({
      actor: role,
      session: role,
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      schema_create: false,
    });
    for (const table of [
      "users",
      "participation_owners",
      "guest_credentials",
      "guest_attachment_intents",
      "guest_participation_operations",
      "guest_secret_issuance_operations",
      "study_sessions_v2",
      "learner_audio_artifacts",
    ]) {
      await expect(runtime.query(`SELECT * FROM ${q(table)} LIMIT 1`)).rejects.toMatchObject({
        code: "42501",
      });
      await expect(runtime.query(`DELETE FROM ${q(table)}`)).rejects.toMatchObject({
        code: "42501",
      });
      await expect(runtime.query(`TRUNCATE ${q(table)}`)).rejects.toMatchObject({ code: "42501" });
    }
    await expect(
      runtime.query(`CREATE TABLE ${q(schema)}.foreign_source(id text)`),
    ).rejects.toMatchObject({ code: "42501" });
    const owner = (await admin.query("SELECT current_user AS owner")).rows[0]?.owner;
    if (typeof owner !== "string") throw new Error("Fixture owner missing");
    await expect(runtime.query(`SET ROLE ${q(owner)}`)).rejects.toMatchObject({ code: "42501" });
    for (const signature of forbidden) {
      const privilege = (
        await runtime.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed", [
          signature,
        ])
      ).rows[0]?.allowed;
      expect(privilege).toBe(false);
    }
    const sessionCrypto = await ephemeralCrypto();
    const composition = (clientFactory?: PostgresClientFactory) => {
      const layer = makeDirectPostgresControlPlaneLayer(runtimeUrl.toString(), {
        closeTimeoutMs: 2000,
        ...(clientFactory === undefined ? {} : { clientFactory }),
        logger: { info: () => undefined, error: () => undefined },
      });
      return makeGuestAuthorityPrivateComposition({
        controlPlane: layer,
        accountVerifier: makeRs256SessionTokenVerifier(
          sessionCrypto,
          makeControlPlaneIdentityStore(layer),
        ),
        ordinarySessionScope: ordinaryScope,
        ordinaryProductOrigin: origin,
        nowMilliseconds: () => Date.now(),
        retryAfterSeconds: 2,
        currentResourcePolicy: null,
        disclosure: { version: "owned-controller-disclosure-v1", text: "Owned fixture only." },
        trustedEdgeForRequest: async () => null,
      });
    };
    const c = composition();
    expect(c.controllers).toBeDefined();
    expect(guestLearningNames).toHaveLength(16);
    expect(guestAccountingNames).toHaveLength(5);
    for (const name of guestLearningNames) {
      expect(guestParticipationRegistry[name].implementation).toBeUndefined();
      expect(guestParticipationRegistry[name].cacheControl).toBe("private, no-store");
    }
    for (const name of guestAccountingNames)
      expect(guestParticipationRegistry[name].implementation).toBe("disabled");
    process.stdout.write(
      `${JSON.stringify({
        fixture: "guest-http-private-genuine255",
        roleSha256: sha(role),
        currentEqualsSession: true,
        genuineMigrations: 255,
        approvedExecuteLeaves: approved.length,
      })}\n`,
    );
    await use({
      admin,
      runtime,
      role,
      schema,
      composition,
      ambientToken: await sessionCrypto.sign({
        sub: "unbound-ambient-account",
        scope: ordinaryScope,
      }),
    });
  } finally {
    if (runtime) await runtime.end().catch(() => undefined);
    await admin.query("ROLLBACK").catch(() => undefined);
    try {
      if (schemaCreated) await admin.query(`DROP SCHEMA ${q(schema)} CASCADE`);
      if (roleCreated) await admin.query(`DROP OWNED BY ${q(role)}; DROP ROLE ${q(role)}`);
    } finally {
      await admin.end();
    }
  }
}

class Browser {
  readonly cookies = new Map<string, string>();
  selected: string | null = null;
  csrf() {
    return this.cookies.get("__Host-pirate_guest_csrf");
  }
  headers(unsafe: boolean) {
    const h = new Headers({ cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ") });
    if (this.selected !== null) h.set("x-guest-credential-id", this.selected);
    if (unsafe) {
      h.set("origin", origin);
      h.set("x-guest-csrf-token", this.csrf() ?? "");
      h.set("content-type", "application/json");
    }
    return h;
  }
  apply(result: EndpointHandlerResult) {
    const h = new Headers(result.responseHeaders);
    expect(h.get("cache-control")).toBe("private, no-store");
    for (const cookie of h.getSetCookie()) {
      const first = cookie.split(";", 1)[0];
      if (first === undefined) throw new Error("Cookie missing");
      const at = first.indexOf("="),
        name = first.slice(0, at),
        value = first.slice(at + 1);
      expect(cookie.includes("; Path=/")).toBe(true);
      expect(cookie.includes("; Secure")).toBe(true);
      expect(cookie.includes("Domain=")).toBe(false);
      if (name !== "__Host-pirate_guest_csrf") expect(cookie.includes("HttpOnly")).toBe(true);
      else expect(cookie.includes("HttpOnly")).toBe(false);
      if (cookie.includes("Max-Age=0")) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}
async function invoke(
  c: Composition,
  b: Browser,
  name: GuestAuthorityControllerName,
  body?: unknown,
  options: Readonly<{
    headers?: Headers;
    rawBody?: string;
    query?: string;
    urlOrigin?: string;
    onDecode?: () => void;
  }> = {},
) {
  const d = guestParticipationRegistry[name],
    h = options.headers ?? b.headers(d.method !== "GET");
  const request = new Request(`${options.urlOrigin ?? origin}${d.path}${options.query ?? ""}`, {
    method: d.method,
    headers: h,
    ...(d.method === "GET" ? {} : { body: options.rawBody ?? JSON.stringify(body) }),
  });
  return c.handleAuthorityOperation({
    name,
    request,
    decodeRequestLocations: async () => {
      options.onDecode?.();
      // Actual maintained decoder and Hono request wrapper, no handler installed.
      // Infer the maintained transport Context generic; no assertion or authority flag.
      const decoded = await decodeInput(d, new Context<DecoderEnv>(request), null);
      const { principal: _, browserParticipation: __, ...locations } = decoded;
      return locations;
    },
  });
}
const authority = (r: EndpointHandlerResult) => Schema.decodeUnknownSync(GuestAuthorityV1)(r.body);
const cookies = (r: EndpointHandlerResult) => new Headers(r.responseHeaders).getSetCookie();
async function bootstrap(c: Composition, b: Browser, key: string) {
  b.apply(await invoke(c, b, "GetGuestAuthorityV1"));
  const r = await invoke(c, b, "IssueGuestBootstrapV1", { idempotency_key: key });
  b.apply(r);
  const selected = authority(r).selected;
  if (selected === null) throw new Error("Issued authority missing");
  b.selected = selected.credential_id;
  return selected;
}
async function confirm(c: Composition, b: Browser, key: string) {
  const p = await bootstrap(c, b, key),
    r = await invoke(c, b, "ConfirmGuestBootstrapV1", {
      expected_owner_id: p.owner_id,
      credential_id: p.credential_id,
    });
  expect(cookies(r)).toHaveLength(0);
  expect(authority(r).state).toBe("confirmed");
  b.apply(r);
  return p;
}
async function credential(f: Fixture, id: string) {
  return (
    await f.admin.query(
      `SELECT owner_id,state,secret_digest,session_until::text AS lease,
    pending_expires_at::text AS pending,predecessor_id,revoked_at::text AS revoked
    FROM guest_credentials WHERE credential_id=$1`,
      [id],
    )
  ).rows[0];
}
async function counts(f: Fixture) {
  return (
    await f.admin.query(`SELECT (SELECT count(*)::int FROM users) AS accounts,
    (SELECT count(*)::int FROM participation_owners WHERE kind='guest') AS owners,
    (SELECT count(*)::int FROM guest_credentials) AS credentials,
    (SELECT count(*)::int FROM guest_participation_operations) AS operations,
    (SELECT count(*)::int FROM guest_attachment_intents) AS intents`)
  ).rows[0];
}
async function caught(action: Promise<unknown>) {
  try {
    await action;
  } catch (error) {
    return error;
  }
  throw new Error("Expected private boundary refusal");
}

// The owned driver forwards every query to PostgreSQL. Only the actual success
// acknowledgement is withheld after a selected mutation's COMMIT has returned.
// Proof-reader transactions never arm this fault. It is not a wire-proxy test.
function lostCommitAfterMutation(needle: string) {
  let armed = true,
    observed = false;
  const clientFactory: PostgresClientFactory = (_url, config) => {
    const client = new Client(config);
    let mutation = false;
    return {
      connection: client.connection,
      connect: () => client.connect(),
      end: () => client.end(),
      query: async ({ text, values }) => {
        const response = await client.query({
          text,
          values: values === undefined ? [] : [...values],
        });
        if (text.includes(needle)) mutation = true;
        if (text === "COMMIT" && mutation && armed) {
          armed = false;
          observed = true;
          throw new Error("Owned fixture lost real successful COMMIT acknowledgement");
        }
        return response;
      },
    };
  };
  return { clientFactory, observed: () => observed };
}

suite("genuine PostgreSQL private browser authority controller integration", () => {
  test("bootstrap, confirm, discovery and replay preserve original digest-only issuance and lease", async () => {
    await fixture(async (f) => {
      const c = f.composition(),
        b = new Browser(),
        p = await bootstrap(c, b, "original-bootstrap");
      const raw = b.cookies.get(`__Host-pirate_guest_${p.credential_id}`);
      if (raw === undefined) throw new Error("Issued proof missing");
      const before = await credential(f, p.credential_id);
      expect(before?.secret_digest === (await digestGuestProof(raw))).toBe(true);
      expect(
        JSON.stringify(authority(await invoke(c, b, "GetGuestAuthorityV1"))).includes(raw),
      ).toBe(false);
      const replay = await invoke(c, b, "IssueGuestBootstrapV1", {
        idempotency_key: "original-bootstrap",
      });
      expect(authority(replay).selected).toEqual(p);
      expect(cookies(replay)).toHaveLength(0);
      expect(JSON.stringify(await credential(f, p.credential_id)) === JSON.stringify(before)).toBe(
        true,
      );
      const r = await invoke(c, b, "ConfirmGuestBootstrapV1", {
        expected_owner_id: p.owner_id,
        credential_id: p.credential_id,
      });
      expect(cookies(r)).toHaveLength(0);
      expect(authority(r).state).toBe("confirmed");
      const confirmed = await credential(f, p.credential_id);
      const repeat = await invoke(c, b, "ConfirmGuestBootstrapV1", {
        expected_owner_id: p.owner_id,
        credential_id: p.credential_id,
      });
      expect(cookies(repeat)).toHaveLength(0);
      expect(
        JSON.stringify(await credential(f, p.credential_id)) === JSON.stringify(confirmed),
      ).toBe(true);
      const discovered = await invoke(c, b, "GetGuestAuthorityV1", undefined, {
        query: `?expected_owner_id=${p.owner_id}`,
      });
      expect(authority(discovered).selected?.credential_id).toBe(p.credential_id);
      expect(await counts(f)).toEqual({
        accounts: 0,
        owners: 1,
        credentials: 1,
        operations: 1,
        intents: 0,
      });
      const fresh = new Browser();
      fresh.cookies.set("__Host-pirate_guest_csrf", b.csrf() ?? "");
      const error = await caught(
        invoke(c, fresh, "IssueGuestBootstrapV1", { idempotency_key: "original-bootstrap" }),
      );
      expect(error instanceof GuestConflict).toBe(true);
      if (!(error instanceof GuestConflict)) throw new Error("Expected lost-proof conflict");
      expect(error.details.reason_code).toBe("issuance_requires_restart");
      expect(fresh.cookies.size).toBe(1);
      expect(
        JSON.stringify(await credential(f, p.credential_id)) === JSON.stringify(confirmed),
      ).toBe(true);
      const restarted = await bootstrap(c, fresh, "new-deliberate-key");
      expect(restarted.credential_id === p.credential_id).toBe(false);
      expect(restarted.owner_id === p.owner_id).toBe(false);
    });
  }, 60000);

  test("renewal uses carried material; rotation ACK needs only successor proof and cleanup expires retained revoked proof", async () => {
    await fixture(async (f) => {
      const c = f.composition(),
        b = new Browser(),
        p = await confirm(c, b, "rotation-bootstrap");
      const oldCookie = b.cookies.get(`__Host-pirate_guest_${p.credential_id}`);
      if (oldCookie === undefined) throw new Error("Predecessor cookie missing");
      const renewed = await invoke(c, b, "RenewGuestAuthorityV1", {
        expected_owner_id: p.owner_id,
      });
      expect(cookies(renewed)).toHaveLength(1);
      b.apply(renewed);
      expect(b.cookies.get(`__Host-pirate_guest_${p.credential_id}`) === oldCookie).toBe(true);
      const rotated = await invoke(c, b, "RotateGuestCredentialV1", {
        expected_owner_id: p.owner_id,
        idempotency_key: "rotation-key",
      });
      const s = authority(rotated).selected;
      if (s === null) throw new Error("Successor missing");
      expect(s.owner_id).toBe(p.owner_id);
      expect(s.credential_state).toBe("pending_successor");
      b.apply(rotated);
      const newCookie = b.cookies.get(`__Host-pirate_guest_${s.credential_id}`);
      expect(newCookie === oldCookie).toBe(false);
      expect((await credential(f, p.credential_id))?.state).toBe("confirmed");
      const pendingSuccessor = await credential(f, s.credential_id);
      const rotationReplay = await invoke(c, b, "RotateGuestCredentialV1", {
        expected_owner_id: p.owner_id,
        idempotency_key: "rotation-key",
      });
      expect(authority(rotationReplay).selected?.credential_id).toBe(s.credential_id);
      expect(cookies(rotationReplay)).toHaveLength(0);
      expect(
        JSON.stringify(await credential(f, s.credential_id)) === JSON.stringify(pendingSuccessor),
      ).toBe(true);
      b.selected = s.credential_id;
      b.cookies.delete(`__Host-pirate_guest_${p.credential_id}`);
      const body = {
        expected_owner_id: p.owner_id,
        predecessor_credential_id: p.credential_id,
        successor_credential_id: s.credential_id,
      };
      const wrong = await caught(
        invoke(c, b, "AcknowledgeGuestCredentialV1", {
          ...body,
          predecessor_credential_id: s.credential_id,
        }),
      );
      expect(wrong instanceof GuestAuthError || wrong instanceof GuestConflict).toBe(true);
      expect((await credential(f, p.credential_id))?.state).toBe("confirmed");
      const ack = await invoke(c, b, "AcknowledgeGuestCredentialV1", body);
      expect(authority(ack).selected?.credential_id).toBe(s.credential_id);
      expect(cookies(ack)).toHaveLength(1);
      expect(cookies(ack)[0]?.startsWith(`__Host-pirate_guest_${p.credential_id}=`)).toBe(true);
      expect(cookies(ack)[0]?.includes("Max-Age=0")).toBe(true);
      b.apply(ack);
      const accepted = await credential(f, s.credential_id),
        predecessor = await credential(f, p.credential_id);
      expect(predecessor?.state).toBe("revoked");
      expect(accepted?.state).toBe("confirmed");
      expect(accepted?.predecessor_id).toBe(p.credential_id);
      const repeat = await invoke(c, b, "AcknowledgeGuestCredentialV1", body);
      expect(cookies(repeat)).toHaveLength(0);
      expect(
        JSON.stringify(await credential(f, s.credential_id)) === JSON.stringify(accepted),
      ).toBe(true);
      expect(
        JSON.stringify(await credential(f, p.credential_id)) === JSON.stringify(predecessor),
      ).toBe(true);
      b.cookies.set(`__Host-pirate_guest_${p.credential_id}`, oldCookie);
      const cleanup = await invoke(c, b, "CleanupGuestBrowserProofV1", {
        selected_credential_id: s.credential_id,
        candidate_credential_ids: [p.credential_id],
        candidate_intent_ids: [],
      });
      const cleaned = Schema.decodeUnknownSync(
        Schema.Struct({
          authority: GuestCleanupAuthorityV1,
          expired_credential_ids: Schema.Array(Schema.String),
          expired_intent_ids: Schema.Array(Schema.String),
        }),
      )(cleanup.body);
      expect(cleaned.expired_credential_ids).toEqual([p.credential_id]);
      expect(cleaned.authority.selected?.credential_id).toBe(s.credential_id);
      b.apply(cleanup);
      expect(b.cookies.has(`__Host-pirate_guest_${p.credential_id}`)).toBe(false);
      expect(
        JSON.stringify(await credential(f, p.credential_id)) === JSON.stringify(predecessor),
      ).toBe(true);
      expect(await counts(f)).toEqual({
        accounts: 0,
        owners: 1,
        credentials: 2,
        operations: 2,
        intents: 0,
      });
    });
  }, 60000);

  test("intent issuance is an independent nonce with no ambient target; real boundary rejects origin, explicit wrong selector and oversized body before mutation", async () => {
    await fixture(async (f) => {
      const c = f.composition(),
        b = new Browser(),
        p = await confirm(c, b, "intent-bootstrap");
      b.cookies.set("__Host-pirate_session", f.ambientToken);
      const r = await invoke(c, b, "CreateGuestAttachmentIntentV1", {
        expected_owner_id: p.owner_id,
        idempotency_key: "intent-key",
      });
      const intent = Schema.decodeUnknownSync(GuestAttachmentIntentV1)(r.body);
      b.apply(r);
      const nonce = b.cookies.get(`__Host-pirate_guest_attach_${intent.intent_id.slice(4)}`);
      if (nonce === undefined) throw new Error("Intent cookie missing");
      const cred = b.cookies.get(`__Host-pirate_guest_${p.credential_id}`);
      expect(nonce === cred).toBe(false);
      const row = (
        await f.admin.query(
          `SELECT owner_id,credential_id,nonce_digest,target_revision,
        target_account_id,target_session_digest,prepared_operation_id,state
        FROM guest_attachment_intents WHERE intent_id=$1`,
          [intent.intent_id],
        )
      ).rows[0];
      expect(row?.nonce_digest === (await digestGuestProof(nonce))).toBe(true);
      expect(row?.target_revision).toBe("0");
      expect(row?.target_account_id).toBeNull();
      expect(row?.target_session_digest).toBeNull();
      expect(row?.prepared_operation_id).toBeNull();
      expect(row?.state).toBe("awaiting_account");
      expect(row?.owner_id).toBe(p.owner_id);
      const replay = await invoke(c, b, "CreateGuestAttachmentIntentV1", {
        expected_owner_id: p.owner_id,
        idempotency_key: "intent-key",
      });
      expect(replay.body).toEqual(intent);
      expect(cookies(replay)).toHaveLength(0);
      const before = await counts(f);
      let decoded = 0;
      const cross = b.headers(true);
      cross.set("origin", "https://another.example");
      const rejectedOrigin = await caught(
        invoke(
          c,
          b,
          "RenewGuestAuthorityV1",
          { expected_owner_id: p.owner_id },
          { headers: cross, onDecode: () => decoded++ },
        ),
      );
      expect(rejectedOrigin instanceof GuestAuthError).toBe(true);
      expect(decoded).toBe(0);
      const wrong = b.headers(true);
      wrong.set("x-guest-credential-id", "A".repeat(22));
      const rejectedSelector = await caught(
        invoke(
          c,
          b,
          "RenewGuestAuthorityV1",
          { expected_owner_id: p.owner_id },
          { headers: wrong, onDecode: () => decoded++ },
        ),
      );
      expect(rejectedSelector instanceof GuestAuthError).toBe(true);
      expect(decoded).toBe(0);
      const rejectedBody = await caught(
        invoke(c, b, "IssueGuestBootstrapV1", undefined, {
          rawBody: JSON.stringify({ idempotency_key: "x".repeat(5000) }),
          onDecode: () => decoded++,
        }),
      );
      expect(rejectedBody instanceof BadRequest).toBe(true);
      expect(decoded).toBe(1);
      expect(await counts(f)).toEqual(before);
      const lostNonce = new Browser();
      for (const [k, v] of b.cookies)
        if (!k.startsWith("__Host-pirate_guest_attach_")) lostNonce.cookies.set(k, v);
      lostNonce.selected = p.credential_id;
      const error = await caught(
        invoke(c, lostNonce, "CreateGuestAttachmentIntentV1", {
          expected_owner_id: p.owner_id,
          idempotency_key: "intent-key",
        }),
      );
      expect(error instanceof GuestConflict).toBe(true);
      if (!(error instanceof GuestConflict)) throw new Error("Expected nonce restart refusal");
      expect(error.details.reason_code).toBe("issuance_requires_restart");
      expect(await counts(f)).toEqual(before);
    });
  }, 60000);

  test("a real committed issuance with lost acknowledgement exposes original-key pending and zero cookies; proof loss cannot mint replacement", async () => {
    await fixture(async (f) => {
      const b = new Browser(),
        normal = f.composition();
      b.apply(await invoke(normal, b, "GetGuestAuthorityV1"));
      const fault = lostCommitAfterMutation("SELECT issue_guest_pending_v1(");
      const faulty = f.composition(fault.clientFactory),
        beforeCookies = new Map(b.cookies);
      const error = await caught(
        invoke(faulty, b, "IssueGuestBootstrapV1", { idempotency_key: "ambiguous-original" }),
      );
      expect(fault.observed()).toBe(true);
      expect(error instanceof GuestPendingConflict).toBe(true);
      if (!(error instanceof GuestPendingConflict))
        throw new Error("Expected COMMIT pending conflict");
      expect(error.details.operation).toEqual({
        operation_kind: "bootstrap_issue",
        idempotency_key: "ambiguous-original",
        operation_id: null,
      });
      expect(JSON.stringify([...b.cookies]) === JSON.stringify([...beforeCookies])).toBe(true); // No result/response plan reached Browser.apply.
      const records = (
        await f.admin.query(
          `SELECT o.operation_id,o.source_owner_id,o.state,o.result_snapshot,
        i.credential_id,c.owner_id,c.secret_digest FROM guest_participation_operations o
        JOIN guest_secret_issuance_operations i USING(operation_id)
        JOIN guest_credentials c ON c.credential_id=i.credential_id WHERE o.idempotency_key=$1`,
          ["ambiguous-original"],
        )
      ).rows;
      expect(records).toHaveLength(1);
      expect(records[0]?.state).toBe("completed");
      expect(await counts(f)).toEqual({
        accounts: 0,
        owners: 1,
        credentials: 1,
        operations: 1,
        intents: 0,
      });
      const again = await caught(
        invoke(normal, b, "IssueGuestBootstrapV1", { idempotency_key: "ambiguous-original" }),
      );
      expect(again instanceof GuestConflict).toBe(true);
      if (!(again instanceof GuestConflict))
        throw new Error("Expected original issuance restart refusal");
      expect(again.details.reason_code).toBe("issuance_requires_restart");
      expect(JSON.stringify([...b.cookies]) === JSON.stringify([...beforeCookies])).toBe(true);
      expect(await counts(f)).toEqual({
        accounts: 0,
        owners: 1,
        credentials: 1,
        operations: 1,
        intents: 0,
      });
      const after = (
        await f.admin.query(
          `SELECT o.operation_id,o.source_owner_id,o.state,o.result_snapshot,
        i.credential_id,c.owner_id,c.secret_digest FROM guest_participation_operations o
        JOIN guest_secret_issuance_operations i USING(operation_id)
        JOIN guest_credentials c ON c.credential_id=i.credential_id WHERE o.idempotency_key=$1`,
          ["ambiguous-original"],
        )
      ).rows;
      // Boolean equality avoids printing private stored digest/snapshot on failure.
      expect(JSON.stringify(after) === JSON.stringify(records)).toBe(true);
    });
  }, 60000);
  test("unknown natural confirmation replays the original authority and exact committed lease without cookies", async () => {
    await fixture(async (f) => {
      const normal = f.composition(),
        b = new Browser(),
        p = await bootstrap(normal, b, "unknown-confirm-bootstrap");
      const fault = lostCommitAfterMutation("SELECT confirm_guest_pending_v1(");
      const body = { expected_owner_id: p.owner_id, credential_id: p.credential_id };
      const beforeCookies = new Map(b.cookies);
      const error = await caught(
        invoke(f.composition(fault.clientFactory), b, "ConfirmGuestBootstrapV1", body),
      );
      expect(fault.observed()).toBe(true);
      expect(error instanceof GuestPendingConflict).toBe(true);
      if (!(error instanceof GuestPendingConflict))
        throw new Error("Expected natural confirm pending");
      expect(error.details.operation).toEqual({
        operation_kind: "bootstrap_confirm",
        idempotency_key: p.credential_id,
        operation_id: null,
      });
      expect(JSON.stringify([...b.cookies]) === JSON.stringify([...beforeCookies])).toBe(true);
      const accepted = await credential(f, p.credential_id);
      expect(accepted?.state).toBe("confirmed");
      const replay = await invoke(normal, b, "ConfirmGuestBootstrapV1", body);
      expect(authority(replay).selected?.credential_id).toBe(p.credential_id);
      expect(cookies(replay)).toHaveLength(0);
      expect(
        JSON.stringify(await credential(f, p.credential_id)) === JSON.stringify(accepted),
      ).toBe(true);
      expect(await counts(f)).toEqual({
        accounts: 0,
        owners: 1,
        credentials: 1,
        operations: 1,
        intents: 0,
      });
    });
  }, 60000);
});
