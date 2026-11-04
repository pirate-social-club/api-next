import { expect } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { makeGuestRecoveryAudioDeletionStores } from "./guest-recovery-deletion-store.ts";
import { type ArchiveFixture, archiveFixture } from "./owner-spoken-archive.pg-fixture.ts";
import { hash, pgUrl, q } from "./owner-study-starter.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import type { PostgresMigration } from "./postgres-migrations.ts";

const signatures = [
  "require_guest_audio_recovery_access_private_v1(jsonb,text)",
  "validate_guest_recovery_operation_private_v1(jsonb,text)",
  "read_guest_owner_audio_delete_batch_private_v1(text)",
  "guest_owner_audio_delete_projection_private_v1(text)",
  "prepare_guest_owner_audio_delete_v1(jsonb,jsonb,integer)",
  "confirm_guest_owner_audio_delete_v1(jsonb,text,timestamptz)",
  "fail_guest_owner_audio_delete_v1(jsonb,text)",
  "find_guest_owner_audio_delete_v1(jsonb,text,text)",
  "set_guest_learning_retention_v1(jsonb,jsonb,text)",
] as const;
export type RecoveryDeletionFixture = ArchiveFixture &
  ReturnType<typeof makeGuestRecoveryAudioDeletionStores>;
export const recoveryDeletionFixture = (use: (f: RecoveryDeletionFixture) => Promise<void>) =>
  archiveFixture(async (f) => {
    if (!pgUrl) throw new Error("Owned PostgreSQL URL required");
    const directory = new URL("../../../db/postgres/migrations/", import.meta.url);
    const names = (await readdir(directory))
      .filter((n) => /^\d{4}_.+\.sql$/u.test(n) && Number(n.slice(0, 4)) <= 258)
      .sort();
    expect(names.map((n) => Number(n.slice(0, 4)))).toEqual(
      Array.from({ length: 258 }, (_, i) => i + 1),
    );
    expect(names[257]).toBe("0258_guest_recovery_audio_deletion.sql");
    const migrations: PostgresMigration[] = [];
    for (const version of names) {
      const sql = await readFile(new URL(version, directory), "utf8"),
        checksum = hash(sql);
      if (version === names[257])
        expect(checksum).toBe("cc9792c45c8938b89025a3e723e58f01f021d93d11b426c7600cfcf677bf9aef");
      migrations.push({ version, sql, checksum });
    }
    const prefix = migrations.slice(0, 257);
    expect(
      (await f.admin.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows,
    ).toEqual(prefix.map(({ version, checksum }) => ({ version, checksum })));
    const url = new URL(pgUrl);
    url.searchParams.set("options", `-c search_path=${f.schema}`);
    await runPostgresMigrations({
      connectionString: url.toString(),
      migrations,
      expectedLedger: prefix,
    });
    expect(
      (await f.admin.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows,
    ).toEqual(migrations.map(({ version, checksum }) => ({ version, checksum })));
    // Inspect installation ACLs before any new controlled fixture grant.
    for (const signature of signatures) {
      expect(
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
        ).rows,
      ).toEqual([
        {
          owner: true,
          namespace: true,
          definer: !signature.startsWith("validate_"),
          pinned: true,
          private: true,
        },
      ]);
    }
    for (const signature of signatures.slice(4))
      await f.admin.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${q(f.role)}`);
    await use({
      ...f,
      ...makeGuestRecoveryAudioDeletionStores(
        makeDirectPostgresControlPlaneLayer(f.guestUrl, { closeTimeoutMs: 2000 }),
      ),
    });
  });
