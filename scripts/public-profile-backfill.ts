import { readFile } from "node:fs/promises";

export * from "./public-profile-backfill-manifest";
export * from "./public-profile-backfill-planner";
export * from "./public-profile-backfill-target";
export * from "./public-profile-backfill-transaction";
export * from "./public-profile-backfill-types";

import { runPublicProfileBackfill } from "./public-profile-backfill-transaction";
import type { PublicProfileBackfillReport } from "./public-profile-backfill-types";

export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export function formatPublicProfileBackfillReport(report: PublicProfileBackfillReport): string {
  return JSON.stringify(report, null, 2);
}

export async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  if (
    args.length !== 3 ||
    args[0] !== "--dry-run" ||
    args[1] !== "--manifest" ||
    args[2] === undefined
  ) {
    throw new Error("Usage: bun scripts/public-profile-backfill.ts --dry-run --manifest PATH");
  }
  const manifest = await readJsonFile(args[2]);
  const targetPath = process.env.PUBLIC_PROFILE_BACKFILL_TARGET_SNAPSHOT;
  if (targetPath === undefined || targetPath.trim() === "") {
    throw new Error(
      "PUBLIC_PROFILE_BACKFILL_TARGET_SNAPSHOT is required for dry-run; capture a reviewed api-next target snapshot first",
    );
  }
  const target = await readJsonFile(targetPath);
  const result = await runPublicProfileBackfill({ mode: "dry-run", manifest, target });
  console.log(formatPublicProfileBackfillReport(result.report));
  if (result.report.counts.errors > 0)
    throw new Error(`Dry-run rejected: ${result.report.counts.errors} validation error(s)`);
  console.log("Dry run: no database connection opened and no writes performed.");
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Public-profile backfill failed");
    process.exitCode = 1;
  });
}
