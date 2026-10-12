// Genuine maintained native0001..0259 suffix only; no outside SQL supplement.
import { expect } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import {
  type RecoveryDeletionFixture,
  recoveryDeletionFixture,
} from "./guest-recovery-deletion.pg-fixture.ts";
import { makeControlPlaneOwnerGuestSpokenCheckpointRecoveryStores } from "./owner-guest-spoken-checkpoint-recovery-store.ts";
import { makeControlPlaneOwnerSpokenCapturedContinuationStore } from "./owner-study-mutations.ts";
import { hash, pgUrl, q } from "./owner-study-starter.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import type { PostgresMigration } from "./postgres-migrations.ts";

const callbacks = [
  "find_owner_guest_spoken_success_for_audio_v1(jsonb,text,text,text,text,integer,text,text,integer,integer)",
  "list_guest_spoken_closed_recovery_v1(integer)",
  "read_guest_spoken_closed_recovery_v1(text)",
] as const;
export type SpokenRecoveryFixture = RecoveryDeletionFixture &
  ReturnType<typeof makeControlPlaneOwnerGuestSpokenCheckpointRecoveryStores> &
  Readonly<{
    continuation: ReturnType<typeof makeControlPlaneOwnerSpokenCapturedContinuationStore>;
  }>;
export const spokenRecoveryFixture = (use: (f: SpokenRecoveryFixture) => Promise<void>) =>
  recoveryDeletionFixture(async (f) => {
    if (!pgUrl) throw new Error("Owned loopback PostgreSQL required");
    const expected259 = "3b84f8f3798e777bd7aa674363add62854d330b9ef12079fa49e2f2b24ea0dc9";
    const directory = new URL("../../../db/postgres/migrations/", import.meta.url);
    const names = (await readdir(directory))
      .filter((name) => /^\d{4}_.+\.sql$/u.test(name) && Number(name.slice(0, 4)) <= 259)
      .sort();
    expect(names.map((name) => Number(name.slice(0, 4)))).toEqual(
      Array.from({ length: 259 }, (_, i) => i + 1),
    );
    expect(names[258]).toBe("0259_guest_captured_recovery_reads.sql");
    const migrations: PostgresMigration[] = [];
    for (const version of names) {
      const sql = await readFile(new URL(version, directory), "utf8"),
        checksum = hash(sql);
      if (Number(version.slice(0, 4)) === 259) expect(checksum).toBe(expected259);
      migrations.push({ version, sql, checksum });
    }
    const prefix = migrations.slice(0, 258);
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
    await f.admin.query("SELECT require_guest_practice_only_schema_phase_v1()");
    // Native PUBLIC/all-nonowner ACL and provenance BEFORE three new grants.
    for (const signature of callbacks) {
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
      ).toEqual([{ owner: true, namespace: true, definer: true, pinned: true, private: true }]);
    }
    for (const signature of callbacks)
      await f.admin.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${q(f.role)}`);
    for (const signature of [
      "load_guest_spoken_success_private_v1(text,jsonb,text,text)",
      "read_guest_audio_io_capture_private_v1(text)",
      "require_guest_audio_recovery_access_private_v1(jsonb,text)",
      "prepare_learner_audio_delete_private_v1(text,text,text,text,text[],text,integer,text)",
    ])
      expect(
        (
          await f.guest.query(
            "SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed",
            [signature],
          )
        ).rows,
      ).toEqual([{ allowed: false }]);
    const runtime = makeDirectPostgresControlPlaneLayer(f.guestUrl, { closeTimeoutMs: 2000 });
    await use({
      ...f,
      ...makeControlPlaneOwnerGuestSpokenCheckpointRecoveryStores(runtime),
      continuation: makeControlPlaneOwnerSpokenCapturedContinuationStore(runtime),
    });
  });
