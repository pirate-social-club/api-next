import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneStatement,
  type ControlPlaneTransaction,
} from "@pirate/application";
import { Data, Effect } from "effect";

export type PostgresMigration = {
  readonly version: string;
  readonly checksum: string;
  readonly sql: string;
};

/** Migration filenames use a fixed-width numeric prefix so lexical order is numeric order. */
export const POSTGRES_MIGRATION_VERSION_PATTERN = /^\d{4}(?:_[^/]+)?\.sql$/;

export class MigrationDefinitionInvalid extends Data.TaggedError("MigrationDefinitionInvalid")<{
  readonly reason: "empty" | "format" | "duplicate" | "out-of-order";
  readonly version: string;
}> {}

export class MigrationLedgerMismatch extends Data.TaggedError("MigrationLedgerMismatch")<{
  readonly reason: "unknown-version" | "checksum" | "not-prefix";
  readonly version: string;
  readonly expectedVersion: string | null;
  readonly actualVersion: string | null;
  readonly expectedChecksum: string | null;
  readonly actualChecksum: string | null;
}> {}

export type MigrationApplyResult = {
  readonly applied: readonly string[];
  readonly currentVersion: string | null;
};

type AppliedMigration = {
  readonly version: string;
  readonly checksum: string;
};

const CREATE_LEDGER: ControlPlaneStatement = {
  label: "postgres.migrations.ensure-ledger",
  text: "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  values: [],
  readonly: false,
};

function validateDefinitions(
  migrations: readonly PostgresMigration[],
): Effect.Effect<void, MigrationDefinitionInvalid> {
  const seen = new Set<string>();
  let previousNumber: number | undefined;
  for (const migration of migrations) {
    if (migration.version.length === 0 || migration.sql.trim().length === 0) {
      return Effect.fail(
        new MigrationDefinitionInvalid({ reason: "empty", version: migration.version }),
      );
    }
    if (!POSTGRES_MIGRATION_VERSION_PATTERN.test(migration.version)) {
      return Effect.fail(
        new MigrationDefinitionInvalid({ reason: "format", version: migration.version }),
      );
    }
    if (seen.has(migration.version)) {
      return Effect.fail(
        new MigrationDefinitionInvalid({ reason: "duplicate", version: migration.version }),
      );
    }
    const currentNumber = Number(migration.version.slice(0, 4));
    if (previousNumber !== undefined && currentNumber <= previousNumber) {
      return Effect.fail(
        new MigrationDefinitionInvalid({ reason: "out-of-order", version: migration.version }),
      );
    }
    seen.add(migration.version);
    previousNumber = currentNumber;
  }
  return Effect.void;
}

function applyMigration(
  transaction: ControlPlaneTransaction,
  migration: PostgresMigration,
): Effect.Effect<void, ControlPlaneError> {
  return Effect.gen(function* () {
    yield* transaction.execute({
      label: `postgres.migrations.${migration.version}.apply`,
      text: migration.sql,
      values: [],
      readonly: false,
    });
    yield* transaction.execute({
      label: `postgres.migrations.${migration.version}.record`,
      text: "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
      values: [migration.version, migration.checksum],
      readonly: false,
    });
  });
}

function validateLedgerPrefix(
  applied: readonly AppliedMigration[],
  migrations: readonly PostgresMigration[],
): Effect.Effect<void, MigrationLedgerMismatch> {
  for (const [index, actual] of applied.entries()) {
    const expected = migrations[index];
    if (expected?.version === actual.version) continue;
    return Effect.fail(
      new MigrationLedgerMismatch({
        reason: "not-prefix",
        version: expected?.version ?? actual.version,
        expectedVersion: expected?.version ?? null,
        actualVersion: actual.version,
        expectedChecksum: expected?.checksum ?? null,
        actualChecksum: actual.checksum,
      }),
    );
  }
  return Effect.void;
}

/**
 * Applies repository migrations in order. Existing versions are immutable:
 * changing a checksum or removing an applied version fails before any new
 * migration is committed.
 */
export const applyPostgresMigrations = Effect.fn("applyPostgresMigrations")(function* (
  migrations: readonly PostgresMigration[],
): Effect.fn.Return<
  MigrationApplyResult,
  MigrationDefinitionInvalid | MigrationLedgerMismatch | ControlPlaneError,
  ControlPlaneDb
> {
  yield* validateDefinitions(migrations);
  const db = yield* ControlPlaneDb;

  return yield* db.withTransaction((transaction) =>
    Effect.gen(function* () {
      yield* transaction.execute(CREATE_LEDGER);
      const result = yield* transaction.execute<AppliedMigration>({
        label: "postgres.migrations.read-ledger",
        text: "SELECT version, checksum FROM schema_migrations ORDER BY version",
        values: [],
        readonly: true,
      });
      const applied = new Map(result.rows.map((row) => [row.version, row.checksum]));
      const defined = new Set(migrations.map((migration) => migration.version));

      for (const [version, checksum] of applied) {
        if (!defined.has(version)) {
          return yield* new MigrationLedgerMismatch({
            reason: "unknown-version",
            version,
            expectedVersion: null,
            actualVersion: version,
            expectedChecksum: null,
            actualChecksum: checksum,
          });
        }
      }

      yield* validateLedgerPrefix(
        [...applied].map(([version, checksum]) => ({ version, checksum })),
        migrations,
      );

      for (const [version, checksum] of applied) {
        const expected = migrations.find((migration) => migration.version === version);
        if (expected?.checksum !== checksum) {
          return yield* new MigrationLedgerMismatch({
            reason: "checksum",
            version,
            expectedChecksum: expected?.checksum ?? null,
            actualChecksum: checksum,
            expectedVersion: version,
            actualVersion: version,
          });
        }
      }

      const newlyApplied: string[] = [];
      for (const migration of migrations) {
        if (applied.has(migration.version)) continue;
        yield* applyMigration(transaction, migration);
        newlyApplied.push(migration.version);
      }

      return {
        applied: newlyApplied,
        currentVersion: migrations.at(-1)?.version ?? null,
      };
    }),
  );
});
