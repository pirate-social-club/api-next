import { ControlPlaneDb } from "@pirate/application";
import { Effect } from "effect";

import { makeDirectPostgresControlPlaneLayer } from "../packages/platform-cf/src/postgres";
import { loadPostgresMigrations, normalizePostgresConnectionString } from "./postgres-migrations";

export type LedgerRow = Readonly<{ version: string; checksum: string }>;

const M3_TABLES = [
  "community_purchase_funding_journal",
  "community_purchase_funding_requests",
  "community_purchase_funding_plans",
  "community_purchase_funding_transaction_claims",
  "community_purchase_funding_transitions",
  "community_purchase_funding_receipts",
] as const;

const MUTABLE_TABLES = new Set<string>([
  "community_purchase_funding_journal",
  "community_purchase_funding_requests",
  "community_purchase_funding_plans",
]);

export function assertChecksummedLedgerPrefix(
  ledger: readonly LedgerRow[],
  plan: readonly LedgerRow[],
): void {
  if (ledger.length > plan.length) throw new Error("Live migration ledger is ahead of this source");
  for (const [index, row] of ledger.entries()) {
    const expected = plan[index];
    if (expected === undefined || row.version !== expected.version) {
      throw new Error(
        `Live migration ledger is not the repository prefix at position ${index + 1}`,
      );
    }
    if (row.checksum !== expected.checksum) {
      throw new Error(`Live migration checksum mismatch: ${row.version}`);
    }
  }
}

type PrivilegeRow = Readonly<{
  table_name: string;
  can_select: boolean;
  can_insert: boolean;
  can_update: boolean;
  can_delete: boolean;
  can_truncate: boolean;
}>;

function privilegeViolation(row: PrivilegeRow): string | null {
  if (!row.can_select || !row.can_insert) return `${row.table_name}: SELECT and INSERT required`;
  if (row.can_delete || row.can_truncate) return `${row.table_name}: DELETE/TRUNCATE forbidden`;
  if (MUTABLE_TABLES.has(row.table_name)) {
    return row.can_update ? null : `${row.table_name}: UPDATE required`;
  }
  return row.can_update ? `${row.table_name}: UPDATE forbidden` : null;
}

export async function runM3StagingPreflight(input: {
  readonly adminConnectionString: string;
  readonly runtimeConnectionString: string;
  readonly requireReady: boolean;
}) {
  const plan = (await loadPostgresMigrations()).map(({ version, checksum }) => ({
    version,
    checksum,
  }));
  const adminResult = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const ledgerResult = yield* db.execute<LedgerRow>({
          label: "m3.preflight.ledger",
          text: "SELECT version, checksum FROM schema_migrations ORDER BY version",
          values: [],
          readonly: true,
        });
        const countsResult = yield* db.execute<{ table_name: string; row_count: string }>({
          label: "m3.preflight.row-counts",
          text: `
            SELECT 'community_purchase_funding_journal' AS table_name,
                   count(*)::text AS row_count FROM community_purchase_funding_journal
            UNION ALL SELECT 'community_purchase_funding_requests', count(*)::text
              FROM community_purchase_funding_requests
            UNION ALL SELECT 'community_purchase_funding_plans', count(*)::text
              FROM community_purchase_funding_plans
            UNION ALL SELECT 'community_purchase_funding_transaction_claims', count(*)::text
              FROM community_purchase_funding_transaction_claims
            UNION ALL SELECT 'community_purchase_funding_transitions', count(*)::text
              FROM community_purchase_funding_transitions
            UNION ALL SELECT 'community_purchase_funding_receipts', count(*)::text
              FROM community_purchase_funding_receipts
            ORDER BY table_name
          `,
          values: [],
          readonly: true,
        });
        return { ledger: ledgerResult.rows, counts: countsResult.rows };
      }).pipe(
        Effect.provide(
          makeDirectPostgresControlPlaneLayer(
            normalizePostgresConnectionString(input.adminConnectionString),
          ),
        ),
      ),
    ),
  );
  const runtimeResult = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const identityResult = yield* db.execute<{ principal: string; schema_name: string }>({
          label: "m3.preflight.runtime-identity",
          text: "SELECT current_user AS principal, current_schema() AS schema_name",
          values: [],
          readonly: true,
        });
        const privilegesResult = yield* db.execute<PrivilegeRow>({
          label: "m3.preflight.runtime-privileges",
          text: `SELECT table_name,
                        has_table_privilege(current_user, format('%I.%I', current_schema(), table_name), 'SELECT') AS can_select,
                        has_table_privilege(current_user, format('%I.%I', current_schema(), table_name), 'INSERT') AS can_insert,
                        has_table_privilege(current_user, format('%I.%I', current_schema(), table_name), 'UPDATE') AS can_update,
                        has_table_privilege(current_user, format('%I.%I', current_schema(), table_name), 'DELETE') AS can_delete,
                        has_table_privilege(current_user, format('%I.%I', current_schema(), table_name), 'TRUNCATE') AS can_truncate
                   FROM unnest($1::text[]) AS tables(table_name)
                  ORDER BY table_name`,
          values: [[...M3_TABLES]],
          readonly: true,
        });
        return { identity: identityResult.rows, privileges: privilegesResult.rows };
      }).pipe(
        Effect.provide(
          makeDirectPostgresControlPlaneLayer(
            normalizePostgresConnectionString(input.runtimeConnectionString),
          ),
        ),
      ),
    ),
  );

  {
    const ledger = adminResult.ledger;
    assertChecksummedLedgerPrefix(ledger, plan);
    const violations = runtimeResult.privileges.flatMap((row) => {
      const violation = privilegeViolation(row);
      return violation === null ? [] : [violation];
    });
    const applied = new Set(ledger.map(({ version }) => version));
    const result = {
      ledger: {
        appliedCount: ledger.length,
        currentVersion: ledger.at(-1)?.version ?? null,
        has0013: applied.has("0013_m3_community_purchase_funding_journal.sql"),
        has0014: applied.has("0014_m3_community_purchase_funding_plans.sql"),
        has0018: applied.has("0018_m3_funding_dormancy_and_retention.sql"),
      },
      rowCounts: Object.fromEntries(
        adminResult.counts.map(({ table_name, row_count }) => [table_name, Number(row_count)]),
      ),
      runtime: {
        principal: runtimeResult.identity[0]?.principal ?? "unknown",
        schema: runtimeResult.identity[0]?.schema_name ?? "unknown",
        privileges: runtimeResult.privileges,
        ready: violations.length === 0,
        violations,
      },
    };
    if (input.requireReady && (!result.ledger.has0018 || !result.runtime.ready)) {
      throw new Error("M3 staging readiness requirements are not satisfied");
    }
    return result;
  }
}

async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  const unknown = args.filter((argument) => argument !== "--require-ready");
  if (unknown.length > 0) throw new Error(`Unknown preflight option: ${unknown[0]}`);
  const adminConnectionString = process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL?.trim();
  const runtimeConnectionString = process.env.CONTROL_PLANE_POSTGRES_RUNTIME_URL?.trim();
  if (!adminConnectionString || !runtimeConnectionString) {
    throw new Error("Both staging Postgres preflight credentials are required");
  }
  const result = await runM3StagingPreflight({
    adminConnectionString,
    runtimeConnectionString,
    requireReady: args.includes("--require-ready"),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "M3 staging preflight failed");
    process.exitCode = 1;
  });
}
