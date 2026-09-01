import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  type PostgresSentinel,
  verifyPostgresTestSentinels,
} from "./verify-postgres-test-sentinels";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function sentinelSet(): Promise<{
  readonly directory: string;
  readonly sentinels: PostgresSentinel[];
}> {
  const directory = await mkdtemp(join("/tmp", "api-next-postgres-sentinels-"));
  temporaryDirectories.push(directory);
  const sentinels = [
    "adapter",
    "foundation",
    "media-persistence",
    "media-migrations",
    "optional-route-v2",
    "migration",
    "identity",
    "community",
    "community-creation",
    "canonical-community-route",
    "canonical-route-migration",
    "gates-v2-community",
    "feed",
    "content",
    "text-submission",
    "persona",
    "rewards-qualification",
    "rewards-song-offers",
    "public-profile",
    "public-community-threads",
    "verification",
    "verification-start",
    "community-purchase-funding",
    "hns-observer",
    "hns-host-persistence",
    "handle-sales",
    "community-moderation",
    "dance-reference",
    "public-post-slug",
  ].map((name) => ({
    name,
    path: join(directory, `${name}.complete`),
    contents: `${name}-complete\n`,
  }));
  for (const sentinel of sentinels) await Bun.write(sentinel.path, sentinel.contents);
  return { directory, sentinels };
}

describe("Postgres suite sentinel verification", () => {
  test("accepts only when every distinct suite marker is complete", async () => {
    const { sentinels } = await sentinelSet();
    await verifyPostgresTestSentinels(sentinels);
  });

  test("fails when only postgres.pg.test.ts ran", async () => {
    const { sentinels } = await sentinelSet();
    await rm(sentinels[1]?.path ?? "", { force: true });
    await expect(verifyPostgresTestSentinels(sentinels)).rejects.toThrow("foundation");
  });

  test("fails when the foundation suite is skipped or omitted", async () => {
    const { sentinels } = await sentinelSet();
    await rm(sentinels[1]?.path ?? "", { force: true });
    await expect(verifyPostgresTestSentinels(sentinels)).rejects.toThrow(
      "completion marker missing",
    );
  });

  test("fails when the verification-start suite is skipped or omitted", async () => {
    const { sentinels } = await sentinelSet();
    const sentinel = sentinels.find(({ name }) => name === "verification-start");
    await rm(sentinel?.path ?? "", { force: true });
    await expect(verifyPostgresTestSentinels(sentinels)).rejects.toThrow("verification-start");
  });

  test("fails when the media persistence suite is skipped or omitted", async () => {
    const { sentinels } = await sentinelSet();
    const sentinel = sentinels.find(({ name }) => name === "media-persistence");
    await rm(sentinel?.path ?? "", { force: true });
    await expect(verifyPostgresTestSentinels(sentinels)).rejects.toThrow("media-persistence");
  });

  test("fails when the optional-route-v2 suite is skipped or omitted", async () => {
    const { sentinels } = await sentinelSet();
    const sentinel = sentinels.find(({ name }) => name === "optional-route-v2");
    await rm(sentinel?.path ?? "", { force: true });
    await expect(verifyPostgresTestSentinels(sentinels)).rejects.toThrow("optional-route-v2");
  });

  test("fails when persona persistence is skipped or omitted", async () => {
    const { sentinels } = await sentinelSet();
    const sentinel = sentinels.find(({ name }) => name === "persona");
    await rm(sentinel?.path ?? "", { force: true });
    await expect(verifyPostgresTestSentinels(sentinels)).rejects.toThrow("persona");
  });

  test("runs the complete tracked PostgreSQL inventory through the dedicated runner", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain("bun run test:postgres");
    expect(workflow).toContain("CONTROL_PLANE_POSTGRES_TEST_PARTITION: general-shard");
    expect(workflow).toContain("merge-multiple: true");
  });

  test("keeps persona and text-submission persistence fail-closed in Postgres CI", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );

    for (const marker of ["persona", "text-submission"]) {
      expect(
        workflow.match(
          new RegExp(`/tmp/api-next-control-plane-postgres-${marker}-suite-complete`, "gu"),
        ),
      ).toHaveLength(2);
    }
  });

  test("keeps rewards qualification persistence fail-closed in Postgres CI", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );

    expect(
      workflow.match(
        /\/tmp\/api-next-control-plane-postgres-rewards-qualification-suite-complete/gu,
      ),
    ).toHaveLength(2);
  });

  test("keeps Megapot rewards persistence fail-closed in Postgres CI", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain(
      "CONTROL_PLANE_POSTGRES_REWARDS_SONG_OFFERS_TEST_SENTINEL: " +
        "/tmp/api-next-control-plane-postgres-rewards-song-offers-suite-complete",
    );
    expect(
      workflow.match(/\/tmp\/api-next-control-plane-postgres-rewards-song-offers-suite-complete/gu),
    ).toHaveLength(2);
  });

  test("keeps Dance reference persistence fail-closed in Postgres CI", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain(
      "CONTROL_PLANE_POSTGRES_DANCE_REFERENCE_TEST_SENTINEL: " +
        "/tmp/api-next-control-plane-postgres-dance-reference-suite-complete",
    );
    expect(
      workflow.match(/\/tmp\/api-next-control-plane-postgres-dance-reference-suite-complete/gu),
    ).toHaveLength(2);
  });

  test("keeps public post slug persistence fail-closed in Postgres CI", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain(
      "CONTROL_PLANE_POSTGRES_PUBLIC_POST_SLUG_TEST_SENTINEL: " +
        "/tmp/api-next-control-plane-postgres-public-post-slug-suite-complete",
    );
    expect(
      workflow.match(/\/tmp\/api-next-control-plane-postgres-public-post-slug-suite-complete/gu),
    ).toHaveLength(2);
  });

  test("keeps the gates-v2 suite and completion marker wired into Postgres CI", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain(
      "CONTROL_PLANE_POSTGRES_GATES_V2_COMMUNITY_TEST_SENTINEL: " +
        "/tmp/api-next-control-plane-postgres-gates-v2-community-suite-complete",
    );
    expect(
      workflow.match(/\/tmp\/api-next-control-plane-postgres-gates-v2-community-suite-complete/gu),
    ).toHaveLength(2);
  });

  test("keeps creation and canonical-route suites fail-closed in Postgres CI", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );

    for (const marker of ["community-creation", "canonical-route"]) {
      expect(
        workflow.match(
          new RegExp(`/tmp/api-next-control-plane-postgres-${marker}-suite-complete`, "gu"),
        ),
      ).toHaveLength(2);
    }
  });

  test("keeps canonical-route migration coverage fail-closed in Postgres CI", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain(
      "CONTROL_PLANE_POSTGRES_CANONICAL_ROUTE_MIGRATION_TEST_SENTINEL: " +
        "/tmp/api-next-control-plane-postgres-canonical-route-migration-suite-complete",
    );
    expect(
      workflow.match(
        /\/tmp\/api-next-control-plane-postgres-canonical-route-migration-suite-complete/gu,
      ),
    ).toHaveLength(2);
  });

  test("keeps HNS observer persistence fail-closed in Postgres CI", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );

    expect(
      workflow.match(/\/tmp\/api-next-control-plane-postgres-hns-observer-suite-complete/gu),
    ).toHaveLength(2);
  });

  test("keeps HNS host persistence fail-closed in Postgres CI", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );

    expect(
      workflow.match(
        /\/tmp\/api-next-control-plane-postgres-hns-host-persistence-suite-complete/gu,
      ),
    ).toHaveLength(2);
  });

  test("keeps community handle sales fail-closed in Postgres CI", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain(
      "CONTROL_PLANE_POSTGRES_HANDLE_SALES_TEST_SENTINEL: " +
        "/tmp/api-next-control-plane-postgres-handle-sales-suite-complete",
    );
    expect(
      workflow.match(/\/tmp\/api-next-control-plane-postgres-handle-sales-suite-complete/gu),
    ).toHaveLength(2);
  });

  test("keeps community moderation foundation fail-closed in Postgres CI", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain(
      "CONTROL_PLANE_POSTGRES_COMMUNITY_MODERATION_TEST_SENTINEL: " +
        "/tmp/api-next-control-plane-postgres-community-moderation-suite-complete",
    );
    expect(
      workflow.match(
        /\/tmp\/api-next-control-plane-postgres-community-moderation-suite-complete/gu,
      ),
    ).toHaveLength(2);
  });

  test("keeps platform Pirate cleanup rename fail-closed in Postgres CI", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain(
      "CONTROL_PLANE_POSTGRES_PLATFORM_PIRATE_RENAME_TEST_SENTINEL: " +
        "/tmp/api-next-control-plane-postgres-platform-pirate-rename-suite-complete",
    );
    expect(
      workflow.match(
        /\/tmp\/api-next-control-plane-postgres-platform-pirate-rename-suite-complete/gu,
      ),
    ).toHaveLength(2);
  });

  test("keeps media persistence fail-closed in Postgres CI", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain(
      "CONTROL_PLANE_POSTGRES_MEDIA_PERSISTENCE_TEST_SENTINEL: " +
        "/tmp/api-next-control-plane-postgres-media-persistence-suite-complete",
    );
    expect(
      workflow.match(/\/tmp\/api-next-control-plane-postgres-media-persistence-suite-complete/gu),
    ).toHaveLength(2);
  });

  test("keeps media migration coverage fail-closed in Postgres CI", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain(
      "CONTROL_PLANE_POSTGRES_MEDIA_MIGRATIONS_TEST_SENTINEL: " +
        "/tmp/api-next-control-plane-postgres-media-migrations-suite-complete",
    );
    expect(
      workflow.match(/\/tmp\/api-next-control-plane-postgres-media-migrations-suite-complete/gu),
    ).toHaveLength(2);
  });

  test("keeps optional-route-v2 cardinality and race coverage fail-closed in Postgres CI", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain(
      "CONTROL_PLANE_POSTGRES_OPTIONAL_ROUTE_V2_TEST_SENTINEL: " +
        "/tmp/api-next-control-plane-postgres-optional-route-v2-suite-complete",
    );
    expect(
      workflow.match(/\/tmp\/api-next-control-plane-postgres-optional-route-v2-suite-complete/gu),
    ).toHaveLength(2);
  });
});
