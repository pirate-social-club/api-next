import {
  AlertCollector,
  ControlPlaneDb,
  completeHnsRouteRevalidation,
  startHnsRouteRevalidation,
} from "@pirate/application";
import type {
  HnsRouteRevalidationCompletionProvider,
  HnsRouteRevalidationStartProvider,
} from "@pirate/application/route-revalidation";
import type { AlertSink } from "@pirate/platform-cf";
import {
  makeControlPlaneRouteRevalidationCompletionStore,
  makeControlPlaneRouteRevalidationStartStore,
  makeHnsOwnerRouteRevalidationTransport,
  makeHnsRouteRevalidationProvider,
} from "@pirate/platform-cf";
import type { HnsOwnerServiceBinding } from "@pirate/platform-cf/namespace-ownership/hns-owner-service-binding";
import { Effect, Layer } from "effect";

import {
  defaultRetrySchedule,
  JobContext,
  type JobDeclaration,
  type SeverityMapping,
  type TableKey,
} from "./registry";

export const HNS_ROUTE_REVALIDATION_JOB = "hns-route-revalidation.poll";
export const HNS_ROUTE_REVALIDATION_LANE = "hns-route-revalidation";
export const HNS_ROUTE_REVALIDATION_SCHEDULE = "*/5 * * * *";
export const HNS_ROUTE_REVALIDATION_TIMEOUT = "45 seconds";
export const HNS_ROUTE_REVALIDATION_PRINCIPAL_ID = "route-revalidation-scheduler";
export const HNS_ROUTE_REVALIDATION_LEAD_SECONDS = 24 * 60 * 60;
export const HNS_ROUTE_REVALIDATION_BATCH_LIMIT = 25;

export const HNS_ROUTE_REVALIDATION_READS = [
  "postgres:communities",
  "postgres:community_canonical_route_bindings",
  "postgres:community_route_ownership_evidence",
  "postgres:community_creation_subject_claims",
  "postgres:community_creation_requirement_states",
  "postgres:community_route_revalidation_start_reservations",
  "postgres:community_route_revalidation_sessions",
  "postgres:community_route_revalidation_completion_attempts",
] as const satisfies readonly TableKey[];

export const HNS_ROUTE_REVALIDATION_WRITES = [
  "postgres:community_route_revalidation_start_reservations",
  "postgres:community_route_revalidation_sessions",
  "postgres:community_route_revalidation_completion_attempts",
  "postgres:community_route_revalidation_evidence_snapshots",
  "postgres:community_route_ownership_evidence",
  "postgres:community_canonical_route_bindings",
] as const satisfies readonly TableKey[];

export const HNS_ROUTE_REVALIDATION_SEVERITY: SeverityMapping = {
  expectedFailure: {
    HnsRouteRevalidationStartRejected: "medium",
    HnsRouteRevalidationStartStorageFailed: "high",
    HnsRouteRevalidationProviderFailed: "medium",
    HnsRouteRevalidationCompletionRejected: "medium",
    HnsRouteRevalidationCompletionStorageFailed: "high",
  },
  timeout: "high",
  transactionOutcomeUnknown: "high",
  defect: "high",
};

export interface HnsRouteRevalidationBindings {
  readonly HNS_OWNER_VERIFIER?: HnsOwnerServiceBinding;
  readonly HNS_OWNERSHIP_ENABLED?: string;
  readonly HNS_OWNERSHIP_CONFIGURATION_REFERENCE?: string;
  readonly HNS_OWNERSHIP_CONFIGURATION_VERSION?: string;
  readonly HNS_REVALIDATION_FORCE_ROUTE_BINDING_ID?: string;
  readonly HNS_REVALIDATION_FORCE_EXPECTED_GENERATION?: string;
}

export type HnsRouteRevalidationForce = Readonly<{
  readonly route_binding_id: string;
  readonly expected_generation: number;
}>;

export type HnsRouteRevalidationComposition =
  | Readonly<{ readonly enabled: false }>
  | Readonly<{
      readonly enabled: true;
      readonly provider: HnsRouteRevalidationCompletionProvider & HnsRouteRevalidationStartProvider;
      readonly configuration: Readonly<{
        readonly kind: "managed";
        readonly reference: string;
        readonly version: string;
      }>;
      readonly force: HnsRouteRevalidationForce | null;
    }>;

const disabledComposition: HnsRouteRevalidationComposition = Object.freeze({ enabled: false });

function enabledValue(value: string | undefined): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error("Jobs worker HNS route-revalidation configuration is incomplete or invalid");
}

function boundedIdentity(value: string | undefined, maxBytes: number): value is string {
  return (
    value !== undefined &&
    value.length > 0 &&
    value.trim() === value &&
    !value.includes("\u0000") &&
    new TextEncoder().encode(value).byteLength <= maxBytes
  );
}

function forceSelector(bindings: HnsRouteRevalidationBindings): HnsRouteRevalidationForce | null {
  const routeBindingId = bindings.HNS_REVALIDATION_FORCE_ROUTE_BINDING_ID;
  const expectedGeneration = bindings.HNS_REVALIDATION_FORCE_EXPECTED_GENERATION;
  if (routeBindingId === undefined && expectedGeneration === undefined) return null;
  if (
    !boundedIdentity(routeBindingId, 256) ||
    expectedGeneration === undefined ||
    !/^[1-9][0-9]*$/u.test(expectedGeneration)
  ) {
    throw new Error("Jobs worker HNS route-revalidation configuration is incomplete or invalid");
  }
  const generation = Number(expectedGeneration);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("Jobs worker HNS route-revalidation configuration is incomplete or invalid");
  }
  return Object.freeze({ route_binding_id: routeBindingId, expected_generation: generation });
}

/**
 * HNS revalidation is assembled only in the scheduler Worker. The HTTP
 * Worker never receives this provider, and a missing binding/configuration is
 * a startup error when HNS is explicitly enabled.
 */
export function makeHnsRouteRevalidationComposition(
  bindings: HnsRouteRevalidationBindings,
): HnsRouteRevalidationComposition {
  if (!enabledValue(bindings.HNS_OWNERSHIP_ENABLED)) return disabledComposition;
  if (
    bindings.HNS_OWNER_VERIFIER === undefined ||
    !boundedIdentity(bindings.HNS_OWNERSHIP_CONFIGURATION_REFERENCE, 256) ||
    !boundedIdentity(bindings.HNS_OWNERSHIP_CONFIGURATION_VERSION, 128)
  ) {
    throw new Error("Jobs worker HNS route-revalidation configuration is incomplete or invalid");
  }
  const configuration = Object.freeze({
    kind: "managed" as const,
    reference: bindings.HNS_OWNERSHIP_CONFIGURATION_REFERENCE,
    version: bindings.HNS_OWNERSHIP_CONFIGURATION_VERSION,
  });
  const transport = makeHnsOwnerRouteRevalidationTransport(bindings.HNS_OWNER_VERIFIER);
  return Object.freeze({
    enabled: true as const,
    configuration,
    force: forceSelector(bindings),
    provider: makeHnsRouteRevalidationProvider({ transport }),
  });
}

type Row = Readonly<Record<string, unknown>>;

function stringValue(row: Row, key: string): string | null {
  return typeof row[key] === "string" ? row[key] : null;
}

function integerValue(row: Row, key: string): number | null {
  const value = row[key];
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^[0-9]+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function nullableStringValue(row: Row, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : stringValue(row, key);
}

type StartCandidate = Readonly<{
  readonly route_revalidation_id: string;
  readonly revalidation_session_id: string;
  readonly community_id: string;
  readonly route_binding_id: string;
  readonly expected_binding_generation: number;
  readonly expected_verified_evidence_ref: string | null;
  readonly authority_requirement_hash: string;
  readonly provider_id: string;
  readonly provider_binding_hash: string;
  readonly provider_configuration_kind: "managed";
  readonly provider_configuration: Readonly<{
    readonly kind: "managed";
    readonly reference: string;
    readonly version: string;
  }>;
  readonly protocol_version: "hns-txt-v1";
  readonly environment: string;
  readonly root_label: string;
  readonly root_label_display: string;
  readonly path_segment: string;
}>;

function startCandidate(row: Row): StartCandidate | null {
  const routeRevalidationId = stringValue(row, "route_revalidation_id");
  const sessionId = stringValue(row, "revalidation_session_id");
  const communityId = stringValue(row, "community_id");
  const routeBindingId = stringValue(row, "route_binding_id");
  const generation = integerValue(row, "binding_generation");
  const authorityRequirementHash = stringValue(row, "authority_requirement_hash");
  const providerId = stringValue(row, "provider_id");
  const providerBindingHash = stringValue(row, "provider_binding_hash");
  const configurationKind = stringValue(row, "provider_configuration_kind");
  const configurationReference = stringValue(row, "provider_configuration_reference");
  const configurationVersion = stringValue(row, "provider_configuration_version");
  const protocolVersion = stringValue(row, "protocol_version");
  const environment = stringValue(row, "environment");
  const rootLabel = stringValue(row, "root_label");
  const rootLabelDisplay = stringValue(row, "root_label_display");
  const pathSegment = stringValue(row, "path_segment");
  if (
    routeRevalidationId === null ||
    sessionId === null ||
    communityId === null ||
    routeBindingId === null ||
    generation === null ||
    generation < 1 ||
    authorityRequirementHash === null ||
    !/^[0-9a-f]{64}$/u.test(authorityRequirementHash) ||
    providerId !== "hns.owner.v1" ||
    providerBindingHash === null ||
    !/^[0-9a-f]{64}$/u.test(providerBindingHash) ||
    configurationKind !== "managed" ||
    configurationReference === null ||
    configurationVersion === null ||
    protocolVersion !== "hns-txt-v1" ||
    environment === null ||
    rootLabel === null ||
    rootLabelDisplay === null ||
    pathSegment === null
  ) {
    return null;
  }
  return {
    route_revalidation_id: routeRevalidationId,
    revalidation_session_id: sessionId,
    community_id: communityId,
    route_binding_id: routeBindingId,
    expected_binding_generation: generation,
    expected_verified_evidence_ref: nullableStringValue(row, "verified_evidence_ref"),
    authority_requirement_hash: authorityRequirementHash,
    provider_id: providerId,
    provider_binding_hash: providerBindingHash,
    provider_configuration_kind: configurationKind,
    provider_configuration: {
      kind: "managed",
      reference: configurationReference,
      version: configurationVersion,
    },
    protocol_version: protocolVersion,
    environment,
    root_label: rootLabel,
    root_label_display: rootLabelDisplay,
    path_segment: pathSegment,
  };
}

type PendingSession = Readonly<{
  readonly route_revalidation_id: string;
  readonly revalidation_session_id: string;
  readonly expected_binding_generation: number;
  readonly consumed_attempts: number;
}>;

function pendingSession(row: Row): PendingSession | null {
  const routeRevalidationId = stringValue(row, "route_revalidation_id");
  const sessionId = stringValue(row, "revalidation_session_id");
  const generation = integerValue(row, "expected_binding_generation");
  const consumedAttempts = integerValue(row, "consumed_attempts");
  if (
    routeRevalidationId === null ||
    sessionId === null ||
    generation === null ||
    generation < 1 ||
    consumedAttempts === null ||
    consumedAttempts < 0 ||
    consumedAttempts > 3
  ) {
    return null;
  }
  return {
    route_revalidation_id: routeRevalidationId,
    revalidation_session_id: sessionId,
    expected_binding_generation: generation,
    consumed_attempts: consumedAttempts,
  };
}

export const HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL = `
  WITH prior_recovery AS (
    SELECT DISTINCT ON (attempt.route_binding_id, attempt.expected_binding_generation)
      attempt.route_binding_id,
      attempt.expected_binding_generation + 1 AS binding_generation,
      prior_session.community_id,
      prior_session.requirement_hash AS authority_requirement_hash,
      prior_session.provider_id,
      prior_session.provider_binding_hash,
      prior_session.provider_configuration_kind,
      prior_session.provider_configuration_reference,
      prior_session.provider_configuration_version,
      prior_session.protocol_version,
      prior_session.environment,
      prior_session.terminal_at AS prior_terminal_at,
      prior_session.root_label,
      prior_session.root_label_display,
      prior_session.path_segment
    FROM community_route_revalidation_completion_attempts AS attempt
    JOIN community_route_revalidation_sessions AS prior_session
      ON prior_session.route_revalidation_id = attempt.route_revalidation_id
     AND prior_session.revalidation_session_id = attempt.revalidation_session_id
     AND prior_session.route_binding_id = attempt.route_binding_id
     AND prior_session.expected_binding_generation = attempt.expected_binding_generation
    WHERE attempt.state = 'consumed'
      AND attempt.consumption_kind IN (
        'missing_root', 'control_failed', 'challenge_mismatch',
        'insufficient_expiry', 'disputed', 'revoked', 'database_time_expired'
      )
      AND prior_session.principal_kind = 'system'
      AND prior_session.principal_id = $3
      AND prior_session.provider_id = 'hns.owner.v1'
      AND prior_session.provider_configuration_kind = 'managed'
      AND prior_session.protocol_version = 'hns-txt-v1'
      AND prior_session.family = 'hns'
    ORDER BY attempt.route_binding_id, attempt.expected_binding_generation, attempt.terminal_at DESC
  ), candidates AS (
    SELECT
      'hns-route-revalidation:' || b.route_binding_id || ':' || b.binding_generation
        AS route_revalidation_id,
      'hns-route-revalidation-session:' || b.route_binding_id || ':' || b.binding_generation
        AS revalidation_session_id,
      c.community_id,
      b.route_binding_id,
      b.binding_generation,
      b.verified_evidence_ref,
      requirement.requirement_hash AS authority_requirement_hash,
      requirement.provider_id,
      evidence.provider_binding_hash,
      requirement.provider_configuration_kind,
      requirement.provider_configuration_ref AS provider_configuration_reference,
      requirement.provider_configuration_version,
      'hns-txt-v1' AS protocol_version,
      $6::text AS environment,
      b.root_label,
      b.root_label_display,
      b.path_segment
    FROM communities AS c
    JOIN community_canonical_route_bindings AS b
      ON b.community_id = c.community_id
     AND b.family = 'hns'
     AND b.route_lifecycle_status = 'active'
     AND b.ownership_status = 'verified'
     AND b.verified_evidence_ref IS NOT NULL
    JOIN community_route_ownership_evidence AS evidence
      ON evidence.evidence_ref = b.verified_evidence_ref
     AND evidence.family = 'hns'
     AND evidence.root_label = b.root_label
     AND evidence.root_label_display = b.root_label_display
     AND evidence.path_segment = b.path_segment
     AND evidence.binding_generation = b.binding_generation
     AND evidence.provider_id = 'hns.owner.v1'
    JOIN community_creation_subject_claims AS claim
      ON claim.community_id = c.community_id
    JOIN community_creation_requirement_states AS requirement
      ON requirement.intent_id = claim.intent_id
     AND requirement.requirement_kind = 'namespace_ownership'
     AND requirement.status = 'satisfied'
     AND requirement.route_family = 'hns'
     AND requirement.route_root_label = b.root_label
     AND requirement.route_root_label_display = b.root_label_display
     AND requirement.route_path_segment = b.path_segment
     AND requirement.provider_id = 'hns.owner.v1'
     AND requirement.provider_configuration_kind = 'managed'
     AND requirement.provider_binding_hash = evidence.provider_binding_hash
     AND requirement.provider_configuration_version = evidence.provider_configuration_version
    WHERE c.status = 'active'
      AND (
        ($4::text IS NULL AND $5::bigint IS NULL
          AND evidence.expires_at IS NOT NULL
          AND evidence.expires_at <= clock_timestamp() + ($1 * INTERVAL '1 second'))
        OR (b.route_binding_id = $4 AND b.binding_generation = $5)
      )
    UNION ALL
    SELECT
      'hns-route-revalidation:' || b.route_binding_id || ':' || b.binding_generation,
      'hns-route-revalidation-session:' || b.route_binding_id || ':' || b.binding_generation,
      c.community_id,
      b.route_binding_id,
      b.binding_generation,
      NULL,
      prior.authority_requirement_hash,
      prior.provider_id,
      prior.provider_binding_hash,
      prior.provider_configuration_kind,
      prior.provider_configuration_reference,
      prior.provider_configuration_version,
      prior.protocol_version,
      prior.environment,
      b.root_label,
      b.root_label_display,
      b.path_segment
    FROM communities AS c
    JOIN community_canonical_route_bindings AS b
      ON b.community_id = c.community_id
     AND b.family = 'hns'
     AND b.route_lifecycle_status = 'suspended'
     AND b.verified_evidence_ref IS NULL
    JOIN prior_recovery AS prior
      ON prior.route_binding_id = b.route_binding_id
     AND prior.binding_generation = b.binding_generation
     AND prior.community_id = c.community_id
     AND prior.root_label = b.root_label
     AND prior.root_label_display = b.root_label_display
     AND prior.path_segment = b.path_segment
    WHERE c.status = 'active'
      AND (
        (
          $4::text IS NULL
          AND $5::bigint IS NULL
          AND prior.prior_terminal_at <= clock_timestamp() - ($1 * INTERVAL '1 second')
        )
        OR (b.route_binding_id = $4 AND b.binding_generation = $5)
      )
  )
  SELECT *
    FROM candidates
   WHERE provider_id = 'hns.owner.v1'
     AND provider_configuration_kind = 'managed'
     AND protocol_version = 'hns-txt-v1'
   ORDER BY route_binding_id
   LIMIT $2`;

const pendingSessionsSql = `
  SELECT
    s.route_revalidation_id,
    s.revalidation_session_id,
    s.expected_binding_generation,
    COUNT(a.route_revalidation_attempt_id) FILTER (WHERE a.state = 'consumed')::integer
      AS consumed_attempts
  FROM community_route_revalidation_sessions AS s
  LEFT JOIN community_route_revalidation_completion_attempts AS a
    ON a.route_revalidation_id = s.route_revalidation_id
   AND a.revalidation_session_id = s.revalidation_session_id
  WHERE s.status = 'pending'
    AND s.principal_kind = 'system'
    AND s.principal_id = $1
    AND s.provider_id = 'hns.owner.v1'
    AND s.provider_configuration_kind = 'managed'
    AND s.provider_configuration_reference = $2
    AND s.provider_configuration_version = $3
    AND s.environment = $4
  GROUP BY s.route_revalidation_id, s.revalidation_session_id, s.expected_binding_generation
  ORDER BY s.route_revalidation_id
  LIMIT $5`;

export interface HnsRouteRevalidationJobOptions {
  readonly sink: AlertSink;
  readonly provider: HnsRouteRevalidationCompletionProvider & HnsRouteRevalidationStartProvider;
  readonly configuration: Readonly<{
    readonly kind: "managed";
    readonly reference: string;
    readonly version: string;
  }>;
  readonly force: HnsRouteRevalidationForce | null;
  readonly environment: "development" | "staging" | "production";
}

export function makeHnsRouteRevalidationJob(
  options: HnsRouteRevalidationJobOptions,
): JobDeclaration<unknown, ControlPlaneDb | AlertCollector> {
  const run = Effect.gen(function* () {
    const db = yield* ControlPlaneDb;
    yield* AlertCollector;
    const runtime = Layer.succeed(ControlPlaneDb, db);
    const startStore = makeControlPlaneRouteRevalidationStartStore(runtime);
    const completionStore = makeControlPlaneRouteRevalidationCompletionStore(runtime);

    const candidates = yield* db.execute<Row>({
      label: "jobs.hns-route-revalidation.start-candidates",
      text: HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL,
      values: [
        HNS_ROUTE_REVALIDATION_LEAD_SECONDS,
        HNS_ROUTE_REVALIDATION_BATCH_LIMIT,
        HNS_ROUTE_REVALIDATION_PRINCIPAL_ID,
        options.force?.route_binding_id ?? null,
        options.force?.expected_generation ?? null,
        options.environment,
      ],
      readonly: true,
    });
    for (const row of candidates.rows) {
      const candidate = startCandidate(row);
      if (
        candidate === null ||
        candidate.environment !== options.environment ||
        candidate.provider_configuration.reference !== options.configuration.reference ||
        candidate.provider_configuration.version !== options.configuration.version
      ) {
        continue;
      }
      yield* startHnsRouteRevalidation(
        {
          route_revalidation_id: candidate.route_revalidation_id,
          revalidation_session_id: candidate.revalidation_session_id,
          community_id: candidate.community_id,
          route_binding_id: candidate.route_binding_id,
          expected_binding_generation: candidate.expected_binding_generation,
          expected_verified_evidence_ref: candidate.expected_verified_evidence_ref,
          provider_binding_hash: candidate.provider_binding_hash,
          provider_configuration: candidate.provider_configuration,
          root_label: candidate.root_label,
          root_label_display: candidate.root_label_display,
          path_segment: candidate.path_segment,
        },
        {
          store: startStore,
          provider: options.provider,
          principal_id: HNS_ROUTE_REVALIDATION_PRINCIPAL_ID,
          environment: options.environment,
        },
      );
    }

    const pending = yield* db.execute<Row>({
      label: "jobs.hns-route-revalidation.pending-sessions",
      text: pendingSessionsSql,
      values: [
        HNS_ROUTE_REVALIDATION_PRINCIPAL_ID,
        options.configuration.reference,
        options.configuration.version,
        options.environment,
        HNS_ROUTE_REVALIDATION_BATCH_LIMIT,
      ],
      readonly: true,
    });
    for (const row of pending.rows) {
      const session = pendingSession(row);
      if (session === null || session.consumed_attempts >= 3) continue;
      yield* completeHnsRouteRevalidation(
        {
          route_revalidation_id: session.route_revalidation_id,
          revalidation_session_id: session.revalidation_session_id,
          expected_binding_generation: session.expected_binding_generation,
          idempotency_key: `hns-route-revalidation-poll:${session.consumed_attempts + 1}`,
          channel: "poll_result",
        },
        { store: completionStore, provider: options.provider },
      );
    }
  }).pipe(
    Effect.onInterrupt(() =>
      JobContext.use((context) => Effect.sync(context.adapterSafety.markAbortedOrFenced)),
    ),
  );

  return {
    name: HNS_ROUTE_REVALIDATION_JOB,
    lane: HNS_ROUTE_REVALIDATION_LANE,
    schedule: HNS_ROUTE_REVALIDATION_SCHEDULE,
    timeout: HNS_ROUTE_REVALIDATION_TIMEOUT,
    retry: defaultRetrySchedule,
    expectedFailures: [
      "HnsRouteRevalidationStartRejected",
      "HnsRouteRevalidationStartStorageFailed",
      "HnsRouteRevalidationProviderFailed",
      "HnsRouteRevalidationCompletionRejected",
      "HnsRouteRevalidationCompletionStorageFailed",
    ],
    severity: HNS_ROUTE_REVALIDATION_SEVERITY,
    reads: HNS_ROUTE_REVALIDATION_READS,
    writes: HNS_ROUTE_REVALIDATION_WRITES,
    alertSink: options.sink,
    requiresAdapterSafety: true,
    run,
  };
}
