import { resolve } from "node:path";
import * as BunRuntime from "bun";
import pg from "pg";
import type { DanceServingConsumer } from "./dance-serving-permission-contract.ts";
import { runDanceServingPermissionsPreflight } from "./dance-serving-permissions-preflight.ts";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";
import type { SongFundingPurpose } from "./song-funding-permission-contract.ts";
import { runSongFundingPermissionsPreflight } from "./song-funding-permissions-preflight.ts";
import {
  bindings,
  type CandidateBindings,
  digest,
  object,
  parseServingDeployments,
  string,
} from "./worker-binding-drift.ts";
import { readCandidateBindings } from "./worker-deployment-bindings.ts";

// Reuse the maintained provider/managed-login adapter without importing its
// broad JavaScript surface into the Worker or changing its existing consumers.
const providerModule = new URL("./rewards-e2e/cloudflare-api.mjs", import.meta.url).href;
const provider = async () =>
  (await import(providerModule)) as {
    cloudflareAccountId: string;
    cloudflareApi: (path: string) => Promise<unknown>;
  };

const purposes: Readonly<Record<string, SongFundingPurpose>> = {
  "apps/http-worker/wrangler.jsonc": "http",
  "apps/jobs-worker/wrangler.jsonc": "jobs",
};
type Origin = Readonly<{ host: string; database: string; user: string; port: number }>;
const originFields = (input: unknown): Origin => {
  const row = object(input, "Hyperdrive origin");
  if (row.scheme !== "postgres" && row.scheme !== "postgresql")
    throw Error("Funding requires PostgreSQL");
  if (!Number.isSafeInteger(row.port) || Number(row.port) < 1) throw Error("Invalid database port");
  return {
    host: string(row.host, "database host"),
    database: string(row.database, "database"),
    user: string(row.user, "database user"),
    port: Number(row.port),
  };
};

async function databaseIdentity(url: string) {
  const db = new pg.Client({
    connectionString: normalizePostgresConnectionString(url),
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  try {
    await db.connect();
    const result = await db.query(
      "SELECT current_user::text role,session_user::text session,current_database()::text database",
    );
    return object(result.rows[0], "database identity");
  } finally {
    await db.end().catch(() => undefined);
  }
}

export function assertFundingOrigin(
  url: string,
  origin: Origin,
  identity: Record<string, unknown>,
) {
  const parsed = new URL(url);
  if (
    parsed.hostname !== origin.host ||
    Number(parsed.port || 5432) !== origin.port ||
    decodeURIComponent(parsed.pathname.slice(1)) !== origin.database ||
    decodeURIComponent(parsed.username) !== origin.user ||
    identity.role !== origin.user ||
    identity.session !== origin.user ||
    identity.database !== origin.database
  )
    throw Error("Database permission evidence does not match the actual Hyperdrive origin");
}

/** No receipts supplied by an operator are trusted as identity evidence: read
 * candidate, all traffic-bearing versions and each live origin directly. */
export async function prepareSongFundingBindingAdmission(
  root: string,
  configPath: string,
  environment: string,
  sourceSha: string,
  dependencies = {
    candidate: readCandidateBindings,
    account: async (root: string, configPath: string, environment: string) => {
      const { unstable_readConfig } = await import("wrangler");
      return unstable_readConfig(
        { config: resolve(root, configPath), env: environment },
        { hideWarnings: true },
      ).account_id;
    },
    api: async (path: string) => (await provider()).cloudflareApi(path),
    identity: databaseIdentity,
    fundingPermissions: runSongFundingPermissionsPreflight,
    dancePermissions: runDanceServingPermissionsPreflight,
    environment: process.env,
  },
) {
  if (
    !(await BunRuntime.file(
      resolve(root, "packages/platform-cf/src/song-funding-connection.ts"),
    ).exists())
  )
    return null;
  const purpose = purposes[configPath];
  if (!purpose) return null;
  const name = purpose === "http" ? "SONG_FUNDING_COMMANDS" : "SONG_FUNDING_JOBS";
  const candidate = await dependencies.candidate(root, configPath, environment);
  const candidateDigest = digest(candidate);
  const enabled = (set: CandidateBindings["bindings"]) => {
    const flag = (key: string) => set.find((b) => b.name === key)?.text ?? "false";
    const eoa = flag("MEGAPOT_REWARDS_ENABLED"),
      safe = flag("SAFE_POOL_PILOT_ENABLED");
    if (
      ![eoa, safe].every((v) => v === "true" || v === "false") ||
      (eoa === "true" && safe === "true")
    )
      throw Error("Invalid funding lane configuration");
    return eoa === "true" || safe === "true";
  };
  if (!enabled(candidate.bindings) && !candidate.bindings.some((b) => b.name === name)) return null;
  const cloudflareAccountId = (await provider()).cloudflareAccountId;
  const account = await dependencies.account(root, configPath, environment);
  if (
    account !== cloudflareAccountId ||
    (dependencies.environment.CLOUDFLARE_ACCOUNT_ID !== undefined &&
      dependencies.environment.CLOUDFLARE_ACCOUNT_ID !== account)
  )
    throw Error("Funding binding admission requires the target account");
  const base = "";
  const worker = `${base}/workers/scripts/${encodeURIComponent(candidate.worker_name)}`;
  const collect = async () => {
    const current = await dependencies.candidate(root, configPath, environment);
    if ((await dependencies.account(root, configPath, environment)) !== account)
      throw Error("Funding target account changed");
    if (digest(current) !== candidateDigest)
      throw Error("Funding candidate changed during admission");
    const deployment = () =>
      dependencies
        .api(`${worker}/deployments`)
        .then((r) => parseServingDeployments(JSON.stringify(object(r, "deployments").deployments)));
    const before = await deployment();
    const inventories = [
      { version_id: `candidate:${sourceSha}`, percentage: 0, bindings: current.bindings },
    ];
    for (const allocation of before) {
      const version = object(
        await dependencies.api(`${worker}/versions/${allocation.version_id}`),
        "Worker version",
      );
      if (version.id !== allocation.version_id) throw Error("Funding version identity differs");
      inventories.push({
        ...allocation,
        bindings: bindings(object(version.resources, "version resources").bindings),
      });
    }
    const origins = new Map<string, Origin>();
    const resolveOrigin = async (set: CandidateBindings["bindings"], key: string) => {
      const binding = set.find((b) => b.name === key);
      if (binding?.type !== "hyperdrive")
        throw Error("Dedicated funding Hyperdrive binding required");
      const id = string(binding.id, "Hyperdrive ID");
      if (!origins.has(id)) {
        const configuration = object(
          await dependencies.api(`${base}/hyperdrive/configs/${id}`),
          "Hyperdrive",
        );
        if (
          configuration.id !== id ||
          object(configuration.caching, "Hyperdrive caching").disabled !== true
        )
          throw Error("Funding requires the exact cache-disabled Hyperdrive resource");
        origins.set(id, originFields(configuration.origin));
      }
      return { id, origin: origins.get(id) as Origin };
    };
    const evidence = [];
    for (const inventory of inventories) {
      const general = await resolveOrigin(inventory.bindings, "CONTROL_PLANE");
      const hasFunding = inventory.bindings.some((b) => b.name === name);
      // An older serving version remains on its unchanged Dance contract. The
      // new candidate may add capability, but never repoint its general role.
      const keys = hasFunding ? ["CONTROL_PLANE", name] : ["CONTROL_PLANE"];
      if (!hasFunding && inventory.version_id.startsWith("candidate:"))
        throw Error("Dedicated funding binding missing");
      for (const key of keys) {
        const resolved =
          key === "CONTROL_PLANE" ? general : await resolveOrigin(inventory.bindings, key);
        if (
          key !== "CONTROL_PLANE" &&
          (resolved.id === general.id ||
            resolved.origin.user === general.origin.user ||
            resolved.origin.host !== general.origin.host ||
            resolved.origin.database !== general.origin.database ||
            resolved.origin.port !== general.origin.port)
        )
          throw Error("Funding and Dance authority must be distinct on the same database");
        const url =
          dependencies.environment[
            key === "CONTROL_PLANE" ? "CONTROL_PLANE_POSTGRES_RUNTIME_URL" : `${name}_POSTGRES_URL`
          ];
        if (!url) throw Error("Binding-specific database permission URL required");
        assertFundingOrigin(url, resolved.origin, await dependencies.identity(url));
        const role =
          key === "CONTROL_PLANE"
            ? await dependencies.dancePermissions(url, configPath as DanceServingConsumer)
            : await dependencies.fundingPermissions(url, purpose);
        if (role !== resolved.origin.user) throw Error("Permission principal changed");
        evidence.push({
          version_id: inventory.version_id,
          percentage: inventory.percentage,
          binding: key,
          hyperdrive_id: resolved.id,
          origin: resolved.origin,
          role,
        });
      }
    }
    if (digest(await deployment()) !== digest(before))
      throw Error("Serving allocation changed during funding admission");
    return {
      source_sha: sourceSha,
      config_path: configPath,
      environment,
      worker_name: candidate.worker_name,
      evidence,
    };
  };
  const receipt = await collect();
  return {
    receipt,
    recheck: async () => {
      if (digest(await collect()) !== digest(receipt))
        throw Error("Funding binding admission changed before upload");
    },
    readback: collect,
  };
}
