// Outside unexecuted proposal. Actual maintained prefix/root263 only; no SQL overlay.
import { expect } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Schema } from "effect";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import {
  type RecoveryDeletionFixture,
  recoveryDeletionFixture,
} from "./guest-recovery-deletion.pg-fixture.ts";
import { hash, pgUrl, q } from "./owner-study-starter.pg-fixture.ts";
import type { PostgresMigration } from "./postgres-migrations.ts";
export type EphemeralFixture = RecoveryDeletionFixture &
  Readonly<{ cleanup: Client; cleanupUrl: string; cleanupRole: string }>;
const signatures = [
  "capture_guest_audio_retention_private_v1()",
  "guest_ephemeral_object_closed_private_v1(text)",
  "guest_ephemeral_upload_ready_private_v1(text)",
  "guest_ephemeral_owner_delete_witness_private_v1(text)",
  "guest_ephemeral_pending_cleanup_ready_private_v1(text)",
  "prepare_guest_captured_audio_cleanup_private_v1(jsonb)",
  "prepare_next_guest_ephemeral_audio_cleanup_private_v1()",
  "confirm_guest_ephemeral_audio_cleanup_private_v1(text,text,text,timestamptz)",
  "register_learner_audio_upload_private_v1(text,text,text,text,text,text,text,text,bigint)",
  "claim_guest_audio_io_private_v1(jsonb)",
  "settle_guest_audio_io_private_v1(jsonb,text,boolean)",
] as const;
const cleanupLeaves = [
  "prepare_next_guest_ephemeral_audio_cleanup_private_v1()",
  "confirm_guest_ephemeral_audio_cleanup_private_v1(text,text,text,timestamptz)",
] as const;
const producerLeaves = [
  "claim_guest_audio_io_private_v1(jsonb)",
  "settle_guest_audio_io_private_v1(jsonb,text,boolean)",
] as const;
const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
export function bounded<A>(task: Promise<A>, label: string, limit = 3000): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Native fixture deadline: ${label}`)), limit);
  });
  return Promise.race([task, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
async function actualInventory() {
  const raw = process.env.GUEST_EPHEMERAL_NATIVE_INPUTS_JSON;
  if (!raw) throw new Error("Root exact actual263 source inventory required");
  const input = Schema.decodeUnknownSync(
    Schema.Struct({
      migration: Schema.String.check(Schema.isPattern(/^0263_.+\.sql$/u)),
      hashes: Schema.Record(Schema.String, Sha),
    }),
    { onExcessProperty: "error" },
  )(JSON.parse(raw));
  const directory = new URL("../../../db/postgres/migrations/", import.meta.url);
  const manifest = Schema.decodeUnknownSync(
    Schema.Struct({
      algorithm: Schema.Literal("sha256"),
      migrations: Schema.Record(Schema.String, Sha),
    }),
    { onExcessProperty: "error" },
  )(JSON.parse(await readFile(new URL("checksums.json", directory), "utf8")));
  const names = (await readdir(directory))
    .filter((n) => /^\d{4}_.+\.sql$/u.test(n) && Number(n.slice(0, 4)) <= 263)
    .sort();
  expect(names.map((n) => Number(n.slice(0, 4)))).toEqual(
    Array.from({ length: 263 }, (_, i) => i + 1),
  );
  expect(names.at(-1)).toBe(input.migration);
  const migrations: PostgresMigration[] = [];
  for (const version of names) {
    const sql = await readFile(new URL(version, directory), "utf8"),
      checksum = hash(sql),
      number = Number(version.slice(0, 4));
    if (number <= 247) {
      if (!manifest.migrations[version]) throw new Error("Immutable historical hash missing");
      expect(checksum).toBe(manifest.migrations[version]);
    }
    if (number >= 248) {
      if (!input.hashes[version]) throw new Error("Root actual private hash missing");
      expect(checksum).toBe(input.hashes[version]);
    }
    migrations.push({ version, sql, checksum });
  }
  return migrations;
}
export async function ephemeralFixture(
  use: (f: EphemeralFixture) => Promise<void>,
  before263?: (f: RecoveryDeletionFixture) => Promise<void>,
) {
  const all = await actualInventory();
  await recoveryDeletionFixture(async (f) => {
    if (!pgUrl) throw new Error("Owned loopback PostgreSQL required");
    if (!["127.0.0.1", "localhost"].includes(new URL(pgUrl).hostname))
      throw new Error("Owned loopback only");
    const adminUrl = new URL(pgUrl);
    adminUrl.searchParams.set("options", `-c search_path=${f.schema}`);
    await runPostgresMigrations({
      connectionString: adminUrl.toString(),
      migrations: all.slice(0, 262),
      expectedLedger: all.slice(0, 258),
    });
    await before263?.(f);
    await runPostgresMigrations({
      connectionString: adminUrl.toString(),
      migrations: all,
      expectedLedger: all.slice(0, 262),
    });
    expect(
      (await f.admin.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows,
    ).toEqual(all.map(({ version, checksum }) => ({ version, checksum })));
    // Actual native installation properties BEFORE any new producer/cleanup grant.
    for (const signature of signatures) {
      expect(
        (
          await f.admin.query(
            `SELECT p.proowner=c.relowner AS owner,
    p.pronamespace=c.relnamespace AS namespace,p.prosecdef AS definer,
    p.proconfig @> ARRAY[format('search_path=pg_catalog, %I, pg_temp',n.nspname)] AS pinned,
    NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee<>p.proowner AND a.privilege_type='EXECUTE') AS private
    FROM pg_proc p CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE p.oid=$1::regprocedure AND c.oid='participation_owners'::regclass`,
            [signature],
          )
        ).rows,
      ).toEqual([{ owner: true, namespace: true, definer: true, pinned: true, private: true }]);
    }
    const cleanupRole = `fixture_ephemeral_${randomUUID().replaceAll("-", "")}`,
      password = randomBytes(24).toString("hex");
    let created = false,
      connected = false,
      primaryFailed = false;
    let primaryError: unknown;
    let cleanup: Client | undefined;
    const errors: unknown[] = [];
    try {
      await f.admin.query(
        `CREATE ROLE ${q(cleanupRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
      );
      created = true;
      await f.admin.query(`GRANT USAGE ON SCHEMA ${q(f.schema)} TO ${q(cleanupRole)}`);
      const url = new URL(pgUrl);
      url.username = cleanupRole;
      url.password = password;
      url.searchParams.set("options", `-c search_path=${f.schema}`);
      cleanup = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 2000 });
      await cleanup.connect();
      connected = true;
      expect(
        (await cleanup.query("SELECT current_user=session_user AS original_login")).rows,
      ).toEqual([{ original_login: true }]);
      await expect(cleanup.query("SET ROLE postgres")).rejects.toMatchObject({ code: "42501" });
      for (const signature of signatures) {
        expect(
          (
            await cleanup.query(
              "SELECT has_function_privilege(current_user,$1,'EXECUTE') AS executable",
              [signature],
            )
          ).rows,
        ).toEqual([{ executable: false }]);
      }
      await expect(
        cleanup.query("SELECT prepare_next_guest_ephemeral_audio_cleanup_private_v1()"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        cleanup.query("SELECT * FROM guest_study_spoken_captures"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        cleanup.query("SELECT fail_learner_audio_delete_private_v1('unavailable','unknown')"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        cleanup.query(
          "SELECT confirm_captured_audio_cleanup_private_v1('unavailable','unavailable','unavailable',clock_timestamp())",
        ),
      ).rejects.toMatchObject({ code: "42501" });
      for (const signature of cleanupLeaves)
        await f.admin.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${q(cleanupRole)}`);
      await expect(
        cleanup.query("SELECT prepare_guest_captured_audio_cleanup_private_v1('{}'::jsonb)"),
      ).rejects.toMatchObject({ code: "42501" });
      // Root263 rebinds these actual controlled Guest callbacks; no raw253 grant.
      for (const signature of producerLeaves)
        await f.admin.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${q(f.role)}`);
      await use({ ...f, cleanup, cleanupUrl: url.toString(), cleanupRole });
    } catch (error) {
      primaryFailed = true;
      primaryError = error;
    } finally {
      // A client-close failure must not skip independent role cleanup.
      if (connected && cleanup)
        try {
          await bounded(cleanup.end(), "cleanup-login-close");
        } catch (error) {
          errors.push(error);
        }
      if (created)
        try {
          await bounded(
            f.admin.query(`DROP OWNED BY ${q(cleanupRole)};DROP ROLE ${q(cleanupRole)}`),
            "cleanup-role-close",
          );
        } catch (error) {
          errors.push(error);
        }
    }
    if (errors.length)
      throw new AggregateError(
        primaryFailed ? [primaryError, ...errors] : errors,
        "Ephemeral fixture custody cleanup failed",
      );
    if (primaryFailed) throw primaryError;
  });
}
