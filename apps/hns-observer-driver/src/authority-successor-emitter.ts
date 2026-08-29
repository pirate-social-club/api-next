import {
  type HnsAuthorityEmitChainRecordV1,
  type HnsAuthorityEmitDsV1,
  type HnsAuthorityEmitViewV1,
  type HnsAuthoritySuccessorGenerationSnapshotV1,
  prepareHnsAuthoritySuccessorCandidateV1,
} from "@pirate/application/hns-host-persistence";

export const HNS_AUTHORITY_SUCCESSOR_EMISSION_INPUT_VERSION =
  "pirate-hns-authority-successor-emission-input-v1" as const;

const artifactNames = [
  "authority_inventory",
  "dns_zone_activation",
  "app_host_activation",
  "health_observation",
  "observer_evidence",
] as const;

type ArtifactName = (typeof artifactNames)[number];

export type HnsAuthoritySuccessorEmissionInputV1 = Readonly<{
  version: typeof HNS_AUTHORITY_SUCCESSOR_EMISSION_INPUT_VERSION;
  source_commit: string;
  root_label: string;
  observed_at: string;
  chain_height: number;
  expected_chain_network: string;
  chain_authority_records: ReadonlyArray<HnsAuthorityEmitChainRecordV1>;
  generation_snapshot: HnsAuthoritySuccessorGenerationSnapshotV1;
  expected_authority_addresses: readonly [string, string];
  authority_views: readonly [HnsAuthorityEmitViewV1, HnsAuthorityEmitViewV1];
  artifact_paths: Readonly<Record<ArtifactName, string>>;
}>;

export class HnsAuthoritySuccessorEmitterError extends Error {
  readonly name = "HnsAuthoritySuccessorEmitterError";

  constructor(
    readonly reason:
      | "invalid_arguments"
      | "invalid_input_document"
      | "input_too_large"
      | "artifact_read_failed"
      | "artifact_too_large",
  ) {
    super(`HNS authority successor emitter refused: ${reason}`);
  }
}

const inputMaxBytes = 65_536;
const artifactMaxBytes = 4 * 1_024 * 1_024;

function exactObject(
  value: unknown,
  keys: ReadonlyArray<string>,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !value.includes("\0");
}

function validDs(value: unknown): value is HnsAuthorityEmitDsV1 {
  if (!Array.isArray(value) || value.length !== 4) return false;
  const [keyTag, algorithm, digestType, digest] = value;
  return (
    Number.isSafeInteger(keyTag) &&
    (keyTag as number) >= 1 &&
    (keyTag as number) <= 65_535 &&
    algorithm === 13 &&
    (digestType === 2 || digestType === 4) &&
    typeof digest === "string" &&
    new RegExp(digestType === 2 ? "^[0-9a-f]{64}$" : "^[0-9a-f]{96}$", "u").test(digest)
  );
}

function validChainAuthorityRecord(value: unknown): value is HnsAuthorityEmitChainRecordV1 {
  if (!Array.isArray(value)) return false;
  if (value[0] === "NS") return value.length === 2 && typeof value[1] === "string";
  if (value[0] === "GLUE4" || value[0] === "GLUE6") {
    return value.length === 3 && typeof value[1] === "string" && typeof value[2] === "string";
  }
  return (
    value[0] === "DS" &&
    value.length === 5 &&
    Number.isSafeInteger(value[1]) &&
    Number.isSafeInteger(value[2]) &&
    Number.isSafeInteger(value[3]) &&
    typeof value[4] === "string"
  );
}

function validView(value: unknown): value is HnsAuthorityEmitViewV1 {
  if (
    !exactObject(value, [
      "authority_address",
      "outcome",
      "zone_bytes_digest",
      "dnskey_key_tag",
      "derived_ds",
    ]) ||
    typeof value.authority_address !== "string" ||
    (value.outcome !== "observed" && value.outcome !== "unavailable")
  ) {
    return false;
  }
  if (value.outcome === "unavailable") {
    return (
      value.zone_bytes_digest === null && value.dnskey_key_tag === null && value.derived_ds === null
    );
  }
  return (
    typeof value.zone_bytes_digest === "string" &&
    /^[0-9a-f]{64}$/u.test(value.zone_bytes_digest) &&
    Number.isSafeInteger(value.dnskey_key_tag) &&
    (value.dnskey_key_tag as number) >= 1 &&
    (value.dnskey_key_tag as number) <= 65_535 &&
    Array.isArray(value.derived_ds) &&
    value.derived_ds.length > 0 &&
    value.derived_ds.every(validDs)
  );
}

function validArtifactPaths(value: unknown): value is Record<ArtifactName, string> {
  if (!exactObject(value, artifactNames)) return false;
  const paths = artifactNames.map((name) => value[name]);
  return paths.every(isAbsolutePath) && new Set(paths).size === artifactNames.length;
}

export function decodeHnsAuthoritySuccessorEmissionInputV1(
  bytes: Uint8Array,
): HnsAuthoritySuccessorEmissionInputV1 {
  if (bytes.byteLength === 0 || bytes.byteLength > inputMaxBytes) {
    throw new HnsAuthoritySuccessorEmitterError(
      bytes.byteLength > inputMaxBytes ? "input_too_large" : "invalid_input_document",
    );
  }
  const copy = new Uint8Array(bytes);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(copy));
  } catch {
    throw new HnsAuthoritySuccessorEmitterError("invalid_input_document");
  }
  if (
    new TextEncoder().encode(JSON.stringify(value)).some((byte, index) => byte !== copy[index]) ||
    new TextEncoder().encode(JSON.stringify(value)).byteLength !== copy.byteLength ||
    !exactObject(value, [
      "version",
      "source_commit",
      "root_label",
      "observed_at",
      "chain_height",
      "expected_chain_network",
      "chain_authority_records",
      "generation_snapshot",
      "expected_authority_addresses",
      "authority_views",
      "artifact_paths",
    ]) ||
    value.version !== HNS_AUTHORITY_SUCCESSOR_EMISSION_INPUT_VERSION ||
    typeof value.source_commit !== "string" ||
    typeof value.root_label !== "string" ||
    typeof value.observed_at !== "string" ||
    !Number.isSafeInteger(value.chain_height) ||
    typeof value.expected_chain_network !== "string" ||
    !Array.isArray(value.chain_authority_records) ||
    !value.chain_authority_records.every(validChainAuthorityRecord) ||
    !exactObject(value.generation_snapshot, [
      "dns_zone_activation_id",
      "dns_current_generation",
      "app_host_activation_id",
      "app_host_current_generation",
      "successor_dns_latest_health_generation",
    ]) ||
    typeof value.generation_snapshot.dns_zone_activation_id !== "string" ||
    !Number.isSafeInteger(value.generation_snapshot.dns_current_generation) ||
    typeof value.generation_snapshot.app_host_activation_id !== "string" ||
    !Number.isSafeInteger(value.generation_snapshot.app_host_current_generation) ||
    !Number.isSafeInteger(value.generation_snapshot.successor_dns_latest_health_generation) ||
    !Array.isArray(value.expected_authority_addresses) ||
    value.expected_authority_addresses.length !== 2 ||
    !value.expected_authority_addresses.every((address) => typeof address === "string") ||
    !Array.isArray(value.authority_views) ||
    value.authority_views.length !== 2 ||
    !value.authority_views.every(validView) ||
    !validArtifactPaths(value.artifact_paths)
  ) {
    throw new HnsAuthoritySuccessorEmitterError("invalid_input_document");
  }
  return value as HnsAuthoritySuccessorEmissionInputV1;
}

export type HnsAuthoritySuccessorEmitterIoV1 = Readonly<{
  read: (absolutePath: string, maximumBytes: number) => Promise<Uint8Array>;
  emit: (candidateBytes: Uint8Array) => Promise<void>;
}>;

type CandidatePreparer = typeof prepareHnsAuthoritySuccessorCandidateV1;

export async function runHnsAuthoritySuccessorEmitterV1(
  args: readonly string[],
  io: HnsAuthoritySuccessorEmitterIoV1,
  prepare: CandidatePreparer = prepareHnsAuthoritySuccessorCandidateV1,
): Promise<Awaited<ReturnType<CandidatePreparer>>> {
  if (args.length !== 2 || args[0] !== "--input" || !isAbsolutePath(args[1])) {
    throw new HnsAuthoritySuccessorEmitterError("invalid_arguments");
  }
  let inputBytes: Uint8Array;
  try {
    inputBytes = await io.read(args[1], inputMaxBytes);
  } catch {
    throw new HnsAuthoritySuccessorEmitterError("artifact_read_failed");
  }
  const input = decodeHnsAuthoritySuccessorEmissionInputV1(inputBytes);
  const entries = await Promise.all(
    artifactNames.map(async (name) => {
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await io.read(input.artifact_paths[name], artifactMaxBytes));
      } catch {
        throw new HnsAuthoritySuccessorEmitterError("artifact_read_failed");
      }
      if (bytes.byteLength === 0 || bytes.byteLength > artifactMaxBytes) {
        throw new HnsAuthoritySuccessorEmitterError("artifact_too_large");
      }
      return [name, bytes] as const;
    }),
  );
  const artifacts = Object.fromEntries(entries) as Record<ArtifactName, Uint8Array>;
  const result = await prepare({
    source_commit: input.source_commit,
    root_label: input.root_label,
    observed_at: input.observed_at,
    chain_height: input.chain_height,
    expected_chain_network: input.expected_chain_network,
    chain_authority_records: input.chain_authority_records,
    generation_snapshot: input.generation_snapshot,
    expected_authority_addresses: input.expected_authority_addresses,
    authority_views: input.authority_views,
    artifacts,
  });
  await io.emit(result.candidate_bytes);
  return result;
}
