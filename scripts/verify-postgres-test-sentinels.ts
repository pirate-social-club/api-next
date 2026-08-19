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
  {
    name: "postgres community repository",
    path:
      process.env.CONTROL_PLANE_POSTGRES_COMMUNITY_TEST_SENTINEL ??
      "/tmp/api-next-control-plane-postgres-community-suite-complete",
    contents: "api-next-control-plane-postgres-community-suite-complete\n",
  },
  {
    name: "postgres feed repository",
    path:
      process.env.CONTROL_PLANE_POSTGRES_FEED_TEST_SENTINEL ??
      "/tmp/api-next-control-plane-postgres-feed-suite-complete",
    contents: "api-next-control-plane-postgres-feed-suite-complete\n",
  },
  {
    name: "postgres content repository",
    path:
      process.env.CONTROL_PLANE_POSTGRES_CONTENT_TEST_SENTINEL ??
      "/tmp/api-next-control-plane-postgres-content-suite-complete",
    contents: "api-next-control-plane-postgres-content-suite-complete\n",
  },
  {
    name: "postgres public profile",
    path:
      process.env.CONTROL_PLANE_POSTGRES_PUBLIC_PROFILE_TEST_SENTINEL ??
      "/tmp/api-next-control-plane-postgres-public-profile-suite-complete",
    contents: "api-next-control-plane-postgres-public-profile-suite-complete\n",
  },
  {
    name: "postgres public community threads",
    path:
      process.env.CONTROL_PLANE_POSTGRES_PUBLIC_COMMUNITY_THREADS_TEST_SENTINEL ??
      "/tmp/api-next-control-plane-postgres-public-community-threads-suite-complete",
    contents: "api-next-control-plane-postgres-public-community-threads-suite-complete\n",
  },
  {
    name: "postgres verification completion repository",
    path:
      process.env.CONTROL_PLANE_POSTGRES_VERIFICATION_TEST_SENTINEL ??
      "/tmp/api-next-control-plane-postgres-verification-suite-complete",
    contents: "api-next-control-plane-postgres-verification-suite-complete\n",
  },
  {
    name: "postgres verification start repository",
    path:
      process.env.CONTROL_PLANE_POSTGRES_VERIFICATION_START_TEST_SENTINEL ??
      "/tmp/api-next-control-plane-postgres-verification-start-suite-complete",
    contents: "api-next-control-plane-postgres-verification-start-suite-complete\n",
  },
  {
    name: "postgres community purchase funding journal",
    path:
      process.env.CONTROL_PLANE_POSTGRES_COMMUNITY_PURCHASE_FUNDING_TEST_SENTINEL ??
      "/tmp/api-next-control-plane-postgres-community-purchase-funding-suite-complete",
    contents: "api-next-control-plane-postgres-community-purchase-funding-suite-complete\n",
  },
  {
    name: "postgres community purchase commerce producer",
    path:
      process.env.CONTROL_PLANE_POSTGRES_COMMUNITY_PURCHASE_COMMERCE_TEST_SENTINEL ??
      "/tmp/api-next-control-plane-postgres-community-purchase-commerce-suite-complete",
    contents: "api-next-control-plane-postgres-community-purchase-commerce-suite-complete\n",
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
