import {
  decodeHnsResourceV1,
  hnsRetainedAuthorityFromPlanDocumentV1,
} from "@pirate/application/namespace-ownership";
import { makeHsdRootResourceObserver } from "./hsd.ts";
import {
  gatherHnsIncidentEvidenceV1,
  type HnsIncidentEvidencePortsV1,
  type HnsIncidentEvidenceReportV1,
} from "./incident-evidence.ts";
import { makeHnsIncidentHsdReadsV1, makeHnsIncidentRetainedPlanReadV1 } from "./incident-hsd.ts";
import { makePowerDnsZoneAvailabilityReadV1 } from "./powerdns.ts";

/**
 * The read-only incident command.
 *
 * It reuses the provisioner's existing HSD and PowerDNS configuration — the
 * same environment names the serving path reads — and adds no second
 * configuration surface. Every call it makes is a read: it inspects the
 * chain, the retained plan and the provider, classifies what it found, and
 * says whether the classification could be persisted. It does not write a
 * finding, authorize anything, or mutate a name, a zone or an operation.
 *
 * The operation may be named exactly by its root-import session id, or by
 * community plus root label. A root can have more than one session, so an
 * ambiguous match lists its candidates and refuses to choose.
 *
 * Missing prerequisites are reported explicitly and by name, in the four
 * insufficient-evidence reasons the classifier already owns plus the
 * configuration list here. An unread provider or an unresolvable transaction
 * is not a finding about the name.
 */

export type HnsIncidentCommandInputV1 =
  | Readonly<{ readonly kind: "session"; readonly sessionId: string }>
  | Readonly<{
      readonly kind: "community_root";
      readonly communityId: string;
      readonly rootLabel: string;
    }>;

export function parseHnsIncidentCommandArgumentsV1(
  args: readonly string[],
): HnsIncidentCommandInputV1 {
  if (
    args.length === 2 &&
    args[0] === "--session" &&
    args[1] !== undefined &&
    args[1].length > 0 &&
    !args[1].startsWith("--")
  ) {
    return { kind: "session", sessionId: args[1] };
  }
  if (
    args.length === 4 &&
    args[0] === "--community" &&
    args[1] !== undefined &&
    args[1].length > 0 &&
    !args[1].startsWith("--") &&
    args[2] === "--root" &&
    args[3] !== undefined &&
    args[3].length > 0 &&
    !args[3].startsWith("--")
  ) {
    return { kind: "community_root", communityId: args[1], rootLabel: args[3] };
  }
  throw new Error(
    "HNS incident command arguments are invalid: use `--session <root-import-session-id>` " +
      "or `--community <community-id> --root <root-label>`",
  );
}

type HnsIncidentSessionCandidateV1 = Readonly<{
  readonly root_import_session_id: string;
  readonly status: string;
  readonly created_at: Date | string;
}>;

export type HnsIncidentSessionResolutionV1 =
  | Readonly<{ readonly outcome: "resolved"; readonly sessionId: string }>
  | Readonly<{ readonly outcome: "none" }>
  | Readonly<{
      readonly outcome: "ambiguous";
      readonly candidates: readonly HnsIncidentSessionCandidateV1[];
    }>;

type IncidentQuery = <Row = Record<string, unknown>>(
  text: string,
  values?: readonly unknown[],
) => Promise<{ readonly rows: Row[] }>;

/** A root can carry several sessions; ambiguity is reported, never guessed. */
export async function resolveHnsIncidentSessionV1(
  query: IncidentQuery,
  input: HnsIncidentCommandInputV1,
): Promise<HnsIncidentSessionResolutionV1> {
  if (input.kind === "session") {
    return { outcome: "resolved", sessionId: input.sessionId };
  }
  const result = await query<HnsIncidentSessionCandidateV1>(
    `SELECT root_import_session_id, status, created_at
       FROM hns_root_import_sessions
      WHERE community_id = $1 AND root_label = $2
      ORDER BY created_at DESC, root_import_session_id`,
    [input.communityId, input.rootLabel],
  );
  if (result.rows.length === 0) return { outcome: "none" };
  if (result.rows.length > 1) return { outcome: "ambiguous", candidates: result.rows };
  const [candidate] = result.rows;
  if (candidate === undefined) return { outcome: "none" };
  return { outcome: "resolved", sessionId: candidate.root_import_session_id };
}

const REQUIRED_CONFIGURATION = [
  "CONTROL_PLANE_POSTGRES_URL",
  "HNS_AUTHORITY_HSD_RPC_URL",
  "HNS_AUTHORITY_HSD_AUTHORIZATION",
  "HNS_AUTHORITY_CHAIN_NETWORK",
  "HNS_AUTHORITY_CHAIN_GENESIS_BLOCK_HASH",
  "HNS_AUTHORITY_TREE_INTERVAL_BLOCKS",
  "HNS_AUTHORITY_SAFE_CONFIRMATIONS",
  "HNS_AUTHORITY_MAXIMUM_TIP_AGE_SECONDS",
  "HNS_AUTHORITY_MAXIMUM_FUTURE_TIP_SECONDS",
  "HNS_AUTHORITY_PDNS_API_URL",
  "HNS_AUTHORITY_PDNS_API_KEY",
  "HNS_AUTHORITY_PDNS_SERVER_ID",
] as const;

/** Reports every missing prerequisite at once rather than failing on the first. */
export function collectMissingIncidentConfiguration(
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  return REQUIRED_CONFIGURATION.filter((name) => {
    const value = env[name];
    return value === undefined || value.trim() !== value || value.length === 0;
  });
}

function requiredFrom(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() !== value || value.length === 0) {
    throw new Error(`HNS incident command configuration is missing ${name}`);
  }
  return value;
}

function chainIntegerFrom(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const value = Number(requiredFrom(env, name));
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`HNS incident command configuration is invalid: ${name}`);
  }
  return value;
}

const sha256Hex = async (hex: string): Promise<string> => {
  const bytes = Uint8Array.from((hex.match(/../gu) ?? []).map((byte) => Number.parseInt(byte, 16)));
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

function planEncodedDigestFromBytes(bytes: Uint8Array): string | null {
  try {
    const plan = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const digest = plan.encoded_resource_sha256;
    return typeof digest === "string" && /^[0-9a-f]{64}$/u.test(digest) ? digest : null;
  } catch {
    return null;
  }
}

/**
 * Builds the real read-only ports from the same configuration the serving
 * path uses. No provider client here can mutate: HSD reads are name,
 * transaction and header lookups, and the PowerDNS read is a GET.
 */
function makeHnsIncidentPortsFromConfigurationV1(
  env: Readonly<Record<string, string | undefined>>,
  query: IncidentQuery,
  fetcher: typeof fetch,
): HnsIncidentEvidencePortsV1 {
  const observer = makeHsdRootResourceObserver(
    {
      rpc_url: requiredFrom(env, "HNS_AUTHORITY_HSD_RPC_URL"),
      authorization: requiredFrom(env, "HNS_AUTHORITY_HSD_AUTHORIZATION"),
      chain_network: requiredFrom(env, "HNS_AUTHORITY_CHAIN_NETWORK"),
      genesis_block_hash: requiredFrom(env, "HNS_AUTHORITY_CHAIN_GENESIS_BLOCK_HASH"),
      tree_interval_blocks: chainIntegerFrom(env, "HNS_AUTHORITY_TREE_INTERVAL_BLOCKS", 1, 2_000),
      safe_minimum_confirmations: chainIntegerFrom(
        env,
        "HNS_AUTHORITY_SAFE_CONFIRMATIONS",
        0,
        1_000,
      ),
      maximum_tip_age_seconds: chainIntegerFrom(
        env,
        "HNS_AUTHORITY_MAXIMUM_TIP_AGE_SECONDS",
        60,
        86_400,
      ),
      maximum_future_tip_seconds: chainIntegerFrom(
        env,
        "HNS_AUTHORITY_MAXIMUM_FUTURE_TIP_SECONDS",
        0,
        3_600,
      ),
    },
    fetcher,
  );
  const reads = makeHnsIncidentHsdReadsV1(
    {
      rpc_url: requiredFrom(env, "HNS_AUTHORITY_HSD_RPC_URL"),
      authorization: requiredFrom(env, "HNS_AUTHORITY_HSD_AUTHORIZATION"),
    },
    fetcher,
  );
  const zoneAvailability = makePowerDnsZoneAvailabilityReadV1(
    {
      api_url: requiredFrom(env, "HNS_AUTHORITY_PDNS_API_URL"),
      api_key: requiredFrom(env, "HNS_AUTHORITY_PDNS_API_KEY"),
      server_id: requiredFrom(env, "HNS_AUTHORITY_PDNS_SERVER_ID"),
    },
    fetcher,
  );
  return {
    ...reads,
    observe_chain: observer,
    zone_availability: (rootLabel: string) => zoneAvailability({ root_label: rootLabel }),
    retained_plan: makeHnsIncidentRetainedPlanReadV1(
      query,
      hnsRetainedAuthorityFromPlanDocumentV1,
      planEncodedDigestFromBytes,
    ),
    decode_resource: (hex: string) =>
      decodeHnsResourceV1(
        Uint8Array.from((hex.match(/../gu) ?? []).map((byte) => Number.parseInt(byte, 16))),
      ),
    sha256_hex: sha256Hex,
  };
}

/** The report an operator reads: what was found, what it supports, what is missing. */
export function formatHnsIncidentReportV1(
  report: HnsIncidentEvidenceReportV1,
): Record<string, unknown> {
  const evidence = report.evidence;
  const unresolved: string[] = [];
  if (evidence.retained_plan_encoded_sha256 === null) unresolved.push("retained_plan_digest");
  if (evidence.retained_authority === null) unresolved.push("retained_authority");
  if (evidence.current === null) unresolved.push("current_view");
  if (evidence.safe === null) unresolved.push("safe_view");
  if (evidence.zone === null) unresolved.push("provider_availability");
  if (evidence.inclusion === null) unresolved.push("transaction_inclusion");
  if (evidence.decoded_resource === null) unresolved.push("decoded_resource");
  return {
    command: "incident-report",
    outcome: "classified",
    root_import_session_id: report.root_import_session_id,
    root_label: report.root_label,
    generation: report.generation,
    revision: report.revision,
    recordable: report.recordable,
    classification: report.finding.classification,
    reason: report.finding.reason,
    supported_action: report.finding.supported_action,
    inspected_views: report.finding.inspected_views,
    evidence_ref: report.evidence_ref,
    unresolved_evidence: unresolved,
    evidence,
  };
}

export type HnsIncidentCommandDependenciesV1 = Readonly<{
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly query: IncidentQuery;
  readonly fetch: typeof fetch;
  readonly write: (line: string) => void;
}>;

export type HnsIncidentPortsFactoryV1 = (
  env: Readonly<Record<string, string | undefined>>,
  query: IncidentQuery,
  fetcher: typeof fetch,
) => HnsIncidentEvidencePortsV1;

/** Returns a process exit code; the report itself is the written JSON line. */
export async function runHnsIncidentReportCommandV1(
  args: readonly string[],
  dependencies: HnsIncidentCommandDependenciesV1,
  makePorts: HnsIncidentPortsFactoryV1 = makeHnsIncidentPortsFromConfigurationV1,
): Promise<number> {
  const write = (value: Record<string, unknown>): void => dependencies.write(JSON.stringify(value));
  let input: HnsIncidentCommandInputV1;
  try {
    input = parseHnsIncidentCommandArgumentsV1(args);
  } catch (error) {
    write({
      command: "incident-report",
      outcome: "arguments_invalid",
      detail: error instanceof Error ? error.message : "invalid arguments",
    });
    return 1;
  }
  const missing = collectMissingIncidentConfiguration(dependencies.env);
  if (missing.length > 0) {
    write({ command: "incident-report", outcome: "configuration_missing", missing });
    return 1;
  }
  try {
    const resolution = await resolveHnsIncidentSessionV1(dependencies.query, input);
    if (resolution.outcome === "none") {
      write({ command: "incident-report", outcome: "session_absent", input });
      return 1;
    }
    if (resolution.outcome === "ambiguous") {
      write({
        command: "incident-report",
        outcome: "session_ambiguous",
        candidates: resolution.candidates.map((candidate) => ({
          root_import_session_id: candidate.root_import_session_id,
          status: candidate.status,
          created_at:
            candidate.created_at instanceof Date
              ? candidate.created_at.toISOString()
              : candidate.created_at,
        })),
      });
      return 1;
    }
    const ports = makePorts(dependencies.env, dependencies.query, dependencies.fetch);
    const report = await gatherHnsIncidentEvidenceV1(resolution.sessionId, ports);
    if (report === null) {
      write({
        command: "incident-report",
        outcome: "operation_absent",
        root_import_session_id: resolution.sessionId,
      });
      return 1;
    }
    write(formatHnsIncidentReportV1(report));
    return 0;
  } catch (error) {
    write({
      command: "incident-report",
      outcome: "failed",
      detail: error instanceof Error ? error.message : "incident report failed",
    });
    return 1;
  }
}
