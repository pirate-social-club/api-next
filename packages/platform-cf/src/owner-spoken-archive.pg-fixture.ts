// Actual maintained inventory through257, expected256; no SQL supplement or
// fixture creator. All producer rows come from accepted original CP utility.
import { expect } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { Schema } from "effect";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { type CheckpointFixture, checkpointFixture } from "./owner-spoken-checkpoint.pg-fixture.ts";
import type { PreparedSongFixtureOptions } from "./owner-study-starter.pg-fixture.ts";
import { hash, pgUrl, q } from "./owner-study-starter.pg-fixture.ts";
import type { PostgresMigration } from "./postgres-migrations.ts";
export type ArchiveFixture = CheckpointFixture;
const newCallbacks = [
  "read_guest_audio_io_capture_private_v1(text)",
  "require_guest_audio_io_capture_private_v1(jsonb)",
  "resolve_guest_audio_io_capture_private_v1(jsonb,jsonb,text,text,bigint,text)",
  "claim_guest_audio_io_private_v1(jsonb)",
  "settle_guest_audio_io_private_v1(jsonb,text,boolean)",
] as const;
const controlledArchive = newCallbacks.slice(2);
const finalizerLeaves = [
  "acknowledge_owner_guest_spoken_success_v1(jsonb,jsonb,text,text,jsonb,jsonb,text,bigint)",
  "prepare_guest_spoken_finalization_v1(text,jsonb,text)",
  "apply_guest_spoken_item_mutation_v1(text,jsonb,text,jsonb,jsonb,jsonb,jsonb,jsonb)",
  "transition_guest_spoken_answer_v1(text,jsonb,text,jsonb,jsonb,jsonb)",
  "finish_guest_spoken_answer_v1(text,jsonb,text,jsonb,jsonb,jsonb,jsonb)",
] as const;
async function all257(): Promise<readonly PostgresMigration[]> {
  const directory = new URL("../../../db/postgres/migrations/", import.meta.url);
  const manifest = Schema.decodeUnknownSync(
    Schema.Struct({
      algorithm: Schema.Literal("sha256"),
      migrations: Schema.Record(Schema.String, Schema.String),
    }),
    { onExcessProperty: "error" },
  )(JSON.parse(await readFile(new URL("checksums.json", directory), "utf8")));
  const names = (await readdir(directory))
    .filter((n) => /^\d{4}_.+\.sql$/u.test(n) && Number(n.slice(0, 4)) <= 257)
    .sort();
  expect(names.map((n) => Number(n.slice(0, 4)))).toEqual(
    Array.from({ length: 257 }, (_, i) => i + 1),
  );
  expect(names[256]).toBe("0257_guest_spoken_audio_archive.sql");
  const all: PostgresMigration[] = [];
  for (const version of names) {
    const sql = await readFile(new URL(version, directory), "utf8"),
      checksum = hash(sql);
    const declared = manifest.migrations[version];
    if (Number(version.slice(0, 4)) <= 247 && declared === undefined)
      throw new Error("Immutable maintained checksum missing");
    if (declared !== undefined) expect(checksum).toBe(declared);
    if (version === names[256])
      expect(checksum).toBe("3c5eb872e14558e28f78e607012d498f6fb7c2e8bae05bbba8911fd2ad9bcfec");
    all.push({ version, sql, checksum });
  }
  return all;
}
export const archiveFixture = (
  use: (f: ArchiveFixture) => Promise<void>,
  options?: PreparedSongFixtureOptions,
) =>
  checkpointFixture(async (f) => {
    if (!pgUrl) throw new Error("Owned loopback PostgreSQL required");
    const all = await all257(),
      prefix = all.slice(0, 256);
    expect(
      (await f.admin.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows,
    ).toEqual(prefix.map(({ version, checksum }) => ({ version, checksum })));
    const scoped = new URL(pgUrl);
    scoped.searchParams.set("options", `-c search_path=${f.schema}`);
    await runPostgresMigrations({
      connectionString: scoped.toString(),
      migrations: all,
      expectedLedger: prefix,
    });
    expect(
      (await f.admin.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows,
    ).toEqual(all.map(({ version, checksum }) => ({ version, checksum })));
    await f.admin.query("SELECT require_guest_practice_only_schema_phase_v1()");
    // BEFORE new archive/finalizer EXECUTE: native owner/schema/pin/private ACL.
    for (const signature of [...newCallbacks, ...finalizerLeaves]) {
      const native = Schema.decodeUnknownSync(
        Schema.Struct({
          owner: Schema.Literal(true),
          namespace: Schema.Literal(true),
          definer: Schema.Literal(true),
          pinned: Schema.Literal(true),
          private: Schema.Literal(true),
        }),
        { onExcessProperty: "error" },
      )(
        (
          await f.admin.query(
            `SELECT p.proowner=c.relowner AS owner,p.pronamespace=c.relnamespace AS namespace,
        p.prosecdef AS definer,p.proconfig @> ARRAY[format('search_path=pg_catalog, %I, pg_temp',n.nspname)] AS pinned,
        NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.grantee<>p.proowner AND a.privilege_type='EXECUTE') AS private
        FROM pg_proc p CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE p.oid=$1::regprocedure AND c.oid='participation_owners'::regclass`,
            [signature],
          )
        ).rows[0],
      );
      expect(native.private).toBe(true);
    }
    // Only3new bounded callbacks. Internal upload-by-ID/capture requirement,
    // raw253 and all core checkpoint/resource/owner helpers stay ungranted.
    for (const signature of [...controlledArchive, ...finalizerLeaves])
      await f.admin.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${q(f.role)}`);
    await use(f);
  }, options);
