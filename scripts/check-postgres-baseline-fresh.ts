import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePostgresBaseline } from "./generate-postgres-baseline.ts";
import { assertPostgresFoundationTableCatalogFresh } from "./postgres-foundation-table-catalog.ts";

const temporaryDirectory = await mkdtemp(join(tmpdir(), "api-next-postgres-baseline-check-"));
const generatedPath = join(temporaryDirectory, "schema.sql");
const generatedResetPath = join(temporaryDirectory, "test-reset.sql");
try {
  await generatePostgresBaseline(generatedPath, generatedResetPath);
  const [actual, generated, actualReset, generatedReset, foundationTestSource] = await Promise.all([
    readFile(new URL("../db/postgres/schema.sql", import.meta.url), "utf8"),
    readFile(generatedPath, "utf8"),
    readFile(new URL("../db/postgres/test-reset.sql", import.meta.url), "utf8"),
    readFile(generatedResetPath, "utf8"),
    readFile(
      new URL("../packages/platform-cf/src/postgres-foundation.pg.test.ts", import.meta.url),
      "utf8",
    ),
  ]);
  if (actual !== generated || actualReset !== generatedReset) {
    console.error(
      "Postgres baseline or test reset is stale. Run bun run db:generate:baseline; the generator verifies migration history before writing.",
    );
    process.exitCode = 1;
  }
  assertPostgresFoundationTableCatalogFresh({
    baselineSource: generated,
    foundationTestSource,
  });
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}
