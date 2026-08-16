import { readFile } from "node:fs/promises";

export type PostgresSentinel = {
  readonly name: string;
  readonly path: string;
  readonly contents: string;
};

export const POSTGRES_TEST_SENTINELS: readonly PostgresSentinel[] = [
  {
    name: "postgres adapter",
    path:
      process.env.CONTROL_PLANE_POSTGRES_TEST_SENTINEL ??
      "/tmp/api-next-control-plane-postgres-adapter-suite-complete",
    contents: "api-next-control-plane-postgres-adapter-suite-complete\n",
  },
  {
    name: "postgres foundation",
    path:
      process.env.CONTROL_PLANE_POSTGRES_FOUNDATION_TEST_SENTINEL ??
      "/tmp/api-next-control-plane-postgres-foundation-suite-complete",
    contents: "api-next-control-plane-postgres-foundation-suite-complete\n",
  },
  {
    name: "postgres migration runner",
    path:
      process.env.CONTROL_PLANE_POSTGRES_MIGRATION_TEST_SENTINEL ??
      "/tmp/api-next-control-plane-postgres-migration-suite-complete",
    contents: "api-next-control-plane-postgres-migration-suite-complete\n",
  },
  {
    name: "postgres identity repository",
    path:
      process.env.CONTROL_PLANE_POSTGRES_IDENTITY_TEST_SENTINEL ??
      "/tmp/api-next-control-plane-postgres-identity-suite-complete",
    contents: "api-next-control-plane-postgres-identity-suite-complete\n",
  },
];

export async function verifyPostgresTestSentinels(
  sentinels: readonly PostgresSentinel[] = POSTGRES_TEST_SENTINELS,
): Promise<void> {
  const failures: string[] = [];
  for (const sentinel of sentinels) {
    try {
      const actual = await readFile(sentinel.path, "utf8");
      if (actual !== sentinel.contents)
        failures.push(`${sentinel.name}: incorrect marker contents`);
    } catch {
      failures.push(`${sentinel.name}: completion marker missing`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Postgres suite verification failed:\n${failures.join("\n")}`);
  }
}

if (import.meta.main) {
  await verifyPostgresTestSentinels();
  console.log(`Verified ${POSTGRES_TEST_SENTINELS.length} Postgres suite completion markers.`);
}
