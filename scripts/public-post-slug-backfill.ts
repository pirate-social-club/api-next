export * from "./public-post-slug-backfill-authorization.ts";
export * from "./public-post-slug-backfill-planner.ts";
export * from "./public-post-slug-backfill-transaction.ts";
export * from "./public-post-slug-backfill-types.ts";

import { createPostSlugBackfillPgAdapter } from "./public-post-slug-backfill-pg.ts";
import { encodePostSlugBackfillCursor } from "./public-post-slug-backfill-planner.ts";
import { runPostSlugBackfillDryRunPage } from "./public-post-slug-backfill-transaction.ts";
import {
  POST_SLUG_BACKFILL_PAGE_SIZE_MAX,
  POST_SLUG_BACKFILL_PAGE_SIZE_MIN,
} from "./public-post-slug-backfill-types.ts";

type DryRunOptions = Readonly<{
  readonly cursor: string | null;
  readonly upperBound?: string;
  readonly pageSize: number;
}>;

const parsePositiveInteger = (value: string | undefined, option: string): number => {
  if (value === undefined || !/^\d+$/u.test(value))
    throw new Error(`${option} requires an integer`);
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < POST_SLUG_BACKFILL_PAGE_SIZE_MIN ||
    parsed > POST_SLUG_BACKFILL_PAGE_SIZE_MAX
  ) {
    throw new Error(`${option} must be between 1 and 1000`);
  }
  return parsed;
};

const optionValue = (args: readonly string[], index: number, option: string): string => {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
};

export function parsePostSlugBackfillDryRunArgs(args: readonly string[]): DryRunOptions {
  if (args[0] !== "--dry-run") {
    throw new Error(
      "Usage: bun scripts/public-post-slug-backfill.ts --dry-run [--cursor CURSOR] [--upper-bound CURSOR] [--page-size 1..1000]",
    );
  }
  let cursor: string | null = null;
  let upperBound: string | undefined;
  let pageSize = 100;
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined || seen.has(argument)) {
      throw new Error(`Duplicate or missing option: ${argument ?? ""}`);
    }
    seen.add(argument);
    if (argument === "--cursor") {
      cursor = optionValue(args, index, argument);
      index += 1;
    } else if (argument === "--upper-bound") {
      upperBound = optionValue(args, index, argument);
      index += 1;
    } else if (argument === "--page-size") {
      pageSize = parsePositiveInteger(optionValue(args, index, argument), argument);
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument ?? ""}`);
    }
  }
  return { cursor, ...(upperBound === undefined ? {} : { upperBound }), pageSize };
}

export async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  const options = parsePostSlugBackfillDryRunArgs(args);
  const connectionString = process.env.CONTROL_PLANE_POST_SLUG_BACKFILL_URL;
  if (connectionString === undefined || connectionString.trim() === "") {
    throw new Error("CONTROL_PLANE_POST_SLUG_BACKFILL_URL is required for the read-only dry run");
  }
  const adapter = await createPostSlugBackfillPgAdapter(connectionString, "dry-run");
  await adapter.client.connect();
  try {
    const result = await runPostSlugBackfillDryRunPage({
      database: adapter.database,
      cursor: options.cursor,
      ...(options.upperBound === undefined ? {} : { upperBound: options.upperBound }),
      pageSize: options.pageSize,
    });
    const nextCursor =
      result.plan.next_cursor === null
        ? null
        : encodePostSlugBackfillCursor(result.plan.next_cursor);
    console.log(
      JSON.stringify(
        {
          mode: result.mode,
          upper_bound: encodePostSlugBackfillCursor(result.plan.upper_bound),
          next_cursor: nextCursor,
          has_more: result.plan.has_more,
          report: result.plan.report,
          decisions: result.plan.decisions,
        },
        null,
        2,
      ),
    );
    console.log("Dry run: the database transaction was read-only and no aliases were written.");
    if (result.plan.report.blocked_count > 0) {
      throw new Error(
        `Dry-run rejected: ${result.plan.report.blocked_count} blocking row(s) require correction`,
      );
    }
  } finally {
    await adapter.client.end();
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Public Post slug backfill failed");
    process.exitCode = 1;
  });
}
