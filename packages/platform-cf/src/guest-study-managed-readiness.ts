// Proposed platform-cf internal adapter. No grants, secrets, migrations or provider/R2 I/O.
import type {
  ControlPlaneDb,
  ControlPlaneError,
  ControlPlaneTransaction,
} from "@pirate/application";
import { Effect, type Layer, Schema } from "effect";
import { boundedLearnerAudioTransaction } from "./bounded-audio-transaction.ts";
import { guestStudyReadinessCandidate as candidate } from "./guest-study-readiness-candidate.ts";
import {
  aclSql,
  bodiesSql,
  catalogueBoundarySql,
  functionsSql,
  identitySql,
  ledgerSql,
  phaseSql,
  rolesSql,
} from "./guest-study-readiness-sql.ts";

type Runtime = Layer.Layer<ControlPlaneDb, ControlPlaneError, never>;
type Profile = keyof typeof candidate.profiles;
const Identity = Schema.Struct({
  role_name: Schema.NonEmptyString,
  login_name: Schema.NonEmptyString,
  role_oid: Schema.NonEmptyString,
  can_login: Schema.Boolean,
  superuser: Schema.Boolean,
  bypass_rls: Schema.Boolean,
  create_role: Schema.Boolean,
  create_db: Schema.Boolean,
  replication: Schema.Boolean,
  database_name: Schema.NonEmptyString,
  database_oid: Schema.NonEmptyString,
  cluster_identifier: Schema.NonEmptyString,
  control_function_oid: Schema.NonEmptyString,
  server_version: Schema.Int,
  default_read_only: Schema.Boolean,
});
const Acl = Schema.Struct({
  catalog_functions: Schema.Array(Schema.Struct({ function_oid: Schema.String })).check(
    Schema.isMaxLength(10000),
  ),
  columns: Schema.Array(
    Schema.Struct({
      schema_name: Schema.String,
      table_name: Schema.String,
      column_name: Schema.String,
      privilege: Schema.String,
    }),
  ).check(Schema.isMaxLength(10000)),
  tables: Schema.Array(
    Schema.Struct({
      schema_name: Schema.String,
      table_name: Schema.String,
      privilege: Schema.String,
    }),
  ).check(Schema.isMaxLength(10000)),
  sequences: Schema.Array(
    Schema.Struct({
      schema_name: Schema.String,
      sequence_name: Schema.String,
      privilege: Schema.String,
    }),
  ).check(Schema.isMaxLength(10000)),
  functions: Schema.Array(
    Schema.Struct({ schema_name: Schema.String, function_oid: Schema.String }),
  ).check(Schema.isMaxLength(10000)),
});
const Frame = Schema.Struct({
  signature: Schema.String,
  function_oid: Schema.NonEmptyString,
  definer: Schema.Boolean,
  kind: Schema.Literal("f"),
  namespace: Schema.Literal(true),
  owned: Schema.Literal(true),
  pinned: Schema.Literal(true),
  body_sha256: Schema.String,
});
const Body = Schema.Struct({
  name: Schema.String,
  body_sha256: Schema.String,
  owned: Schema.Literal(true),
  namespace: Schema.Literal(true),
  kind: Schema.Literal("f"),
  definer: Schema.Boolean,
  configuration: Schema.Literals(["none", "pinned", "unreviewed"]),
});
const CatalogueBoundary = Schema.Struct({
  violations: Schema.Array(
    Schema.Struct({ object_oid: Schema.String, reason: Schema.String }),
  ).check(Schema.isMaxLength(10000)),
  probes: Schema.Array(
    Schema.Struct({ name: Schema.String, overloads: Schema.Int, restricted_overloads: Schema.Int }),
  ),
});
const Ledger = Schema.Struct({ version: Schema.String, checksum: Schema.String });
class ReadinessRefused extends Error {
  readonly name = "GuestStudyManagedReadinessRefused";
  constructor() {
    super("Managed Guest Study readiness unavailable");
  }
}
const refuse = () => new ReadinessRefused();
const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
const assert = (condition: boolean): void => {
  if (!condition) throw refuse();
};
const rows = (
  tx: ControlPlaneTransaction,
  label: string,
  text: string,
  values: readonly unknown[] = [],
) =>
  tx
    .execute<unknown>({ label, text, values, readonly: true })
    .pipe(Effect.map((result) => result.rows));
const one = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  values: readonly unknown[],
) => {
  assert(values.length === 1);
  return decode(schema, values[0]);
};
/** Actual managed binding objects, never request headers or serialized role claims.
 * Runtime connections are already separately authenticated and schema-pinned.
 * Observer has ONLY ledger(version,checksum)/phase(singleton,phase) column SELECT
 * and pg_catalog visibility, with server default_transaction_read_only=on.
 * All four roles additionally need EXECUTE on the exact readonly
 * pg_catalog.pg_control_system() metadata routine. No pg_monitor membership.
 */
export interface GuestStudyReadinessBindings {
  readonly learning: Runtime;
  readonly publicRead: Runtime;
  readonly cron: Runtime;
  readonly observer: Runtime;
  readonly schema: string;
  /** The actual Worker bindings.LEARNER_AUDIO object is passed independently
   * from the selected graph bucket. Equality is binding selection evidence,
   * not remote object/provider/device acceptance or a PUT/DELETE health probe.
   */
  readonly workerLearnerAudioBinding: object | undefined;
  readonly selectedLearnerAudioBinding: object | undefined;
}
export function makeGuestStudyManagedReadiness(bindings: GuestStudyReadinessBindings) {
  const schema = bindings.schema;
  if (
    !/^[a-z][a-z0-9_]{0,62}$/u.test(schema) ||
    schema.startsWith("pg_") ||
    ["public", "information_schema"].includes(schema)
  )
    throw refuse();
  const quoted = `"${schema}"`;
  const verify = Effect.fn("GuestStudyManagedReadiness.verify")(function* () {
    // Only method presence and EXACT source-selected binding identity are checked.
    // No values, keys, URLs, stored rows, audio or bucket objects are logged.
    yield* Effect.try({
      try: () => {
        const actual = bindings.workerLearnerAudioBinding;
        assert(actual !== undefined && actual === bindings.selectedLearnerAudioBinding);
        assert(
          actual !== undefined &&
            "put" in actual &&
            typeof actual.put === "function" &&
            "delete" in actual &&
            typeof actual.delete === "function",
        );
      },
      catch: refuse,
    });
    const principals: { profile: Profile; identity: Schema.Schema.Type<typeof Identity> }[] = [];
    for (const profile of ["learning", "publicRead", "cron", "observer"] as const) {
      const identity = yield* Effect.gen(function* () {
        return yield* boundedLearnerAudioTransaction((tx) =>
          Effect.gen(function* () {
            const actual = yield* tx.execute<unknown>({
              label: `guest-readiness.${profile}.identity`,
              text: identitySql,
              values: [],
              readonly: true,
            });
            return yield* Effect.try({ try: () => one(Identity, actual.rows), catch: refuse });
          }),
        );
      }).pipe(Effect.provide(bindings[profile]));
      yield* Effect.try({
        try: () => {
          assert(identity.role_name === identity.login_name && identity.can_login);
          assert(
            !identity.superuser &&
              !identity.bypass_rls &&
              !identity.create_role &&
              !identity.create_db &&
              !identity.replication,
          );
          assert(identity.server_version >= 170000 && identity.server_version < 180000);
          assert(
            identity.default_read_only === (profile === "publicRead" || profile === "observer"),
          );
          assert(!principals.some((previous) => previous.identity.role_oid === identity.role_oid));
          assert(
            principals.every(
              (previous) =>
                previous.identity.database_name === identity.database_name &&
                previous.identity.database_oid === identity.database_oid &&
                previous.identity.cluster_identifier === identity.cluster_identifier,
            ),
          );
          principals.push({ profile, identity });
        },
        catch: refuse,
      });
    }
    yield* Effect.gen(function* () {
      return yield* boundedLearnerAudioTransaction((tx) =>
        Effect.gen(function* () {
          const ledger = yield* rows(tx, "guest-readiness.ledger", ledgerSql(quoted));
          yield* Effect.try({
            try: () => {
              const actual = decode(Schema.Array(Ledger).check(Schema.isMaxLength(262)), ledger);
              assert(actual.length === candidate.ledger.length);
              for (let i = 0; i < actual.length; i++) {
                const expected = candidate.ledger[i],
                  observed = actual[i];
                assert(
                  expected !== undefined &&
                    observed !== undefined &&
                    expected.version === observed.version &&
                    expected.checksum === observed.checksum,
                );
              }
            },
            catch: refuse,
          });
          const phase = yield* rows(tx, "guest-readiness.native-phase", phaseSql(quoted), [schema]);
          yield* Effect.try({
            try: () =>
              one(
                Schema.Struct({
                  valid: Schema.Literal(true),
                  phase: Schema.Literal(candidate.native_phase),
                }),
                phase,
              ),
            catch: refuse,
          });
          const frames = yield* rows(tx, "guest-readiness.native-frames", functionsSql, [
            schema,
            candidate.required_frames.map((frame) => frame.signature),
          ]);
          const nativeFrames = yield* Effect.try({
            try: () => {
              const actual = decode(Schema.Array(Frame), frames);
              assert(actual.length === candidate.required_frames.length);
              for (let i = 0; i < actual.length; i++) {
                const expected = candidate.required_frames[i],
                  observed = actual[i];
                assert(
                  expected !== undefined &&
                    observed !== undefined &&
                    expected.signature === observed.signature &&
                    expected.definer === observed.definer &&
                    expected.body_sha256 === observed.body_sha256,
                );
              }
              return actual;
            },
            catch: refuse,
          });
          const bodies = yield* rows(tx, "guest-readiness.native-bodies", bodiesSql, [
            schema,
            candidate.native_function_bodies.map((body) => body.name),
          ]);
          yield* Effect.try({
            try: () => {
              const actual = decode(Schema.Array(Body), bodies);
              assert(actual.length === candidate.native_function_bodies.length);
              for (let i = 0; i < actual.length; i++) {
                const expected = candidate.native_function_bodies[i],
                  observed = actual[i];
                assert(
                  expected !== undefined &&
                    observed !== undefined &&
                    expected.name === observed.name &&
                    expected.body_sha256 === observed.body_sha256 &&
                    expected.definer === observed.definer &&
                    expected.configuration === observed.configuration,
                );
              }
            },
            catch: refuse,
          });
          for (const { profile, identity } of principals) {
            const unsafe = yield* rows(tx, `guest-readiness.${profile}.roles`, rolesSql, [
              identity.role_oid,
              schema,
            ]);
            yield* Effect.try({
              try: () => one(Schema.Struct({ unsafe: Schema.Literal(false) }), unsafe),
              catch: refuse,
            });
            const catalogueBoundary = yield* rows(
              tx,
              `guest-readiness.${profile}.catalogue-boundary`,
              catalogueBoundarySql,
              [identity.role_oid, candidate.restricted_catalogue_probes],
            );
            yield* Effect.try({
              try: () => {
                const observed = one(CatalogueBoundary, catalogueBoundary);
                assert(
                  observed.violations.length === 0 &&
                    observed.probes.length === candidate.restricted_catalogue_probes.length,
                );
                for (let i = 0; i < observed.probes.length; i++) {
                  const probe = observed.probes[i];
                  assert(
                    probe !== undefined &&
                      probe.name === candidate.restricted_catalogue_probes[i] &&
                      probe.overloads > 0 &&
                      probe.restricted_overloads === probe.overloads,
                  );
                }
              },
              catch: refuse,
            });
            const acl = yield* rows(tx, `guest-readiness.${profile}.acl`, aclSql, [
              identity.role_oid,
            ]);
            yield* Effect.try({
              try: () => {
                const observed = one(Acl, acl),
                  expected = candidate.profiles[profile];
                assert(observed.tables.length === 0 && observed.sequences.length === 0);
                assert(
                  observed.catalog_functions.length === 1 &&
                    observed.catalog_functions[0]?.function_oid === identity.control_function_oid,
                );
                const profileColumns: Readonly<Record<string, readonly string[]>> =
                  expected.columns;
                const expectedColumns = Object.entries(profileColumns).flatMap(
                  ([table_name, columns]) =>
                    columns.map((column_name) => ({
                      schema_name: schema,
                      table_name,
                      column_name,
                      privilege: "SELECT",
                    })),
                );
                const expectedFunctions = expected.functions.map((signature) => {
                  const frame = nativeFrames.find((frame) => frame.signature === signature);
                  assert(frame !== undefined);
                  if (frame === undefined) throw refuse();
                  return { schema_name: schema, function_oid: frame.function_oid };
                });
                const canonical = (items: readonly (readonly string[])[]) =>
                  JSON.stringify(items.map((item) => JSON.stringify(item)).sort());
                const columnTuples = (
                  items: readonly {
                    schema_name: string;
                    table_name: string;
                    column_name: string;
                    privilege: string;
                  }[],
                ) =>
                  items.map((item) => [
                    item.schema_name,
                    item.table_name,
                    item.column_name,
                    item.privilege,
                  ]);
                const functionTuples = (
                  items: readonly { schema_name: string; function_oid: string }[],
                ) => items.map((item) => [item.schema_name, item.function_oid]);
                assert(
                  canonical(columnTuples(observed.columns)) ===
                    canonical(columnTuples(expectedColumns)),
                );
                assert(
                  canonical(functionTuples(observed.functions)) ===
                    canonical(functionTuples(expectedFunctions)),
                );
              },
              catch: refuse,
            });
          }
        }),
      );
    }).pipe(Effect.provide(bindings.observer));
    return Object.freeze({
      candidateHead: candidate.source_head,
      phase: candidate.native_phase,
      identities: Object.freeze(
        principals.map(({ profile, identity }) =>
          Object.freeze({ profile, roleOid: identity.role_oid }),
        ),
      ),
    });
  });
  return Object.freeze({
    /** No positive-result TTL or negative cache: each call reads actual cluster/database/login principals,
     * exact candidate ledger/phase/frames and finite current effective ACLs.
     * The serving composition must call once before every request body/auth hash
     * never cache through isolate lifetime. The entire inspection is bounded to8s;
     * each owning native-read transaction retains existing3s/250ms/2s bounds.
     */
    verify: () =>
      Effect.runPromise(
        verify().pipe(
          Effect.timeout("8 seconds"),
          Effect.catch(() => Effect.fail(refuse())),
        ),
      ),
  });
}
