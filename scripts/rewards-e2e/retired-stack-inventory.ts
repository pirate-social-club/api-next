import { createHash } from "node:crypto";
import { Client } from "pg";
import { normalizePostgresConnectionString } from "../postgres-connection-string.ts";
import { cloudflareApi } from "./cloudflare-api.mjs";
import { isolatedWorkers } from "./worker-plan.mjs";

export function verifyRetiredDatabase(connectionString: string) {
  const url = new URL(connectionString);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hostname !== "us-east-3.pg.psdb.cloud" ||
    createHash("sha256").update(decodeURIComponent(url.username)).digest("hex") !==
      "11fb2278eaef40f9c3c8cb1cd69637336bbd7af00e8751ba9d0192c690f8de44"
  )
    throw new Error("Retired isolated database identity mismatch");
}

/** A conservative inventory: even failed or ambiguous effects prevent a clean handback. */
export async function inventoryRetiredDatabase(connectionString: string) {
  verifyRetiredDatabase(connectionString);
  const client = new Client({
    connectionString: normalizePostgresConnectionString(connectionString),
    connectionTimeoutMillis: 20_000,
  });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL search_path TO api_next, public");
    const { rows } = await client.query<{ category: string; total: number; open: number }>(`
      SELECT 'credits' AS category, count(*)::int AS total,
        count(*) FILTER (WHERE state <> 'sent' OR reserved_atomic <> 0
          OR paid_atomic <> amount_atomic)::int AS open FROM reward_ledger_credits
      UNION ALL SELECT 'legs', count(*)::int,
        count(*) FILTER (WHERE status <> 'ended' OR reserved_atomic <> 0
          OR funded_atomic <> spent_atomic + fulfilled_atomic + refunded_atomic)::int
        FROM song_reward_offer_legs
      UNION ALL SELECT 'effects', count(*)::int,
        count(*) FILTER (WHERE state <> 'confirmed')::int FROM reward_chain_effects
      UNION ALL SELECT 'winner-sends', count(*)::int,
        count(*) FILTER (WHERE status <> 'confirmed')::int FROM reward_winner_sends
      UNION ALL SELECT 'drawings', count(*)::int,
        count(*) FILTER (WHERE status NOT IN ('credited', 'no_win', 'closed_no_entries',
          'closed_unfunded', 'closed_purchase_unavailable'))::int FROM megapot_pool_drawings
      UNION ALL SELECT 'tickets', count(*)::int,
        count(*) FILTER (WHERE status NOT IN ('no_win', 'claimed'))::int FROM megapot_ticket_inventory
    `);
    await client.query("COMMIT");
    return {
      observedAt: new Date().toISOString(),
      clean: rows.every((row) => row.open === 0),
      categories: rows,
    };
  } finally {
    await client.end();
  }
}

/** Inspect deployed versions; latest uploaded settings are not serving-state evidence. */
export async function inventoryServingWorkers() {
  const result = [];
  for (const name of Object.values(isolatedWorkers)) {
    const deployments = await cloudflareApi(`/workers/scripts/${name}/deployments`);
    const serving = deployments.deployments?.[0];
    if (!serving?.versions?.length) throw new Error("Isolated serving deployment unavailable");
    for (const version of serving.versions) {
      const detail = await cloudflareApi(`/workers/scripts/${name}/versions/${version.version_id}`);
      const binding = detail.resources?.bindings?.find(
        (item: { name: string }) => item.name === "MEGAPOT_REWARDS_ENABLED",
      );
      if (typeof binding?.text !== "string") throw new Error("Serving rewards flag unavailable");
      result.push({
        worker: name,
        versionId: version.version_id,
        percentage: version.percentage,
        rewardsEnabled: binding.text,
      });
    }
  }
  return result;
}
