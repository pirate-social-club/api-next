import { Client } from "pg";
import { localResetRecoveryTool } from "./staging-persona-local-recovery-tool";
import { localRecoveryTestUrl } from "./staging-persona-recovery-test-target";
import {
  loadStagingResetArtifacts,
  validateStagingResetArtifacts,
} from "./staging-persona-reset-plan";
import { readResetSchemaShape } from "./staging-persona-schema-shape";

/** Independent baseline measurement in a UUID-named LOCAL database only.
 * The provider target is never accepted here and no caller digest is trusted.
 */
export async function measureRehearsalReference() {
  const artifacts = loadStagingResetArtifacts();
  const plan = validateStagingResetArtifacts(artifacts);
  const source = localRecoveryTestUrl(process.env.CONTROL_PLANE_POSTGRES_TEST_URL ?? "");
  const database = `phased_reset_${crypto.randomUUID().replaceAll("-", "")}`;
  const url = new URL(source);
  url.pathname = `/${database}`;
  const root = new Client({ connectionString: source.toString(), connectionTimeoutMillis: 10_000 });
  const reference = new Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: 10_000,
  });
  let created = false;
  try {
    await root.connect();
    const version = Number(
      (await root.query("SHOW server_version_num")).rows[0].server_version_num,
    );
    if (version < 170000 || version >= 180000) throw new Error("reference_postgres17_required");
    await root.query(`CREATE DATABASE "${database}"`);
    created = true;
    await reference.connect();
    await reference.query("CREATE SCHEMA api_next");
    await localResetRecoveryTool(
      url,
      "psql",
      ["--set", "ON_ERROR_STOP=1"],
      new TextEncoder().encode(artifacts.baseline),
    );
    await reference.query("SET search_path=pg_catalog");
    const measured = await readResetSchemaShape(reference);
    return {
      source_sha: plan.sourceSha,
      baseline_file_sha256: plan.baselineSha256,
      schema_sha256: measured.sha256,
    };
  } finally {
    await reference.end().catch(() => undefined);
    try {
      if (created) await root.query(`DROP DATABASE "${database}"`);
    } finally {
      await root.end().catch(() => undefined);
    }
  }
}
