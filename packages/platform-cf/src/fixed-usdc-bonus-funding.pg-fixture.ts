import { expect } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../../scripts/postgres-migrations.ts";
import {
  applyPostgresTestBaselineConnection,
  type createReusablePostgresTestSchemaOwner,
} from "../../../scripts/postgres-test-baseline.ts";
import {
  prepareFixedUsdcBonusCustody,
  prepareFixedUsdcBonusObservation,
} from "../../application/src/rewards/fixed-usdc-bonus-funding.ts";
import { fixedUsdcBonusFundingFixture } from "../../testing/src/fixed-usdc-bonus-funding-fixture.ts";
import { makeFixedUsdcBonusFundingStore } from "./fixed-usdc-bonus-funding-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import {
  community,
  seedPublishedSongFixture,
  seedSongOwner,
  seedVideoActors,
} from "./video-publication.pg-fixture.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const quote = (v: string) => `"${v.replaceAll('"', '""')}"`;
export type FixedUsdcBonusFundingFixture = Awaited<ReturnType<typeof seed>>;

export async function withFixedUsdcBonusFixture(
  schemaOwner: ReturnType<typeof createReusablePostgresTestSchemaOwner>,
  use: (f: Awaited<ReturnType<typeof seed>>) => Promise<void>,
  maximumAgeMs?: number,
) {
  if (!url) throw new Error("Isolated native target required");
  await schemaOwner.run({
    baseConnectionString: url,
    schemaName: "fixed_usdc_bonus_funding_v1",
    use: async ({ admin, schema }) => {
      const connection = new URL(url);
      connection.searchParams.set("options", `-c search_path=${schema}`);
      await applyPostgresTestBaselineConnection({ connectionString: connection.toString() });
      await admin.query(`SET search_path TO ${quote(schema)}`);
      await use(await seed(admin, connection.toString(), schema, maximumAgeMs));
    },
  });
}
async function seed(db: Client, connection: string, schema: string, maximumAgeMs?: number) {
  await seedVideoActors(db);
  await seedSongOwner(db);
  const fixture = fixedUsdcBonusFundingFixture(Date.now());
  await seedPublishedSongFixture(db, {
    songPostId: fixture.command.song_post_id,
    communityId: community,
    audioAssetRef: "media://song/fixed-bonus",
    canonicalAudioSha256: "e".repeat(64),
    durationSamples: 48000 * 60,
    title: "Bonus fixture song",
    contentRating: "general",
    derivativeVideo: "allowed",
    licensePreset: "commercial-use",
    commercialRemixShareBps: 0,
  });
  const policy = {
    ...fixture.policy,
    ...(maximumAgeMs === undefined ? {} : { maximum_observation_age_ms: maximumAgeMs }),
  };
  const observation = { ...fixture.observation, observed_at_ms: Date.now() };
  const command = { ...fixture.command, community_id: community };
  const layer = makeDirectPostgresControlPlaneLayer(connection),
    store = makeFixedUsdcBonusFundingStore(layer);
  const ready = async () => {
    const admitted = await Effect.runPromise(
      store.admitCustody(await Effect.runPromise(prepareFixedUsdcBonusCustody(policy))),
    );
    const observed = await Effect.runPromise(
      store.observe(await Effect.runPromise(prepareFixedUsdcBonusObservation(observation))),
    );
    expect(observed.solvent).toBe(true);
    return admitted;
  };
  return { db, connection, schema, layer, store, policy, observation, command, ready };
}
/** Baselines deliberately omit ACLs. Prove access on the real populated
 * predecessor upgrade, not on a generated schema with grants reconstructed. */
export async function withFixedUsdcBonusActualUpgrade(
  use: (f: Awaited<ReturnType<typeof seed>>) => Promise<void>,
) {
  if (!url) throw new Error("Isolated native target required");
  const schema = `fixed_bonus_upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
  const db = new Client({ connectionString: url });
  await db.connect();
  let created = false;
  try {
    await db.query(`CREATE SCHEMA ${quote(schema)}`);
    created = true;
    const connection = new URL(url);
    connection.searchParams.set("options", `-c search_path=${schema}`);
    await db.query(`SET search_path TO ${quote(schema)}`);
    const all = await loadPostgresMigrations(),
      index = all.findIndex((m) => m.version === "0308_fixed_usdc_bonus_funding.sql");
    expect(index).toBe(307);
    const prefix = all.slice(0, index);
    await runPostgresMigrations({
      connectionString: connection.toString(),
      migrations: prefix,
      expectedLedger: [],
    });
    const f = await seed(db, connection.toString(), schema);
    const snapshot = async () =>
      (
        await db.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY post_id) FROM posts p) posts,
      (SELECT jsonb_agg(to_jsonb(m) ORDER BY post_id) FROM media_publication_projections m) projections`)
      ).rows;
    const before = await snapshot();
    const upgraded = await runPostgresMigrations({
      connectionString: connection.toString(),
      migrations: all.slice(0, index + 1),
      expectedLedger: prefix,
    });
    if (upgraded.dryRun) throw new Error("Real upgrade required");
    expect(upgraded.result.applied).toEqual(["0308_fixed_usdc_bonus_funding.sql"]);
    expect(await snapshot()).toEqual(before);
    // Prefix replay may be slow; the actual new operator observations are fresh.
    f.observation.observed_at_ms = Date.now();
    await use(f);
  } finally {
    if (created) await db.query(`DROP SCHEMA ${quote(schema)} CASCADE`);
    await db.end();
  }
}

export async function waitForFixedUsdcBonusBlock(admin: Client, pid: number) {
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    const row = (
      await admin.query("SELECT pg_backend_pid()=ANY(pg_blocking_pids($1)) AS blocked", [pid])
    ).rows[0];
    if (row?.blocked) return;
    await Bun.sleep(5);
  }
  throw new Error("Owned bonus query did not reach the expected blocking lock");
}
