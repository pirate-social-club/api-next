import { Client } from "pg";

/**
 * The compatible service/schema pair for the single-owner readiness cutover.
 *
 * The removal migration records this contract in
 * `hns_lifecycle_schema_cutover`. The serving path refuses before claiming any
 * work when its own declared version is outside the compatible set, so a
 * pre-cutover bundle fails closed instead of falling back to the removed
 * marker or the removed legacy acceptance path.
 */
export const HNS_AUTHORITY_SERVICE_VERSION = "pirate-hns-authority-provisioner-v2" as const;
export const HNS_LIFECYCLE_JOB_ENVELOPE_VERSION = "hns-lifecycle-job-envelope-v1" as const;

export type SchemaCutoverState = Readonly<{
  readonly cutover_version: string;
  readonly compatible_service_versions: readonly string[];
  readonly compatible_job_envelope_versions: readonly string[];
}>;

export type SchemaCompatibilityRefusal = Readonly<{
  readonly outcome: "schema_incompatible";
  readonly service_version: string;
  readonly job_envelope_version: string;
  readonly cutover_version: string | null;
  readonly compatible_service_versions: readonly string[];
  readonly compatible_job_envelope_versions: readonly string[];
  readonly missing: "service_version" | "job_envelope_version" | "service_and_envelope";
}>;

const MAX_VERSION_LENGTH = 128;
const MAX_COMPATIBLE_ENTRIES = 8;
const VERSION_SHAPE = /^[A-Za-z0-9._:@/-]+$/u;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point < 0x20 || (point >= 0x7f && point <= 0x9f)) return true;
  }
  return false;
}

/**
 * A bounded, redacted refusal value, or null when the running service is
 * compatible or the schema predates the cutover record.
 */
export function schemaCompatibilityRefusal(input: {
  readonly state: SchemaCutoverState | null;
  readonly service_version: string;
  readonly job_envelope_version: string;
}): SchemaCompatibilityRefusal | null {
  if (input.state === null) return null;
  const serviceOk = input.state.compatible_service_versions.includes(input.service_version);
  const envelopeOk = input.state.compatible_job_envelope_versions.includes(
    input.job_envelope_version,
  );
  if (serviceOk && envelopeOk) return null;
  return {
    outcome: "schema_incompatible",
    service_version: boundVersion(input.service_version),
    job_envelope_version: boundVersion(input.job_envelope_version),
    cutover_version: boundVersion(input.state.cutover_version),
    compatible_service_versions: input.state.compatible_service_versions
      .slice(0, MAX_COMPATIBLE_ENTRIES)
      .map(boundVersion),
    compatible_job_envelope_versions: input.state.compatible_job_envelope_versions
      .slice(0, MAX_COMPATIBLE_ENTRIES)
      .map(boundVersion),
    missing:
      !serviceOk && !envelopeOk
        ? "service_and_envelope"
        : !serviceOk
          ? "service_version"
          : "job_envelope_version",
  };
}

function boundVersion(value: string): string {
  const trimmed = value.length > MAX_VERSION_LENGTH ? value.slice(0, MAX_VERSION_LENGTH) : value;
  return hasControlCharacter(trimmed) ? "<redacted>" : trimmed;
}

export function isBoundedVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_VERSION_LENGTH &&
    value.trim() === value &&
    VERSION_SHAPE.test(value) &&
    !hasControlCharacter(value)
  );
}

function isUndefinedTable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly code?: unknown }).code === "42P01"
  );
}

export async function readSchemaCutoverState(
  query: (text: string) => Promise<{ readonly rows: readonly Record<string, unknown>[] }>,
): Promise<SchemaCutoverState | null> {
  let result: { readonly rows: readonly Record<string, unknown>[] };
  try {
    result = await query(
      `SELECT cutover_version, compatible_service_versions,
              compatible_job_envelope_versions
         FROM hns_lifecycle_schema_cutover
        ORDER BY recorded_at DESC, cutover_version DESC
        LIMIT 1`,
    );
  } catch (error) {
    // The pre-cutover schema has no compatibility record: that state is
    // compatible with both bundles, so the check reports it rather than
    // inventing a refusal.
    if (isUndefinedTable(error)) return null;
    throw error;
  }
  const row = result.rows[0];
  if (row === undefined) return null;
  const serviceVersions = row.compatible_service_versions;
  const envelopeVersions = row.compatible_job_envelope_versions;
  if (
    typeof row.cutover_version !== "string" ||
    !Array.isArray(serviceVersions) ||
    !serviceVersions.every((entry) => typeof entry === "string") ||
    !Array.isArray(envelopeVersions) ||
    !envelopeVersions.every((entry) => typeof entry === "string")
  ) {
    throw new Error("HNS lifecycle schema compatibility record is malformed");
  }
  return {
    cutover_version: row.cutover_version,
    compatible_service_versions: serviceVersions as readonly string[],
    compatible_job_envelope_versions: envelopeVersions as readonly string[],
  };
}

/**
 * The serving path's startup check. Opens one short-lived client, reads the
 * cutover record and returns the bounded refusal or null, plus whether the
 * schema is past the cutover record. The connection string is never included
 * in the refusal.
 */
export async function hnsLifecycleSchemaCutoverCheck(input: {
  readonly connection_string: string;
  readonly service_version: string;
  readonly job_envelope_version: string;
}): Promise<Readonly<{ refusal: SchemaCompatibilityRefusal | null; post_cutover: boolean }>> {
  const client = new Client({ connectionString: input.connection_string });
  await client.connect();
  try {
    const state = await readSchemaCutoverState((text) => client.query(text));
    return {
      refusal: schemaCompatibilityRefusal({
        state,
        service_version: input.service_version,
        job_envelope_version: input.job_envelope_version,
      }),
      post_cutover: state !== null,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Runs the controlled readiness probe as this service's executor and returns
 * a bounded outcome. The probe is seeded by the deployment sequence; a
 * missing probe function on a cutover schema is reported as
 * `probe_unavailable` rather than falling through to serving.
 */
export async function runHnsLifecycleCutoverProbe(input: {
  readonly connection_string: string;
  readonly executor_id: string;
  readonly service_version: string;
  readonly bundle_sha256: string;
}): Promise<string> {
  const client = new Client({ connectionString: input.connection_string });
  await client.connect();
  try {
    const result = await client.query<{ outcome: string }>(
      "SELECT run_hns_lifecycle_readiness_cutover_probe_v1($1,$2,$3) AS outcome",
      [input.executor_id, input.service_version, input.bundle_sha256],
    );
    const outcome = result.rows[0]?.outcome;
    return typeof outcome === "string" ? outcome.slice(0, 64) : "probe_unavailable";
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { readonly code?: unknown }).code === "42883"
    ) {
      return "probe_unavailable";
    }
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}
