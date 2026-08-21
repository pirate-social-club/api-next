import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePostgresBaseline } from "./generate-postgres-baseline.ts";

const temporaryDirectory = await mkdtemp(join(tmpdir(), "api-next-postgres-baseline-check-"));
const generatedPath = join(temporaryDirectory, "schema.sql");
try {
  await generatePostgresBaseline(generatedPath);
  const [actual, generated] = await Promise.all([
    readFile(new URL("../db/postgres/schema.sql", import.meta.url), "utf8"),
    readFile(generatedPath, "utf8"),
  ]);
  if (actual !== generated) {
    console.error(
      "Postgres baseline is stale. Run bun run db:generate:baseline and review the migration-history gate.",
    );
    process.exitCode = 1;
  }
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}
