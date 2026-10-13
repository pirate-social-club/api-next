// Proposal for root adoption beside platform-cf tests. No external SQL overlay.
import { expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Schema } from "effect";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import {
  type Fixture as AccountFixture,
  fixture as accountFixture,
  bounded,
  hash,
  pgUrl,
  q,
} from "./account-study-producer.pg-fixture.ts";
import {
  type GuestStudyReadinessBindings,
  makeGuestStudyManagedReadiness,
} from "./guest-study-managed-readiness.ts";
import { guestStudyReadinessCandidate as candidate } from "./guest-study-readiness-candidate.ts";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresControlPlaneOptions,
} from "./postgres.ts";
import type { PostgresMigration } from "./postgres-migrations.ts";

export type Profile = keyof typeof candidate.profiles;
type Principal = Readonly<{
  role: string;
  url: string;
  client: Client;
  runtime: (
    options?: PostgresControlPlaneOptions,
  ) => ReturnType<typeof makeDirectPostgresControlPlaneLayer>;
}>;
const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
export const one = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  values: readonly unknown[],
): S["Type"] => {
  if (values.length !== 1) throw new Error("Exactly one owned metadata row required");
  return decode(schema, values[0]);
};
export const rawIdentity = Schema.Struct({
  current_role: Schema.String,
  session_role: Schema.String,
  role_oid: Schema.String,
  database_oid: Schema.String,
  cluster_identifier: Schema.String,
  read_only: Schema.Boolean,
});
export const identityQuery = `SELECT current_user::text AS current_role,session_user::text AS session_role,
 r.oid::text AS role_oid,d.oid::text AS database_oid,c.system_identifier::text AS cluster_identifier,
 current_setting('default_transaction_read_only')='on' AS read_only
 FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_database d ON d.datname=current_database()
 CROSS JOIN pg_catalog.pg_control_system() c WHERE r.rolname=current_user`;

export type ReadinessFixture = AccountFixture &
  Readonly<{
    principals: Readonly<Record<Profile, Principal>>;
    bucket: Readonly<{ put: () => Promise<void>; delete: () => Promise<void> }>;
    ioCalls: () => number;
    bindings: GuestStudyReadinessBindings;
    inspector: ReturnType<typeof makeGuestStudyManagedReadiness>;
    owner: string;
    // Retried before role removal if an owned global ACL/ownership restoration fails.
    registerRestoration: (restore: () => Promise<unknown>) => void;
  }>;

export async function readinessFixture(use: (f: ReadinessFixture) => Promise<void>): Promise<void> {
  await accountFixture(async (f) => {
    const identities: Principal[] = [],
      restorations: Array<() => Promise<unknown>> = [];
    let primaryFailure: unknown;
    try {
      // The maintained Account fixture deliberately ends at the original262
      // producer creation. Extend with the actual FULL declared263 inventory,
      // including every prior ledger row, through the SAME maintained runner.
      // No review SQL supplement, phase substitution or recreated helper exists.
      if (pgUrl === undefined || candidate.ledger.length !== 263)
        throw new Error("Actual adopted native263 readiness candidate required");
      const directory = new URL("../../../db/postgres/migrations/", import.meta.url);
      const manifest = decode(
        Schema.Struct({
          algorithm: Schema.Literal("sha256"),
          migrations: Schema.Record(Schema.String, Schema.String),
        }),
        JSON.parse(await readFile(new URL("checksums.json", directory), "utf8")),
      );
      const all: PostgresMigration[] = [];
      for (const expected of candidate.ledger) {
        const sql = await readFile(new URL(expected.version, directory), "utf8"),
          checksum = hash(sql),
          declared = manifest.migrations[expected.version];
        if (declared === undefined) throw new Error("Maintained native inventory checksum missing");
        expect(checksum).toBe(declared);
        expect(checksum).toBe(expected.checksum);
        all.push({ version: expected.version, checksum, sql });
      }
      expect(all.map((x) => Number(x.version.slice(0, 4)))).toEqual(
        Array.from({ length: 263 }, (_, i) => i + 1),
      );
      expect(
        decode(
          Schema.Array(Schema.Struct({ version: Schema.String, checksum: Schema.String })),
          (
            await f.admin.query(
              'SELECT version,checksum FROM schema_migrations ORDER BY version COLLATE "C"',
            )
          ).rows,
        ),
      ).toEqual(candidate.ledger.slice(0, 262));
      const scoped = new URL(pgUrl);
      scoped.searchParams.set("options", `-c search_path=${f.schema},pg_catalog`);
      await runPostgresMigrations({
        connectionString: scoped.toString(),
        migrations: all,
        expectedLedger: all.slice(0, 262),
      });
      const finalMigration = candidate.ledger[262];
      if (finalMigration === undefined) throw new Error("Actual native263 declaration missing");
      const installed263 = candidate.native_function_bodies.filter(
        (x) => x.source_file === finalMigration.version,
      );
      expect(
        (
          await f.admin.query(
            `SELECT p.proname AS name,
 NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
 WHERE a.grantee<>p.proowner AND a.privilege_type='EXECUTE') AS private
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname=$1 AND p.proname=ANY($2::text[]) ORDER BY p.proname COLLATE "C"`,
            [f.schema, installed263.map((x) => x.name)],
          )
        ).rows,
      ).toEqual(installed263.map((x) => ({ name: x.name, private: true })));
      // New263 ALL-nonowner privacy is inspected before any fixture revoke or
      // actor grant. The private Guest preparation helper NEVER joins a profile.
      const privateGuestPrepare = "prepare_guest_captured_audio_cleanup_private_v1(jsonb)";
      expect(
        (
          await f.admin.query(
            `SELECT p.proowner=o.relowner AS owner,p.pronamespace=o.relnamespace AS namespace,
 p.prosecdef AS definer,p.proconfig=ARRAY[format('search_path=pg_catalog, %I, pg_temp',$1)] AS pinned,
 NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
 WHERE a.grantee<>p.proowner AND a.privilege_type='EXECUTE') AS private
 FROM pg_proc p CROSS JOIN pg_class o WHERE p.oid=$2::regprocedure AND o.oid=$3::regclass`,
            [f.schema, `${f.schema}.${privateGuestPrepare}`, `${f.schema}.participation_owners`],
          )
        ).rows,
      ).toEqual([{ owner: true, namespace: true, definer: true, pinned: true, private: true }]);
      // Genuine native168 frame/source evidence precedes actor-isolation policy.
      expect(
        decode(
          Schema.Array(Schema.Struct({ version: Schema.String, checksum: Schema.String })),
          (
            await f.admin.query(
              'SELECT version,checksum FROM schema_migrations ORDER BY version COLLATE "C"',
            )
          ).rows,
        ),
      ).toEqual(candidate.ledger);
      const native = decode(
        Schema.Array(
          Schema.Struct({
            name: Schema.String,
            owner: Schema.Boolean,
            namespace: Schema.Boolean,
            kind: Schema.String,
            definer: Schema.Boolean,
            configuration: Schema.String,
            body_sha256: Schema.String,
          }),
        ),
        (
          await f.admin.query(
            `SELECT p.proname AS name,p.proowner=o.relowner AS owner,
 p.pronamespace=o.relnamespace AS namespace,p.prokind::text AS kind,p.prosecdef AS definer,
 CASE WHEN p.proconfig IS NULL THEN 'none'
  WHEN p.proconfig=ARRAY[format('search_path=pg_catalog, %I, pg_temp',$1)] THEN 'pinned'
  ELSE 'unreviewed' END AS configuration,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS body_sha256
 FROM pg_catalog.pg_proc p CROSS JOIN pg_catalog.pg_class o
 WHERE o.oid=$2::regclass AND p.pronamespace=o.relnamespace AND p.proname=ANY($3::text[])
 ORDER BY p.proname COLLATE "C"`,
            [
              f.schema,
              `${f.schema}.participation_owners`,
              candidate.native_function_bodies.map((x) => x.name),
            ],
          )
        ).rows,
      );
      expect(native).toEqual(
        candidate.native_function_bodies.map((x) => ({
          name: x.name,
          owner: true,
          namespace: true,
          kind: x.kind,
          definer: x.definer,
          configuration: x.configuration,
          body_sha256: x.body_sha256,
        })),
      );
      const owner = one(
        Schema.Struct({ owner: Schema.String }),
        (
          await f.admin.query(
            "SELECT pg_get_userbyid(relowner)::text AS owner FROM pg_class WHERE oid='participation_owners'::regclass",
          )
        ).rows,
      ).owner;
      // Historical PUBLIC function grants are removed as explicit actor isolation
      // AFTER native installation/frame evidence. This earns no new native ACL credit.
      await f.admin.query(`REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ${q(f.schema)} FROM PUBLIC`);

      const createPrincipal = async (profile: Profile): Promise<Principal> => {
        if (pgUrl === undefined) throw new Error("Owned loopback PostgreSQL URL required");
        const role = `ready_${profile.toLowerCase()}_${crypto.randomUUID().replaceAll("-", "")}`;
        const password = hash(randomBytes(32)); // Synthetic in-memory fixture secret only.
        const url = new URL(pgUrl);
        url.username = role;
        url.password = password;
        url.searchParams.set("options", `-c search_path=${f.schema},pg_catalog`);
        const client = new Client({
          connectionString: url.toString(),
          connectionTimeoutMillis: 3000,
          statement_timeout: 3000,
          query_timeout: 4000,
        });
        const principal: Principal = {
          role,
          url: url.toString(),
          client,
          runtime: (options) =>
            makeDirectPostgresControlPlaneLayer(url.toString(), {
              connectTimeoutMs: 3000,
              closeTimeoutMs: 1500,
              ...options,
            }),
        };
        const command = one(
          Schema.Struct({ sql: Schema.String }),
          (
            await f.admin.query(
              "SELECT format('CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',$1::text,$2::text) AS sql",
              [role, password],
            )
          ).rows,
        ).sql;
        await f.admin.query(command);
        identities.push(principal); // Track immediately, including partial admission failures.
        await f.admin.query(
          `ALTER ROLE ${q(role)} SET default_transaction_read_only=${profile === "publicRead" || profile === "observer" ? "on" : "off"}`,
        );
        await f.admin.query(`GRANT USAGE ON SCHEMA ${q(f.schema)} TO ${q(role)}`);
        await f.admin.query(
          `GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ${q(role)}`,
        );
        for (const signature of candidate.profiles[profile].functions)
          await f.admin.query(
            `GRANT EXECUTE ON FUNCTION ${q(f.schema)}.${signature} TO ${q(role)}`,
          );
        const columns: Readonly<Record<string, readonly string[]>> =
          candidate.profiles[profile].columns;
        for (const [table, names] of Object.entries(columns))
          await f.admin.query(
            `GRANT SELECT (${names.map(q).join(",")}) ON ${q(f.schema)}.${q(table)} TO ${q(role)}`,
          );
        await bounded(client.connect(), "four-role authenticated connect", 4000);
        return principal;
      };
      // Four separately authenticated real LOGINs, not SET ROLE on an admin socket.
      const learning = await createPrincipal("learning"),
        publicRead = await createPrincipal("publicRead"),
        cron = await createPrincipal("cron"),
        observer = await createPrincipal("observer");
      const principals = { learning, publicRead, cron, observer };
      let io = 0;
      const bucket = Object.freeze({
        put: async () => {
          io += 1;
        },
        delete: async () => {
          io += 1;
        },
      });
      const bindings: GuestStudyReadinessBindings = {
        learning: learning.runtime(),
        publicRead: publicRead.runtime(),
        cron: cron.runtime(),
        observer: observer.runtime(),
        schema: f.schema,
        workerLearnerAudioBinding: bucket,
        selectedLearnerAudioBinding: bucket,
      };
      await use({
        ...f,
        principals,
        bucket,
        bindings,
        owner,
        inspector: makeGuestStudyManagedReadiness(bindings),
        ioCalls: () => io,
        registerRestoration: (restore) => restorations.push(restore),
      });
    } catch (error) {
      primaryFailure = error;
      throw error;
    } finally {
      const failures: Error[] = [];
      const attempt = async (label: string, action: () => Promise<unknown>) => {
        try {
          await bounded(action(), label, 5000);
        } catch {
          failures.push(new Error(`Owned readiness cleanup failed: ${label}`));
        }
      };
      // Restore owned PUBLIC/system-object changes BEFORE any DROP OWNED. Never
      // allow failed restoration to turn role cleanup into dropping a builtin.
      for (const restore of restorations.reverse())
        await attempt("owned metadata restoration", restore);
      for (const principal of identities.reverse()) {
        await attempt("runtime socket close", () => principal.client.end());
        let ownershipKnown = false;
        let ownsBuiltin = true;
        await attempt("owned catalogue ownership probe", async () => {
          ownsBuiltin = one(
            Schema.Struct({ owns: Schema.Boolean }),
            (
              await f.admin.query(
                `SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='pg_catalog' AND p.proowner=(SELECT oid FROM pg_roles WHERE rolname=$1)) AS owns`,
                [principal.role],
              )
            ).rows,
          ).owns;
          ownershipKnown = true;
        });
        // Unknown metadata is no permission to DROP OWNED. Continue draining
        // the other tracked principals even if this probe failed or timed out.
        if (!ownershipKnown) continue;
        if (ownsBuiltin) {
          failures.push(
            new Error(
              "Owned readiness catalogue ownership restoration incomplete; destructive role cleanup refused",
            ),
          );
          continue;
        }
        await attempt("owned runtime grant removal", () =>
          f.admin.query(`DROP OWNED BY ${q(principal.role)}`),
        );
        await attempt("owned runtime login removal", () =>
          f.admin.query(`DROP ROLE ${q(principal.role)}`),
        );
      }
      if (failures.length > 0)
        throw new AggregateError(
          primaryFailure === undefined ? failures : [primaryFailure, ...failures],
          "Owned readiness cleanup incomplete",
        );
    }
  });
}
