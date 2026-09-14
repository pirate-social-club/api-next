import type { ControlPlaneStatementFailed } from "@pirate/application";
import type { PostgresClientFactory } from "../packages/platform-cf/src/postgres.ts";
import type { PostgresMigration } from "../packages/platform-cf/src/postgres-migrations.ts";

/** Administrative DDL tooling only. Runtime database errors remain source-closed. */
export function makeMigrationDiagnosticClient(migrations: readonly PostgresMigration[]) {
  const versions = new Map(migrations.map((migration) => [migration.sql, migration.version]));
  let failure: Readonly<{ version: string; message: string }> | undefined;
  const clientFactory: PostgresClientFactory = async (_connectionString, config) => {
    const { Client } = await import("pg");
    const client = new Client(config);
    return {
      connection: client.connection,
      connect: () => client.connect(),
      end: () => client.end(),
      query: async ({ text, values }) => {
        try {
          return await client.query({ text, values: values === undefined ? [] : [...values] });
        } catch (error: unknown) {
          const version = versions.get(text);
          // Never retain SQL, parameters, connection credentials, driver detail or stack.
          if (version !== undefined && error instanceof Error && error.message.trim()) {
            failure = { version, message: error.message.replace(/[\r\n\t]/g, " ").slice(0, 512) };
          }
          throw error;
        }
      },
    };
  };
  return {
    clientFactory,
    describe(error: ControlPlaneStatementFailed): string {
      const detail =
        failure !== undefined && error.label === `postgres.migrations.${failure.version}.apply`
          ? `: ${failure.message}`
          : "";
      return `Postgres migration statement ${error.label} failed (SQLSTATE ${error.sqlState ?? "unknown"})${detail}`;
    },
  };
}
