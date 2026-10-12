// Proposal-only fixture, adopted beside platform-cf tests by root. Real immutable
// migrations through actual0254; no external supplements/rendered baseline or
// fixture-only actor/admission/phase selector. No SQL is executed by this draft.
import { expect } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type {
  GuestLearningAccess,
  OwnerAwareStudyV2Store,
  ParticipationOperationIdentity,
} from "@pirate/application";
import { GuestStudySessionV1 } from "@pirate/contracts";
import { Effect, Schema } from "effect";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { makeControlPlaneOwnerStudyStarter } from "./owner-study-starter.ts";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresClientFactory,
  type PostgresControlPlaneOptions,
} from "./postgres.ts";
import type { PostgresMigration } from "./postgres-migrations.ts";
import { insertStudySongFixture } from "./study-v2-ready-song.pg-fixture.ts";
import { makeControlPlaneStudyV2Store } from "./study-v2-repository.ts";

export const pgUrl = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !pgUrl)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
export const q = (value: string) => `"${value.replaceAll('"', '""')}"`;
export const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export const origin = "https://community.example";
export const disclosure = {
  version: "owned-pg-disclosure-v1",
  text: "Synthetic owned fixture disclosure; no production policy inferred.",
};
export const policy = {
  version: "owned-pg-policy-v1",
  costPolicyVersion: "owned-pg-cost-v1",
  maximumOwnerActiveSessions: 2 as const,
  maximumOwnerReservedPaidCallsPerRollingDay: 60 as const,
  maximumGlobalActiveSessions: 100,
  maximumGlobalPaidCallsPerRollingDay: 1000,
  maximumGlobalCostMicrosPerRollingDay: "100000000",
  maximumOwnerCostMicrosPerRollingDay: "100000000",
  maximumTrustedEdgeSessionsPerWindow: 100,
  trustedEdgeWindowSeconds: 3600,
  maximumProviderCallCostMicros: "1000",
};
type Store = Pick<OwnerAwareStudyV2Store, "startSession" | "getSession" | "findStartOperation">;
export type StartInput = Parameters<Store["startSession"]>[0];
export const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.scoped(effect));
export const rejected = <A, E>(effect: Effect.Effect<A, E>) => run(Effect.flip(effect));

export const bytesHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
export const bytesBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

async function migrations() {
  const directory = new URL("../../../db/postgres/migrations/", import.meta.url);
  const manifest = Schema.decodeUnknownSync(
    Schema.Struct({
      algorithm: Schema.Literal("sha256"),
      migrations: Schema.Record(Schema.String, Schema.String),
    }),
  )(JSON.parse(await readFile(new URL("checksums.json", directory), "utf8")));
  const names = (await readdir(directory))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name) && Number(name.slice(0, 4)) <= 254)
    .sort();
  expect(names.map((name) => Number(name.slice(0, 4)))).toEqual(
    Array.from({ length: 254 }, (_, i) => i + 1),
  );
  expect(names[246]).toBe("0247_karaoke_instrumental_qualification_policy.sql");
  expect(names.slice(247)).toEqual([
    "0248_guest_learning_authority_foundation.sql",
    "0249_study_participation_owner_preservation.sql",
    "0250_guest_browser_authority_transitions.sql",
    "0251_guest_learning_resource_reservations.sql",
    "0252_guest_learning_controlled_row_admission.sql",
    "0253_learner_audio_deletion_fence.sql",
    "0254_guest_prepared_study_session_capture.sql",
  ]);
  const all: PostgresMigration[] = [];
  for (const version of names) {
    const sql = await readFile(new URL(version, directory), "utf8");
    const checksum = hash(sql);
    // Historical entries MUST match the immutable maintained declaration.
    // Newly adopted draft entries are bound to their exact actual source bytes
    // in this successor's sealed input inventory until root declares checksums.
    const expectedChecksum = manifest.migrations[version];
    if (Number(version.slice(0, 4)) <= 247 && expectedChecksum === undefined)
      throw new Error("Historical migration checksum declaration missing");
    if (expectedChecksum !== undefined) expect(checksum).toBe(expectedChecksum);
    all.push({ version, sql, checksum });
  }
  return { historical: all.slice(0, 247), through251: all.slice(0, 251), through254: all };
}

export type Fixture = {
  admin: Client;
  guest: Client;
  schema: string;
  role: string;
  guestUrl: string;
  store: Store;
  accountStore: ReturnType<typeof makeControlPlaneStudyV2Store>;
  accountOriginal: Awaited<ReturnType<typeof accountStart>>;
  lines: readonly string[];
  storeFor: (
    config?: PostgresControlPlaneOptions,
    policyInput?: unknown,
    disclosureInput?: typeof disclosure,
  ) => Store;
};
async function accountStart(
  store: ReturnType<typeof makeControlPlaneStudyV2Store>,
  sessionId: string,
) {
  return await run(
    store.startSession({
      accountId: "study-account",
      personaId: "study-persona",
      communityId: "study-community",
      postId: "study-post",
      sessionId,
      idempotencyKey: `ordinary:${sessionId}`,
      requestHash: hash(`ordinary:${sessionId}`),
      createdAt: new Date().toISOString(),
      targetLanguage: null,
      learnerBand: null,
      timezone: "UTC",
    }),
  );
}
export async function accountNew(f: Fixture, sessionId: string) {
  return await accountStart(f.accountStore, sessionId);
}

export async function editFixture(admin: Client, sql: string, values: readonly unknown[] = []) {
  await admin.query("SET session_replication_role=replica");
  try {
    return await admin.query(sql, [...values]);
  } finally {
    await admin.query("SET session_replication_role=origin");
  }
}
export async function fixture(use: (f: Fixture) => Promise<void>) {
  if (!pgUrl) throw new Error("Owned test PG URL missing");
  if (!["127.0.0.1", "localhost"].includes(new URL(pgUrl).hostname))
    throw new Error("Private starter fixture requires coordinator-owned loopback PostgreSQL");
  const packet = await migrations();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const schema = `gs_capture_${suffix}`,
    role = `gs_capture_login_${suffix}`;
  const password = bytesHex(randomBytes(32));
  const admin = new Client({
    connectionString: pgUrl,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
  });
  let guest: Client | undefined;
  let createdSchema = false,
    createdRole = false;
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA ${q(schema)}`);
    createdSchema = true;
    await admin.query(`SET search_path TO ${q(schema)},pg_catalog`);
    const scoped = new URL(pgUrl);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    await runPostgresMigrations({
      connectionString: scoped.toString(),
      migrations: packet.historical,
      expectedLedger: [],
    });
    const { lines } = await insertStudySongFixture(admin);
    const accountStore = makeControlPlaneStudyV2Store(
      makeDirectPostgresControlPlaneLayer(scoped.toString(), {
        closeTimeoutMs: 2000,
      }),
    );
    // REAL ordinary baseline actor/store BEFORE any guest amendment. This is
    // the same shared fixture/projection, not a test-only account selector.
    const accountOriginal = await accountStart(accountStore, "ordinary-before-guest");
    const originalGuard = (
      await admin.query(
        "SELECT pg_get_functiondef('guard_study_v2_activity_authority()'::regprocedure) AS definition",
      )
    ).rows;
    await runPostgresMigrations({
      connectionString: scoped.toString(),
      migrations: packet.through251,
      expectedLedger: packet.historical,
    });
    expect(
      (await admin.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows,
    ).toEqual(packet.through251.map(({ version, checksum }) => ({ version, checksum })));
    const lyrics = lines.join("\n"),
      lyricsHash = hash(lyrics);
    await editFixture(
      admin,
      `INSERT INTO media_song_lyrics_revisions(submission_id,community_id,actor_user_id,author_persona_id,
      operation_id,lyrics_revision,creation_revision,audio_revision,canonical_audio_sha256,lyrics_text,lyrics_sha256,provenance)
      VALUES('study-submission','study-community','study-account','study-persona','study-operation',1,2,1,$1,$2,$3,'pasted')`,
      ["2".repeat(64), lyrics, lyricsHash],
    );
    await editFixture(
      admin,
      `INSERT INTO study_language_profiles(community_id,post_id,lyrics_revision,language_profile_revision,source_hash,
      provider_id,provider_model,prompt_revision,validator_revision,request_hash,accepted_at)
      VALUES('study-community','study-post',1,1,$1,'fixture','fixture','fixture','fixture',$1,clock_timestamp())`,
      [lyricsHash],
    );
    for (let i = 1; i <= 4; i++)
      await editFixture(
        admin,
        `INSERT INTO study_language_profile_units(community_id,post_id,lyrics_revision,
      language_profile_revision,study_unit_id,detected_languages,dominant_language,mixed,vocable_only,proper_name_only,confidence)
      VALUES('study-community','study-post',1,1,$1,'["en"]','en',FALSE,FALSE,FALSE,0.99)`,
        [`unit-${i}`],
      );
    // FULL inventory, not a suffix: the maintained runner compares every
    // applied ledger row to the supplied declarations before applying252..254.
    await runPostgresMigrations({
      connectionString: scoped.toString(),
      migrations: packet.through254,
      expectedLedger: packet.through251,
    });
    expect(
      (await admin.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows,
    ).toEqual(packet.through254.map(({ version, checksum }) => ({ version, checksum })));
    expect(
      (
        await admin.query(
          "SELECT pg_get_functiondef('guard_study_v2_activity_authority()'::regprocedure) AS definition",
        )
      ).rows,
    ).toEqual(originalGuard);
    // Native migrated ACL/frame proof BEFORE broad fixture revokes or grants.
    // Fixture cleanup cannot manufacture this migration installation evidence.
    const nativeAtomicSignatures = [
      "reserve_guest_prepared_study_start_v1(jsonb,jsonb,text,text,text,text,text,text,jsonb,text)",
      "select_guest_study_start_plan_v1(text,text,text,text,text)",
    ];
    expect(
      (
        await admin.query(
          `SELECT signature,f.prosecdef AS security_definer,
      f.proowner=(SELECT relowner FROM pg_class WHERE oid='participation_owners'::regclass) AS owned,
      f.proconfig @> ARRAY[format('search_path=pg_catalog, %I, pg_temp',$2::text)] AS pinned,
      EXISTS(SELECT 1 FROM aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
        WHERE a.grantee<>f.proowner AND a.privilege_type='EXECUTE') AS nonowner_execute
      FROM unnest($1::text[]) AS signatures(signature) JOIN pg_proc f ON f.oid=to_regprocedure(signature)
      ORDER BY signature COLLATE "C"`,
          [nativeAtomicSignatures, schema],
        )
      ).rows,
    ).toEqual(
      nativeAtomicSignatures.map((signature) => ({
        signature,
        security_definer: true,
        owned: true,
        pinned: true,
        nonowner_execute: false,
      })),
    );
    await admin.query(
      `CREATE ROLE ${q(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
    );
    createdRole = true;
    await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${q(schema)} FROM PUBLIC,${q(role)};
      REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${q(schema)} FROM PUBLIC,${q(role)};GRANT USAGE ON SCHEMA ${q(schema)} TO ${q(role)}`);
    await admin.query("SELECT require_guest_learning_runtime_role_v1($1::regrole)", [role]);
    for (const signature of [
      "prepare_guest_study_start_v1(jsonb,jsonb,text,text,text,text,text,jsonb)",
      "commit_guest_study_start_v1(jsonb,jsonb,text,text,text,text,text,jsonb,jsonb,jsonb,text,text,text,text,boolean)",
      "read_owner_study_session_snapshot_v1(jsonb,text,text)",
      "find_guest_study_start_operation_v1(jsonb,text,text,text,text)",
    ])
      await admin.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${q(role)}`);
    const guestScoped = new URL(scoped);
    guestScoped.username = role;
    guestScoped.password = password;
    const guestUrl = guestScoped.toString();
    guest = new Client({
      connectionString: guestUrl,
      connectionTimeoutMillis: 3000,
      statement_timeout: 3000,
    });
    await guest.connect();
    const identity = (
      await guest.query(
        "SELECT current_user,session_user,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0];
    expect(identity).toEqual({
      current_user: role,
      session_user: role,
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
    });
    process.stdout.write(
      `${JSON.stringify({ fixture: "guest-study-real-restricted-login", roleSha256: hash(role), currentEqualsSession: true })}\n`,
    );
    const storeFor = (
      config: PostgresControlPlaneOptions = {},
      policyInput: unknown = policy,
      disclosureInput = disclosure,
    ) =>
      makeControlPlaneOwnerStudyStarter(
        makeDirectPostgresControlPlaneLayer(guestUrl, {
          closeTimeoutMs: 2000,
          ...config,
        }),
        disclosureInput,
        policyInput,
      );
    await use({
      admin,
      guest,
      schema,
      role,
      guestUrl,
      store: storeFor(),
      accountStore,
      accountOriginal,
      lines,
      storeFor,
    });
  } finally {
    if (guest) await guest.end().catch(() => undefined);
    await admin.query("ROLLBACK").catch(() => undefined);
    try {
      if (createdSchema) await admin.query(`DROP SCHEMA ${q(schema)} CASCADE`);
      if (createdRole) await admin.query(`DROP OWNED BY ${q(role)};DROP ROLE ${q(role)}`);
    } finally {
      await admin.end();
    }
  }
}

export async function pendingGuest(f: Fixture, serial: number) {
  const credentialId = bytesBase64Url(randomBytes(16)),
    digest = hash(randomBytes(32));
  const ownerId = `owner_00000000-0000-0000-0000-${String(serial).padStart(12, "0")}`;
  await f.admin.query("SELECT issue_guest_pending_v1($1,'{}',NULL,$2,$3,$4,$5,$6,$7)", [
    origin,
    `bootstrap-${serial}`,
    hash(`bootstrap-${serial}`),
    `bootstrap-op-${serial}`,
    ownerId,
    credentialId,
    digest,
  ]);
  return { ownerId, credentialId, digest };
}
export async function confirmGuest(
  f: Fixture,
  proof: Awaited<ReturnType<typeof pendingGuest>>,
  carried: readonly Awaited<ReturnType<typeof pendingGuest>>[] = [proof],
) {
  const verified = (
    await f.admin.query(
      "SELECT read_guest_browser_proof_snapshot_v1($1,$2::jsonb,'[]',FALSE) AS snapshot",
      [
        origin,
        JSON.stringify(carried.map(({ credentialId, digest }) => ({ credentialId, digest }))),
      ],
    )
  ).rows[0]?.snapshot;
  expect(verified.provedCredentials).toHaveLength(carried.length);
  const confirmed = (
    await f.admin.query("SELECT confirm_guest_pending_v1($1,$2::text[],$3,$4) AS response", [
      origin,
      verified.provedCredentials.map((p: { credentialId: string }) => p.credentialId),
      proof.credentialId,
      proof.ownerId,
    ])
  ).rows[0]?.response;
  const effective = confirmed.authority.selected.owner_id;
  const row = (
    await f.admin.query("SELECT read_guest_learning_lease_observation_v1($1,$2,$3) AS snapshot", [
      origin,
      proof.credentialId,
      effective,
    ])
  ).rows[0]?.snapshot;
  expect(row.active).toBe(true);
  const access: GuestLearningAccess = {
    kind: "guest",
    ownerId: effective,
    credentialId: proof.credentialId,
    origin,
    leaseUntil: row.leaseUntil,
  };
  return {
    access,
    ownerId: effective,
    credentialId: proof.credentialId,
    digest: proof.digest,
  };
}
export async function seedGuest(f: Fixture, serial: number) {
  return await confirmGuest(f, await pendingGuest(f, serial));
}
export async function reserve(f: Fixture, access: GuestLearningAccess, key: string, units = 24) {
  const operation: ParticipationOperationIdentity = {
    sourceOwnerId: access.ownerId,
    kind: "study_start",
    idempotencyKey: key,
    requestHash: hash(`start:${key}`),
  };
  const originalSession = `original-${key}`;
  const response = (
    await f.admin.query(
      `SELECT reserve_guest_resource_session_v1($1,$2::jsonb,$3,$4,$5,$6,$7::jsonb) AS response`,
      [
        access.ownerId,
        JSON.stringify(operation),
        originalSession,
        units,
        String(units * 1000),
        `trusted-edge-${access.ownerId}`,
        JSON.stringify(policy),
      ],
    )
  ).rows[0]?.response;
  expect(response.result.state).toBe("reserved");
  const input: StartInput = {
    access,
    source: { kind: "guest", ownerId: access.ownerId },
    operation,
    communityId: "study-community",
    postId: "study-post",
    sessionId: `fresh-unused-${key}`,
    createdAt: new Date().toISOString(),
    targetLanguage: null,
    learnerBand: null,
    timezone: "UTC",
    idempotencyKey: key,
    requestHash: operation.requestHash,
    rewardMode: "practice_only",
    rewardTerms: null,
    disclosure: { version: disclosure.version, accepted: true },
    resourceReservationId: response.result.reservationId,
  };
  return {
    input,
    originalSession,
    reservationId: response.result.reservationId as string,
  };
}
export async function counts(f: Fixture) {
  return (
    await f.admin.query(`SELECT (SELECT count(*)::int FROM study_sessions_v2 WHERE participation_owner_kind='guest') AS sessions,
   (SELECT count(*)::int FROM study_session_items_v2 WHERE participation_owner_kind='guest') AS items,
   (SELECT count(*)::int FROM guest_participation_operations WHERE operation_kind='study_start') AS operations,
   (SELECT count(*)::int FROM guest_resource_provider_calls) AS calls,
   (SELECT count(*)::int FROM users) AS accounts,(SELECT count(*)::int FROM personas) AS personas,
   (SELECT count(*)::int FROM community_memberships) AS memberships`)
  ).rows[0];
}
export const completed = (value: Effect.Success<ReturnType<Store["startSession"]>>) => {
  if (value.state !== "completed" || value.result.source.kind !== "guest")
    throw new Error("Expected completed guest source");
  const session = Schema.decodeUnknownSync(GuestStudySessionV1, {
    onExcessProperty: "error",
  })(value.result.session);
  return {
    ...value,
    result: {
      source: { kind: "guest" as const, ownerId: value.result.source.ownerId },
      session,
    },
  };
};
export async function financialFingerprint(f: Fixture) {
  const rows: Record<string, unknown> = {};
  for (const table of [
    "activity_qualifications",
    "song_streak_days",
    "community_streak_days",
    "megapot_pool_shares",
    "megapot_ticket_inventory",
    "reward_ledger_credits",
  ])
    rows[table] = (
      await f.admin.query(
        `SELECT count(*)::int AS n,encode(sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text,'UTF8')),'hex') AS hash FROM ${q(table)} t`,
      )
    ).rows;
  return rows;
}
export async function translation(f: Fixture, index: number, helper: string, band: "A1" | "B1") {
  const id = `translation-${helper}-${band}-${index}`;
  const patch = {
    exercise_version_id: id,
    exercise_review_key: `translation:${helper}:${band}:unit-${index}`,
    exercise_type: "translation_choice",
    exercise_variant: "whole-line-v1",
    target_language: helper,
    learner_band: band,
    language_profile_revision: 1,
    retired_at: null,
    answer_visibility: "secret_until_spent",
    feedback_release: "spent_only",
    grader_policy_revision: "exact_choice_v1",
    feedback_policy_revision: "choice-reveal-v1",
    generation_kind: "provider_generated",
    provider_model: "fixture-model",
    generation_run_id: `fixture-${id}`,
    producer_id: "fixture-prepared-translation",
    presentation: {
      kind: "translation_choice",
      source_text: "Synthetic prepared line",
      question: "Choose the prepared meaning",
      capture: "choice_selection",
      choices: ["a", "b", "c", "d"].map((choice_key) => ({
        choice_key,
        text: `Fixture ${choice_key}`,
      })),
    },
    private_grader: {
      kind: "exact_choice_v1",
      correct_choice_key: "a",
      correct_text: "Fixture a",
      explanation: "Fixture only",
    },
  };
  await f.admin.query(
    `INSERT INTO study_exercise_versions SELECT(jsonb_populate_record(NULL::study_exercise_versions,to_jsonb(source)||$2::jsonb)).*
    FROM study_exercise_versions source WHERE exercise_version_id=$1`,
    [`exercise-${index}`, JSON.stringify(patch)],
  );
}
// Real PG COMMIT reaches PostgreSQL; only its successful acknowledgement is
// withheld from the owning adapter. This does not fake a database write/result.
export function lostCommitClient() {
  let committed = false,
    armed = true;
  const clientFactory: PostgresClientFactory = (_url, config) => {
    const client = new Client(config);
    return {
      connection: client.connection,
      connect: () => client.connect(),
      end: () => client.end(),
      query: async ({ text, values }) => {
        const result = await client.query({
          text,
          values: values === undefined ? [] : [...values],
        });
        if (text === "COMMIT" && armed) {
          armed = false;
          committed = true;
          throw new Error("owned fixture dropped successful COMMIT acknowledgement");
        }
        return result;
      },
    };
  };
  return { clientFactory, observed: () => committed };
}
