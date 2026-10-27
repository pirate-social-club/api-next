// Genuine PostgreSQL proposals. No synthetic SQL-success rows or external SQL.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { RecoveryAccess } from "@pirate/application";
import { Schema } from "effect";
import { Client } from "pg";
import { bounded, hash, pgUrl, q, run } from "./account-study-producer.pg-fixture.ts";
import { makeControlPlaneGuestProofAuthority } from "./guest-proof-verifier.ts";
import { makeGuestRecoveryAudioDeletionStores } from "./guest-recovery-deletion-store.ts";
import {
  identityQuery,
  one,
  type Profile,
  type ReadinessFixture,
  rawIdentity,
  readinessFixture,
} from "./guest-study-managed-readiness.pg-fixture.ts";
import { makeGuestStudyManagedReadiness } from "./guest-study-managed-readiness.ts";
import { guestStudyReadinessCandidate as candidate } from "./guest-study-readiness-candidate.ts";
import { aclSql } from "./guest-study-readiness-sql.ts";
import { makeControlPlaneOwnerStudyMutations } from "./owner-study-mutations.ts";
import { bytesBase64Url, origin } from "./owner-study-starter.pg-fixture.ts";
import { makeControlPlaneOwnerStudyStarter } from "./owner-study-starter.ts";
import { makeDirectPostgresControlPlaneLayer, type PostgresClientFactory } from "./postgres.ts";

const pgTest = pgUrl ? test : test.skip;

pgTest("each LOGIN ACL audit retains its native bounds during cumulative catalogue latency", () =>
  readinessFixture(async (f) => {
    const before = await fingerprint(f);
    const auditTransactions: number[] = [];
    let nextTransaction = 0;
    const clientFactory: PostgresClientFactory = (_url, config) => {
      const client = new Client(config);
      client.on("error", () => {});
      let transaction = 0;
      return {
        connection: client.connection,
        connect: () => client.connect(),
        end: () => client.end(),
        query: async ({ text, values }) => {
          if (text.startsWith("BEGIN")) transaction = ++nextTransaction;
          if (text === aclSql) {
            auditTransactions.push(transaction);
            // Real PostgreSQL execution under the existing2s statement and3s
            // transaction limits; four ordinary audits exceed one transaction.
            await client.query("SELECT pg_sleep(0.8)");
          }
          const result = await client.query({
            text,
            values: values === undefined ? [] : [...values],
          });
          if (text.includes("current_setting('transaction_timeout') AS transaction"))
            expect(result.rows).toEqual([
              { transaction: "3s", lock: "250ms", statement: "2s", idle: "2s" },
            ]);
          return result;
        },
      };
    };
    const inspector = makeGuestStudyManagedReadiness({
      ...f.bindings,
      observer: f.principals.observer.runtime({ clientFactory }),
    });
    const admitted = await inspector.verify();
    expect(admitted.identities.map(({ profile }) => profile).sort()).toEqual([
      "cron",
      "learning",
      "observer",
      "publicRead",
    ]);
    expect(auditTransactions).toHaveLength(4);
    expect(new Set(auditTransactions).size).toBe(4);
    expect(await fingerprint(f)).toEqual(before);
    expect(f.ioCalls()).toBe(0);
  }),
);

const refused = async (inspector: ReturnType<typeof makeGuestStudyManagedReadiness>) => {
  await expect(inspector.verify()).rejects.toThrow("Managed Guest Study readiness unavailable");
};
async function fingerprint(f: ReadinessFixture) {
  return one(
    Schema.Struct({
      ledger_hash: Schema.String,
      phase: Schema.String,
      owners: Schema.Int,
      credentials: Schema.Int,
      operations: Schema.Int,
      resources: Schema.Int,
      checkpoints: Schema.Int,
      deletes: Schema.Int,
    }),
    (
      await f.admin.query(`SELECT
 encode(sha256(convert_to((SELECT jsonb_agg(to_jsonb(s) ORDER BY version)::text FROM schema_migrations s),'UTF8')),'hex') AS ledger_hash,
 (SELECT phase FROM guest_learning_schema_phase WHERE singleton) AS phase,
 (SELECT count(*)::int FROM participation_owners) AS owners,
 (SELECT count(*)::int FROM guest_credentials) AS credentials,
 (SELECT count(*)::int FROM guest_participation_operations) AS operations,
 (SELECT count(*)::int FROM guest_resource_session_reservations) AS resources,
 (SELECT count(*)::int FROM guest_study_spoken_checkpoints) AS checkpoints,
 (SELECT count(*)::int FROM learner_audio_delete_commands) AS deletes`)
    ).rows,
  );
}
async function fault(
  f: ReadinessFixture,
  apply: () => Promise<unknown>,
  restore: () => Promise<unknown>,
) {
  let armed = false;
  const unwind = async () => {
    if (armed) {
      await restore();
      armed = false;
    }
  };
  f.registerRestoration(unwind);
  armed = true;
  let primaryFailure: unknown;
  let primaryFailed = false;
  const cleanupFailures: unknown[] = [];
  try {
    await apply();
    await refused(f.inspector);
  } catch (error) {
    primaryFailure = error;
    primaryFailed = true;
  } finally {
    try {
      await unwind();
    } catch (cleanupFailure) {
      cleanupFailures.push(cleanupFailure);
    }
  }
  if (cleanupFailures.length > 0)
    throw new AggregateError(
      primaryFailed ? [primaryFailure, ...cleanupFailures] : cleanupFailures,
      "Owned readiness fault restoration failed",
    );
  if (primaryFailed) throw primaryFailure;
  // Reuse the SAME verifier after a positive/fault/restore sequence: no TTL credit.
  await f.inspector.verify();
}
const nativeSignature = (f: ReadinessFixture, signature: string) => `${q(f.schema)}.${signature}`;
const metadata = async (f: ReadinessFixture, signature: string) =>
  one(
    Schema.Struct({
      owner: Schema.String,
      acl: Schema.NullOr(Schema.String),
      body_hash: Schema.String,
    }),
    (
      await f.admin.query(
        `SELECT pg_get_userbyid(p.proowner)::text AS owner,p.proacl::text AS acl,
 encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS body_hash FROM pg_proc p WHERE p.oid=$1::regprocedure`,
        [signature],
      )
    ).rows,
  );
async function finances(f: ReadinessFixture) {
  const rows: Array<Readonly<{ table: string; count: number; digest: string }>> = [];
  for (const table of [
    "activity_qualifications",
    "song_streak_days",
    "community_streak_days",
    "megapot_pool_shares",
    "megapot_ticket_inventory",
    "reward_ledger_credits",
  ]) {
    const actual = one(
      Schema.Struct({ count: Schema.Int, digest: Schema.String }),
      (
        await f.admin.query(`SELECT count(*)::int AS count,encode(sha256(convert_to(
 COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text,'UTF8')),'hex') AS digest
 FROM ${q(f.schema)}.${q(table)} t`)
      ).rows,
    );
    rows.push({ table, ...actual });
  }
  return rows;
}

pgTest(
  "native263 four real LOGINs admit exact profiles; no ingress mutation or I/O; configuration-free durable Guest recovery status",
  () =>
    readinessFixture(async (f) => {
      const before = await fingerprint(f);
      const actual: Array<Schema.Schema.Type<typeof rawIdentity> & Readonly<{ profile: Profile }>> =
        [];
      for (const profile of ["learning", "publicRead", "cron", "observer"] as const) {
        const principal = f.principals[profile];
        const identity = one(rawIdentity, (await principal.client.query(identityQuery)).rows);
        expect(identity.current_role).toBe(principal.role);
        expect(identity.session_role).toBe(principal.role);
        expect(identity.read_only).toBe(profile === "publicRead" || profile === "observer");
        actual.push({ profile, ...identity });
        for (const table of [
          "participation_owners",
          "guest_credentials",
          "guest_study_spoken_checkpoints",
        ])
          await expect(
            principal.client.query(`SELECT 1 FROM ${q(f.schema)}.${q(table)} LIMIT 1`),
          ).rejects.toMatchObject({ code: "42501" });
        await expect(
          principal.client.query(
            `SELECT ${q(f.schema)}.lock_learner_audio_sources_private_v1('{}'::text[])`,
          ),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          principal.client.query(
            `SELECT ${q(f.schema)}.prepare_guest_captured_audio_cleanup_private_v1('{}'::jsonb)`,
          ),
        ).rejects.toMatchObject({ code: "42501" });
        expect(
          one(
            Schema.Struct({ allowed: Schema.Boolean }),
            (
              await principal.client.query(
                "SELECT has_function_privilege(current_user,'pg_catalog.pg_read_file(text)'::regprocedure,'EXECUTE') AS allowed",
              )
            ).rows,
          ).allowed,
        ).toBe(false);
      }
      expect(new Set(actual.map((x) => x.role_oid)).size).toBe(4);
      expect(new Set(actual.map((x) => x.database_oid)).size).toBe(1);
      expect(new Set(actual.map((x) => x.cluster_identifier)).size).toBe(1);
      const admitted = await f.inspector.verify();
      expect(admitted.phase).toBe(candidate.native_phase);
      expect(admitted.identities).toEqual(
        actual.map((x) => ({ profile: x.profile, roleOid: x.role_oid })),
      );
      expect(await fingerprint(f)).toEqual(before);
      expect(f.ioCalls()).toBe(0);

      // Genuine native issue -> strict actual proof reader -> confirm -> strict
      // actual confirmed proof. No asserted credential state/root or caller lease.
      const credentialId = bytesBase64Url(randomBytes(16)),
        digest = hash(randomBytes(32)),
        proposedOwner = `owner_${crypto.randomUUID()}`,
        key = "readiness-real-bootstrap";
      const finance = await finances(f);
      await f.principals.learning.client.query(
        `SELECT ${q(f.schema)}.issue_guest_pending_v1($1,'{}'::text[],NULL,$2,$3,$4,$5,$6,$7)`,
        [
          origin,
          key,
          hash(key),
          "readiness-bootstrap-operation",
          proposedOwner,
          credentialId,
          digest,
        ],
      );
      const authority = makeControlPlaneGuestProofAuthority(f.principals.learning.runtime());
      const proofInput = {
        origin,
        credentialProofs: [{ credentialId, digest }],
        intentProofs: [],
        cleanup: false,
      };
      const pending = await run(authority.verifier.verify(proofInput));
      const selected = pending.provedCredentials[0];
      if (selected === undefined || selected.state !== "pending_bootstrap")
        throw new Error("Real pending native proof required");
      await f.principals.learning.client.query(
        `SELECT ${q(f.schema)}.confirm_guest_pending_v1($1,$2::text[],$3,$4)`,
        [
          origin,
          pending.provedCredentials.map((p) => p.credentialId),
          selected.credentialId,
          selected.ownerId,
        ],
      );
      const confirmed = (await run(authority.verifier.verify(proofInput))).provedCredentials[0];
      if (confirmed === undefined || confirmed.state !== "confirmed")
        throw new Error("Real confirmed native proof required");
      const access: RecoveryAccess = {
        kind: "guest",
        ownerId: confirmed.ownerId,
        credentialId: confirmed.credentialId,
        origin: confirmed.origin,
      };
      // Current NEW-only policy/disclosure can be absent without being fabricated to
      // instantiate recovery. These real SDK constructors keep explicit NULL config.
      makeControlPlaneOwnerStudyStarter(f.principals.learning.runtime(), null, null);
      makeControlPlaneOwnerStudyMutations(f.principals.learning.runtime(), {
        rawPolicy: null,
        disclosureVersion: null,
        rerecordEnabled: false,
        providerRetention: "stored",
      });
      await f.inspector.verify();
      const deletion = makeGuestRecoveryAudioDeletionStores(
        f.principals.learning.runtime(),
      ).deletion;
      const operation = {
        sourceOwnerId: confirmed.ownerId,
        kind: "learner_audio_deletion" as const,
        idempotencyKey: "readiness-real-empty-audio-delete",
        requestHash: hash("readiness-real-empty-audio-delete"),
      };
      const prepared = await run(
        deletion.prepareBatch({ access, operation, maximumArtifacts: 10 }),
      );
      if (prepared.state !== "completed")
        throw new Error("Actual committed deletion batch required");
      expect(prepared.result.artifacts).toEqual([]); // Actual empty owned target, no fake receipt.
      const complete = await run(
        deletion.confirmBatch({
          batch: prepared.result,
          storageDisposition: "absent",
          deletedAt: new Date().toISOString(),
        }),
      );
      if (complete.state !== "completed")
        throw new Error("Actual committed empty-target confirmation required");
      await f.inspector.verify();
      expect(
        await run(
          deletion.findOperation({
            access,
            sourceOwnerId: confirmed.ownerId,
            idempotencyKey: operation.idempotencyKey,
          }),
        ),
      ).toEqual(complete.result);
      expect(complete.result.state).toBe("completed");
      expect(complete.result.operation.operation_id).toBe(complete.outcomeId);
      expect(await finances(f)).toEqual(finance);
      expect(f.ioCalls()).toBe(0);
    }),
  180000,
);

pgTest(
  "native readiness refuses missing/broader leaf and column grants, observer rows, writable schema and SET/MEMBER role power without stale admission",
  () =>
    readinessFixture(async (f) => {
      await f.inspector.verify();
      const learning = q(f.principals.learning.role),
        reader = q(f.principals.publicRead.role),
        cron = q(f.principals.cron.role),
        observer = q(f.principals.observer.role);
      const required = nativeSignature(
          f,
          "read_guest_learning_lease_observation_v1(text,text,text)",
        ),
        privateHelper = nativeSignature(
          f,
          "require_guest_audio_recovery_access_private_v1(jsonb,text)",
        );
      await fault(
        f,
        () => f.admin.query(`REVOKE EXECUTE ON FUNCTION ${required} FROM ${learning}`),
        () => f.admin.query(`GRANT EXECUTE ON FUNCTION ${required} TO ${learning}`),
      );
      await fault(
        f,
        () => f.admin.query(`GRANT EXECUTE ON FUNCTION ${privateHelper} TO ${learning}`),
        () => f.admin.query(`REVOKE EXECUTE ON FUNCTION ${privateHelper} FROM ${learning}`),
      );
      const closedRead = nativeSignature(f, "read_guest_spoken_closed_recovery_v1(text)"),
        browserIssue = nativeSignature(
          f,
          "issue_guest_pending_v1(text,text[],text,text,text,text,text,text,text)",
        );
      await fault(
        f,
        () => f.admin.query(`REVOKE EXECUTE ON FUNCTION ${closedRead} FROM ${cron}`),
        () => f.admin.query(`GRANT EXECUTE ON FUNCTION ${closedRead} TO ${cron}`),
      );
      await fault(
        f,
        () => f.admin.query(`GRANT EXECUTE ON FUNCTION ${browserIssue} TO ${cron}`),
        () => f.admin.query(`REVOKE EXECUTE ON FUNCTION ${browserIssue} FROM ${cron}`),
      );
      const privateGuestPrepare = nativeSignature(
        f,
        "prepare_guest_captured_audio_cleanup_private_v1(jsonb)",
      );
      await fault(
        f,
        () => f.admin.query(`GRANT EXECUTE ON FUNCTION ${privateGuestPrepare} TO ${cron}`),
        () => f.admin.query(`REVOKE EXECUTE ON FUNCTION ${privateGuestPrepare} FROM ${cron}`),
      );
      await fault(
        f,
        () =>
          f.admin.query(
            `REVOKE SELECT(lyrics_sha256) ON ${q(f.schema)}.media_song_lyrics_revisions FROM ${reader}`,
          ),
        () =>
          f.admin.query(
            `GRANT SELECT(lyrics_sha256) ON ${q(f.schema)}.media_song_lyrics_revisions TO ${reader}`,
          ),
      );
      await fault(
        f,
        () =>
          f.admin.query(`GRANT SELECT ON ${q(f.schema)}.media_song_lyrics_revisions TO ${reader}`),
        async () => {
          await f.admin.query(
            `REVOKE SELECT ON ${q(f.schema)}.media_song_lyrics_revisions FROM ${reader}`,
          );
          // PostgreSQL table REVOKE also removes corresponding column grants.
          // Restore only the exact original source-bound public reader columns.
          await f.admin.query(
            `GRANT SELECT(${candidate.profiles.publicRead.columns.media_song_lyrics_revisions.map(q).join(",")}) ON ${q(f.schema)}.media_song_lyrics_revisions TO ${reader}`,
          );
        },
      );
      await fault(
        f,
        () =>
          f.admin.query(
            `REVOKE SELECT(checksum) ON ${q(f.schema)}.schema_migrations FROM ${observer}`,
          ),
        () =>
          f.admin.query(
            `GRANT SELECT(checksum) ON ${q(f.schema)}.schema_migrations TO ${observer}`,
          ),
      );
      await fault(
        f,
        () => f.admin.query(`GRANT SELECT ON ${q(f.schema)}.guest_credentials TO ${observer}`),
        () => f.admin.query(`REVOKE SELECT ON ${q(f.schema)}.guest_credentials FROM ${observer}`),
      );
      await fault(
        f,
        () => f.admin.query(`GRANT INSERT ON ${q(f.schema)}.guest_credentials TO ${learning}`),
        () => f.admin.query(`REVOKE INSERT ON ${q(f.schema)}.guest_credentials FROM ${learning}`),
      );
      await fault(
        f,
        () =>
          f.admin.query(
            `GRANT USAGE ON SEQUENCE ${q(f.schema)}.learner_audio_fence_revision_v1 TO ${learning}`,
          ),
        () =>
          f.admin.query(
            `REVOKE USAGE ON SEQUENCE ${q(f.schema)}.learner_audio_fence_revision_v1 FROM ${learning}`,
          ),
      );
      await fault(
        f,
        () => f.admin.query(`GRANT CREATE ON SCHEMA ${q(f.schema)} TO ${learning}`),
        () => f.admin.query(`REVOKE CREATE ON SCHEMA ${q(f.schema)} FROM ${learning}`),
      );
      const danger = `ready_set_${crypto.randomUUID().replaceAll("-", "")}`;
      await f.admin.query(
        `CREATE ROLE ${q(danger)} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS`,
      );
      let exists = true;
      const drop = async () => {
        if (exists) {
          await f.admin.query(`DROP ROLE ${q(danger)}`);
          exists = false;
        }
      };
      f.registerRestoration(drop);
      let privilegedRoleFailure: unknown;
      let privilegedRoleFailed = false;
      const privilegedRoleCleanupFailures: unknown[] = [];
      try {
        await fault(
          f,
          () => f.admin.query(`GRANT ${q(danger)} TO ${learning} WITH INHERIT FALSE, SET TRUE`),
          () => f.admin.query(`REVOKE ${q(danger)} FROM ${learning}`),
        );
        await fault(
          f,
          () => f.admin.query(`GRANT ${q(f.owner)} TO ${learning} WITH INHERIT TRUE, SET FALSE`),
          () => f.admin.query(`REVOKE ${q(f.owner)} FROM ${learning}`),
        );
      } catch (error) {
        privilegedRoleFailure = error;
        privilegedRoleFailed = true;
      } finally {
        try {
          await drop();
        } catch (cleanupFailure) {
          privilegedRoleCleanupFailures.push(cleanupFailure);
        }
      }
      if (privilegedRoleCleanupFailures.length > 0)
        throw new AggregateError(
          privilegedRoleFailed
            ? [privilegedRoleFailure, ...privilegedRoleCleanupFailures]
            : privilegedRoleCleanupFailures,
          "Owned privileged-role removal incomplete",
        );
      if (privilegedRoleFailed) throw privilegedRoleFailure;
      expect(f.ioCalls()).toBe(0);
    }),
  180000,
);

pgTest(
  "actual internal helper frame/body drift, ledger/phase closure and independently selected storage faults refuse and restore",
  () =>
    readinessFixture(async (f) => {
      await f.inspector.verify();
      const signature = nativeSignature(
        f,
        "require_guest_audio_recovery_access_private_v1(jsonb,text)",
      );
      const before = await metadata(f, signature);
      await fault(
        f,
        () => f.admin.query(`ALTER FUNCTION ${signature} SET search_path TO pg_temp,pg_catalog`),
        () =>
          f.admin.query(
            `ALTER FUNCTION ${signature} SET search_path TO pg_catalog,${q(f.schema)},pg_temp`,
          ),
      );
      expect(await metadata(f, signature)).toEqual(before);
      await fault(
        f,
        () => f.admin.query(`ALTER FUNCTION ${signature} SECURITY INVOKER`),
        () => f.admin.query(`ALTER FUNCTION ${signature} SECURITY DEFINER`),
      );
      expect(await metadata(f, signature)).toEqual(before);
      const definition = one(
        Schema.Struct({ definition: Schema.String }),
        (
          await f.admin.query("SELECT pg_get_functiondef($1::regprocedure) AS definition", [
            signature,
          ])
        ).rows,
      ).definition;
      const marker = /AS (\$[A-Za-z_0-9]*\$)/u.exec(definition);
      if (marker === null) throw new Error("Genuine native plpgsql body delimiter missing");
      const changed = definition.replace(
        marker[0],
        `${marker[0]}\n-- Owned body-only readiness refusal probe.\n`,
      );
      await fault(
        f,
        async () => {
          await f.admin.query(changed);
          const observed = await metadata(f, signature);
          expect(observed.owner).toBe(before.owner);
          expect(observed.acl).toBe(before.acl);
          expect(observed.body_hash).not.toBe(before.body_hash);
        },
        () => f.admin.query(definition),
      );
      expect(await metadata(f, signature)).toEqual(before);
      const last = candidate.ledger[262];
      if (last === undefined) throw new Error("Exact native263 ledger row missing");
      await fault(
        f,
        () =>
          f.admin.query("UPDATE schema_migrations SET checksum=$2 WHERE version=$1", [
            last.version,
            "0".repeat(64),
          ]),
        () =>
          f.admin.query("UPDATE schema_migrations SET checksum=$2 WHERE version=$1", [
            last.version,
            last.checksum,
          ]),
      );
      await fault(
        f,
        () =>
          f.admin.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)", [
            "9999_owned_readiness_probe.sql",
            "0".repeat(64),
          ]),
        () =>
          f.admin.query("DELETE FROM schema_migrations WHERE version=$1", [
            "9999_owned_readiness_probe.sql",
          ]),
      );
      await fault(
        f,
        () => f.admin.query("DELETE FROM guest_learning_schema_phase WHERE singleton"),
        () =>
          f.admin.query(
            "INSERT INTO guest_learning_schema_phase(singleton,phase) VALUES(TRUE,$1) ON CONFLICT(singleton) DO UPDATE SET phase=EXCLUDED.phase",
            [candidate.native_phase],
          ),
      );
      await fault(
        f,
        () =>
          f.admin.query(
            `CREATE TABLE ${q(f.schema)}.guest_owner_associations(owned_probe BOOLEAN)`,
          ),
        () => f.admin.query(`DROP TABLE ${q(f.schema)}.guest_owner_associations`),
      );
      await fault(
        f,
        () =>
          f.admin.query(
            `ALTER TABLE ${q(f.schema)}.guest_study_spoken_captures ALTER COLUMN captured_platform_retention SET DEFAULT 'private_learning'`,
          ),
        () =>
          f.admin.query(
            `ALTER TABLE ${q(f.schema)}.guest_study_spoken_captures ALTER COLUMN captured_platform_retention DROP DEFAULT`,
          ),
      );
      const retentionCheck = one(
        Schema.Struct({ definition: Schema.String }),
        (
          await f.admin.query(
            `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
 WHERE conrelid=$1::regclass AND conname='guest_capture_retention_shape'`,
            [`${f.schema}.guest_study_spoken_captures`],
          )
        ).rows,
      ).definition;
      // Restore the real database's canonical CHECK definition. No invented
      // canonical expression hash or external source definition is substituted.
      await fault(
        f,
        () =>
          f.admin.query(
            `ALTER TABLE ${q(f.schema)}.guest_study_spoken_captures DROP CONSTRAINT guest_capture_retention_shape`,
          ),
        () =>
          f.admin.query(
            `ALTER TABLE ${q(f.schema)}.guest_study_spoken_captures ADD CONSTRAINT guest_capture_retention_shape ${retentionCheck}`,
          ),
      );
      await fault(
        f,
        () =>
          f.admin.query(
            `ALTER TABLE ${q(f.schema)}.guest_study_spoken_captures DISABLE TRIGGER guest_audio_retention_capture`,
          ),
        () =>
          f.admin.query(
            `ALTER TABLE ${q(f.schema)}.guest_study_spoken_captures ENABLE TRIGGER guest_audio_retention_capture`,
          ),
      );
      for (const binding of [undefined, Object.freeze({}), Object.freeze({ put: f.bucket.put })])
        await refused(
          makeGuestStudyManagedReadiness({
            ...f.bindings,
            workerLearnerAudioBinding: binding,
            selectedLearnerAudioBinding: binding,
          }),
        );
      await refused(
        makeGuestStudyManagedReadiness({
          ...f.bindings,
          selectedLearnerAudioBinding: Object.freeze({
            put: f.bucket.put,
            delete: f.bucket.delete,
          }),
        }),
      );
      await f.inspector.verify();
      expect(f.ioCalls()).toBe(0);
    }),
  180000,
);

pgTest(
  "real restricted catalogue PUBLIC/ownership/metadata faults, duplicate LOGIN, different database and acknowledged readonly COMMIT loss close admission",
  () =>
    readinessFixture(async (f) => {
      await f.inspector.verify();
      // All actual LOGIN profiles retain observation/configuration while the
      // proven native PUBLIC table mutation capability is absent.
      for (const principal of Object.values(f.principals)) {
        expect(
          one(
            Schema.Struct({
              select_allowed: Schema.Boolean,
              update_allowed: Schema.Boolean,
              column_update_allowed: Schema.Boolean,
              set_config_allowed: Schema.Boolean,
            }),
            (
              await principal.client.query(`SELECT
 has_table_privilege(current_user,'pg_catalog.pg_settings','SELECT') AS select_allowed,
 has_table_privilege(current_user,'pg_catalog.pg_settings','UPDATE') AS update_allowed,
 has_any_column_privilege(current_user,'pg_catalog.pg_settings','UPDATE') AS column_update_allowed,
 has_function_privilege(current_user,'pg_catalog.set_config(text,text,boolean)','EXECUTE') AS set_config_allowed`)
            ).rows,
          ),
        ).toEqual({
          select_allowed: true,
          update_allowed: false,
          column_update_allowed: false,
          set_config_allowed: true,
        });
      }
      // Actual catalogue mutation fault: the SAME unchanged verifier must refuse
      // restored PUBLIC UPDATE, then accept again after the exact narrow revoke.
      await fault(
        f,
        () => f.admin.query("GRANT UPDATE ON TABLE pg_catalog.pg_settings TO PUBLIC"),
        () => f.admin.query("REVOKE UPDATE ON TABLE pg_catalog.pg_settings FROM PUBLIC"),
      );
      for (const signature of [
        "pg_catalog.pg_read_file(text)",
        "pg_catalog.pg_read_binary_file(text)",
      ]) {
        const prior = await metadata(f, signature);
        const publicAllowed = one(
          Schema.Struct({ allowed: Schema.Boolean }),
          (
            await f.admin.query(
              `SELECT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
 WHERE p.oid=$1::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS allowed`,
              [signature],
            )
          ).rows,
        ).allowed;
        expect(publicAllowed).toBe(false);
        await fault(
          f,
          () => f.admin.query(`GRANT EXECUTE ON FUNCTION ${signature} TO PUBLIC`),
          () => f.admin.query(`REVOKE EXECUTE ON FUNCTION ${signature} FROM PUBLIC`),
        );
        expect(await metadata(f, signature)).toEqual(prior);
        // Actual ownership capability is changed; the file reader is NEVER invoked.
        await fault(
          f,
          () =>
            f.admin.query(`ALTER FUNCTION ${signature} OWNER TO ${q(f.principals.learning.role)}`),
          () => f.admin.query(`ALTER FUNCTION ${signature} OWNER TO ${q(prior.owner)}`),
        );
        expect(await metadata(f, signature)).toEqual(prior);
      }
      await fault(
        f,
        () =>
          f.admin.query(
            `REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system() FROM ${q(f.principals.learning.role)}`,
          ),
        () =>
          f.admin.query(
            `GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ${q(f.principals.learning.role)}`,
          ),
      );
      await refused(
        makeGuestStudyManagedReadiness({ ...f.bindings, cron: f.principals.learning.runtime() }),
      );
      if (pgUrl === undefined) throw new Error("Owned loopback PostgreSQL URL missing");
      const database = `ready_db_${crypto.randomUUID().replaceAll("-", "")}`;
      await f.admin.query(`CREATE DATABASE ${q(database)}`);
      let created = true;
      const drop = async () => {
        if (created) {
          await f.admin.query(`DROP DATABASE ${q(database)} WITH (FORCE)`);
          created = false;
        }
      };
      f.registerRestoration(drop);
      let databaseFailure: unknown;
      let databaseFailed = false;
      const databaseCleanupFailures: unknown[] = [];
      try {
        const url = new URL(f.principals.learning.url);
        url.pathname = `/${database}`;
        const peerAdminUrl = new URL(pgUrl);
        peerAdminUrl.pathname = `/${database}`;
        const peerAdmin = new Client({
          connectionString: peerAdminUrl.toString(),
          connectionTimeoutMillis: 3000,
          statement_timeout: 3000,
        });
        const peer = new Client({
          connectionString: url.toString(),
          connectionTimeoutMillis: 3000,
          statement_timeout: 3000,
        });
        let identityFailure: unknown;
        let identityFailed = false;
        const identityCleanupFailures: unknown[] = [];
        try {
          await bounded(peerAdmin.connect(), "owned second-database metadata admission", 4000);
          // pg_proc ACLs are PER DATABASE. Grant only the same readonly metadata
          // capability in this owned second database; source-schema grants do not
          // carry across databases. No private application helper is granted here.
          await peerAdmin.query(
            `GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ${q(f.principals.learning.role)}`,
          );
          await bounded(peer.connect(), "owned second-database identity", 4000);
          const original = one(
              rawIdentity,
              (await f.principals.learning.client.query(identityQuery)).rows,
            ),
            other = one(rawIdentity, (await peer.query(identityQuery)).rows);
          expect(other.current_role).toBe(original.current_role);
          expect(other.cluster_identifier).toBe(original.cluster_identifier);
          expect(other.database_oid).not.toBe(original.database_oid);
        } catch (error) {
          identityFailure = error;
          identityFailed = true;
        } finally {
          // Each close starts independently; one synchronous failure or timeout
          // cannot skip the other owned socket's bounded close.
          const closed = await Promise.allSettled([
            (async () => {
              await bounded(peer.end(), "owned second-database close", 3000);
            })(),
            (async () => {
              await bounded(peerAdmin.end(), "owned second-database admin close", 3000);
            })(),
          ]);
          for (const result of closed)
            if (result.status === "rejected") identityCleanupFailures.push(result.reason);
        }
        if (identityCleanupFailures.length > 0)
          throw new AggregateError(
            identityFailed
              ? [identityFailure, ...identityCleanupFailures]
              : identityCleanupFailures,
            "Owned second-database socket cleanup incomplete",
          );
        if (identityFailed) throw identityFailure;
        await refused(
          makeGuestStudyManagedReadiness({
            ...f.bindings,
            learning: makeDirectPostgresControlPlaneLayer(url.toString(), {
              connectTimeoutMs: 3000,
              closeTimeoutMs: 1500,
            }),
          }),
        );
      } catch (error) {
        databaseFailure = error;
        databaseFailed = true;
      } finally {
        try {
          await drop();
        } catch (cleanupFailure) {
          databaseCleanupFailures.push(cleanupFailure);
        }
      }
      if (databaseCleanupFailures.length > 0)
        throw new AggregateError(
          databaseFailed ? [databaseFailure, ...databaseCleanupFailures] : databaseCleanupFailures,
          "Owned second-database removal incomplete",
        );
      if (databaseFailed) throw databaseFailure;
      // Real observer SELECTs and genuine successful COMMIT precede acknowledgement
      // loss. No fabricated boolean/SQL result or uncertain successful admission.
      let lost = false;
      const clientFactory: PostgresClientFactory = (_url, config) => {
        const client = new Client(config);
        let inspected = false;
        return {
          connection: client.connection,
          connect: () => client.connect(),
          end: () => client.end(),
          query: async ({ text, values }) => {
            const result = await client.query({
              text,
              values: values === undefined ? [] : [...values],
            });
            if (text.includes("schema_migrations ORDER BY")) inspected = true;
            if (text === "COMMIT" && inspected && !lost) {
              lost = true;
              throw new Error("Owned readonly COMMIT acknowledgement withheld");
            }
            return result;
          },
        };
      };
      const before = await fingerprint(f);
      await refused(
        makeGuestStudyManagedReadiness({
          ...f.bindings,
          observer: f.principals.observer.runtime({ clientFactory }),
        }),
      );
      expect(lost).toBe(true);
      expect(await fingerprint(f)).toEqual(before);
      await f.inspector.verify();
      expect(f.ioCalls()).toBe(0);
    }),
  180000,
);
