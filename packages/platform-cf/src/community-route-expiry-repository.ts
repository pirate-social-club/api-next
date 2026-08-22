import {
  type CommunityRouteExpiryBatchSummary,
  type CommunityRouteExpiryInput,
  CommunityRouteExpiryStorageFailed,
  type CommunityRouteExpiryStore,
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneResult,
  type ControlPlaneTransaction,
} from "@pirate/application";
import { Data, Effect, type Layer } from "effect";

type Row = Readonly<Record<string, unknown>>;

export class CommunityRouteExpiryStorageInvariant extends Data.TaggedError(
  "CommunityRouteExpiryStorageInvariant",
)<{
  readonly stage: "candidate" | "database-clock" | "transition";
}> {}

type Candidate = Readonly<{
  readonly community_id: string;
  readonly route_binding_id: string;
  readonly family: "hns" | "spaces";
  readonly root_label: string;
  readonly root_label_display: string;
  readonly path_segment: string;
  readonly binding_generation: number;
  readonly verified_evidence_ref: string;
  readonly evidence_expires_at: string;
}>;

const candidateFailure = () => new CommunityRouteExpiryStorageInvariant({ stage: "candidate" });
const clockFailure = () => new CommunityRouteExpiryStorageInvariant({ stage: "database-clock" });
const transitionFailure = () => new CommunityRouteExpiryStorageInvariant({ stage: "transition" });

function oneRow<RowType>(result: ControlPlaneResult<RowType>): RowType | null | undefined {
  if (result.rows.length > 1) return undefined;
  return result.rows[0] ?? null;
}

function stringValue(row: Row, name: string): string | null {
  const value = row[name];
  return typeof value === "string" && value.length > 0 && value === value.trim() ? value : null;
}

function integerValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^[0-9]+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function timestampValue(row: Row, name: string): string | null {
  const raw = row[name];
  const value = raw instanceof Date ? raw.toISOString() : typeof raw === "string" ? raw : null;
  if (value === null || !Number.isFinite(Date.parse(value))) return null;
  return new Date(Date.parse(value)).toISOString();
}

function candidateFromRow(row: Row): Candidate | null {
  const family = stringValue(row, "family");
  const communityId = stringValue(row, "community_id");
  const bindingId = stringValue(row, "route_binding_id");
  const rootLabel = stringValue(row, "root_label");
  const rootLabelDisplay = stringValue(row, "root_label_display");
  const pathSegment = stringValue(row, "path_segment");
  const generation = integerValue(row.binding_generation);
  const evidenceRef = stringValue(row, "verified_evidence_ref");
  const evidenceExpiresAt = timestampValue(row, "evidence_expires_at");
  if (
    communityId === null ||
    bindingId === null ||
    (family !== "hns" && family !== "spaces") ||
    rootLabel === null ||
    rootLabelDisplay === null ||
    pathSegment === null ||
    pathSegment !== (family === "hns" ? `app.${rootLabel}` : `@${rootLabel}`) ||
    generation === null ||
    generation < 1 ||
    evidenceRef === null ||
    evidenceExpiresAt === null
  ) {
    return null;
  }
  return {
    community_id: communityId,
    route_binding_id: bindingId,
    family,
    root_label: rootLabel,
    root_label_display: rootLabelDisplay,
    path_segment: pathSegment,
    binding_generation: generation,
    verified_evidence_ref: evidenceRef,
    evidence_expires_at: evidenceExpiresAt,
  };
}

export const COMMUNITY_ROUTE_EXPIRY_CANDIDATES_SQL = `
  WITH db_clock AS MATERIALIZED (
    SELECT clock_timestamp() AS now
  )
  SELECT c.community_id,
         b.route_binding_id,
         b.family,
         b.root_label,
         b.root_label_display,
         b.path_segment,
         b.binding_generation,
         b.verified_evidence_ref,
         evidence.expires_at AS evidence_expires_at
    FROM db_clock
    JOIN community_route_ownership_evidence AS evidence
      ON evidence.expires_at IS NOT NULL
     AND evidence.expires_at <= db_clock.now
    JOIN community_canonical_route_bindings AS b
      ON b.verified_evidence_ref = evidence.evidence_ref
     AND b.family = evidence.family
     AND b.root_label = evidence.root_label
     AND b.root_label_display = evidence.root_label_display
     AND b.path_segment = evidence.path_segment
     AND b.binding_generation = evidence.binding_generation
     AND b.route_lifecycle_status = 'active'
     AND b.ownership_status = 'verified'
    JOIN communities AS c
      ON c.community_id = b.community_id
     AND c.canonical_route_binding_id = b.route_binding_id
     AND c.status = 'active'
   WHERE b.family = $1
   ORDER BY evidence.expires_at, b.route_binding_id
   LIMIT $2`;

function candidates(
  db: ControlPlaneDb["Service"],
  input: CommunityRouteExpiryInput,
): Effect.Effect<readonly Candidate[], ControlPlaneError | CommunityRouteExpiryStorageInvariant> {
  return Effect.gen(function* () {
    const result = yield* db.execute<Row>({
      label: "community-route.expiry.candidates",
      text: COMMUNITY_ROUTE_EXPIRY_CANDIDATES_SQL,
      values: [input.family, input.limit],
      readonly: true,
    });
    const parsed: Candidate[] = [];
    for (const row of result.rows) {
      const candidate = candidateFromRow(row);
      if (candidate === null || candidate.family !== input.family) {
        return yield* Effect.fail(candidateFailure());
      }
      parsed.push(candidate);
    }
    return parsed;
  });
}

function communityMatches(row: Row, candidate: Candidate): boolean {
  return row.status === "active" && row.canonical_route_binding_id === candidate.route_binding_id;
}

function bindingMatches(row: Row, candidate: Candidate): boolean {
  return (
    row.family === candidate.family &&
    row.root_label === candidate.root_label &&
    row.root_label_display === candidate.root_label_display &&
    row.path_segment === candidate.path_segment &&
    integerValue(row.binding_generation) === candidate.binding_generation &&
    row.verified_evidence_ref === candidate.verified_evidence_ref &&
    row.ownership_status === "verified" &&
    row.route_lifecycle_status === "active" &&
    row.evidence_family === candidate.family &&
    row.evidence_root_label === candidate.root_label &&
    row.evidence_root_label_display === candidate.root_label_display &&
    row.evidence_path_segment === candidate.path_segment &&
    integerValue(row.evidence_binding_generation) === candidate.binding_generation &&
    timestampValue(row, "evidence_expires_at") !== null
  );
}

function preciseDatabaseTimestamp(row: Row, name: string): string | null {
  const value = stringValue(row, name);
  if (
    value === null ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    return null;
  }
  return value;
}

function transitionCandidate(
  transaction: ControlPlaneTransaction,
  candidate: Candidate,
  principalId: string,
  transitionId: string,
): Effect.Effect<
  "transitioned" | "stale",
  ControlPlaneError | CommunityRouteExpiryStorageInvariant
> {
  return Effect.gen(function* () {
    const communityResult = yield* transaction.execute<Row>({
      label: "community-route.expiry.lock-community",
      text: `SELECT status, canonical_route_binding_id
               FROM communities
              WHERE community_id = $1
              FOR UPDATE`,
      values: [candidate.community_id],
      readonly: false,
    });
    const community = oneRow(communityResult);
    if (community === undefined) return yield* Effect.fail(transitionFailure());
    if (community === null || !communityMatches(community, candidate)) return "stale";

    const bindingResult = yield* transaction.execute<Row>({
      label: "community-route.expiry.lock-binding",
      text: `SELECT b.family, b.root_label, b.root_label_display, b.path_segment,
                    b.binding_generation, b.verified_evidence_ref, b.ownership_status,
                    b.route_lifecycle_status,
                    evidence.family AS evidence_family,
                    evidence.root_label AS evidence_root_label,
                    evidence.root_label_display AS evidence_root_label_display,
                    evidence.path_segment AS evidence_path_segment,
                    evidence.binding_generation AS evidence_binding_generation,
                    evidence.expires_at AS evidence_expires_at
               FROM community_canonical_route_bindings AS b
               LEFT JOIN community_route_ownership_evidence AS evidence
                 ON evidence.evidence_ref = b.verified_evidence_ref
              WHERE b.community_id = $1
                AND b.route_binding_id = $2
              FOR UPDATE OF b`,
      values: [candidate.community_id, candidate.route_binding_id],
      readonly: false,
    });
    const binding = oneRow(bindingResult);
    if (binding === undefined) return yield* Effect.fail(transitionFailure());
    if (binding === null) return "stale";
    if (!bindingMatches(binding, candidate)) return "stale";

    // Capture the authority clock only after both rows are locked. Formatting
    // it as text preserves PostgreSQL's microseconds across the Worker roundtrip.
    const clockResult = yield* transaction.execute<Row>({
      label: "community-route.expiry.database-clock",
      text: `SELECT to_char(
               clock_timestamp() AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
             ) AS database_now`,
      values: [],
      readonly: false,
    });
    const clockRow = oneRow(clockResult);
    if (clockRow === undefined || clockRow === null) return yield* Effect.fail(clockFailure());
    const databaseNow = preciseDatabaseTimestamp(clockRow, "database_now");
    if (databaseNow === null) return yield* Effect.fail(clockFailure());

    const updated = yield* transaction.execute<Row>({
      label: "community-route.expiry.suspend-binding",
      text: `UPDATE community_canonical_route_bindings AS binding
                SET verified_evidence_ref = NULL,
                    ownership_status = 'expired',
                    route_lifecycle_status = 'suspended',
                    binding_generation = binding_generation + 1,
                    updated_at = $1::timestamptz
              WHERE binding.community_id = $2
                AND binding.route_binding_id = $3
                AND binding.family = $4
                AND binding.root_label = $5
                AND binding.root_label_display = $6
                AND binding.path_segment = $7
                AND binding.binding_generation = $8
                AND binding.verified_evidence_ref = $9
                AND binding.ownership_status = 'verified'
                AND binding.route_lifecycle_status = 'active'
                AND EXISTS (
                  SELECT 1
                    FROM community_route_ownership_evidence AS evidence
                   WHERE evidence.evidence_ref = $9
                     AND evidence.family = $4
                     AND evidence.root_label = $5
                     AND evidence.root_label_display = $6
                     AND evidence.path_segment = $7
                     AND evidence.binding_generation = $8
                     AND evidence.expires_at IS NOT NULL
                     AND evidence.expires_at <= $1::timestamptz
                )
          RETURNING binding_generation`,
      values: [
        databaseNow,
        candidate.community_id,
        candidate.route_binding_id,
        candidate.family,
        candidate.root_label,
        candidate.root_label_display,
        candidate.path_segment,
        candidate.binding_generation,
        candidate.verified_evidence_ref,
      ],
      readonly: false,
    });
    const updatedRow = oneRow(updated);
    if (updatedRow === undefined) return yield* Effect.fail(transitionFailure());
    if (
      updatedRow === null ||
      integerValue(updatedRow.binding_generation) !== candidate.binding_generation + 1
    ) {
      return "stale";
    }

    const inserted = yield* transaction.execute({
      label: "community-route.expiry.record-transition",
      text: `INSERT INTO community_route_lifecycle_transitions (
               route_lifecycle_transition_id, version, transition_kind,
               community_id, route_binding_id, principal_kind, principal_id,
               family, root_label, root_label_display, path_segment,
               expected_binding_generation, resulting_binding_generation,
               expected_verified_evidence_ref, observed_evidence_expires_at,
               ownership_status, route_lifecycle_status, transitioned_at
             )
             SELECT $1, 'pirate-community-route-lifecycle-transition-v1',
                    'database_time_expired', $2, $3, 'system', $4,
                    $5, $6, $7, $8, $9, $10, $11,
                    evidence.expires_at, 'expired', 'suspended', $12::timestamptz
               FROM community_route_ownership_evidence AS evidence
              WHERE evidence.evidence_ref = $11
                AND evidence.family = $5
                AND evidence.root_label = $6
                AND evidence.root_label_display = $7
                AND evidence.path_segment = $8
                AND evidence.binding_generation = $9
                AND evidence.expires_at IS NOT NULL
                AND evidence.expires_at <= $12::timestamptz`,
      values: [
        transitionId,
        candidate.community_id,
        candidate.route_binding_id,
        principalId,
        candidate.family,
        candidate.root_label,
        candidate.root_label_display,
        candidate.path_segment,
        candidate.binding_generation,
        candidate.binding_generation + 1,
        candidate.verified_evidence_ref,
        databaseNow,
      ],
      readonly: false,
    });
    if (inserted.rowCount !== 1) return yield* Effect.fail(transitionFailure());
    return "transitioned";
  });
}

/**
 * Drains a bounded earliest-expiry batch. Candidate reads are advisory; each
 * mutation repeats the complete database-time fence under community-then-
 * binding locks and records its append-only authority in the same transaction.
 */
function expireCommunityRouteEvidenceWithControlPlane(
  input: CommunityRouteExpiryInput,
): Effect.Effect<
  CommunityRouteExpiryBatchSummary,
  ControlPlaneError | CommunityRouteExpiryStorageInvariant,
  ControlPlaneDb
> {
  return Effect.gen(function* () {
    const db = yield* ControlPlaneDb;
    const selected = yield* candidates(db, input);
    let transitioned = 0;
    let stale = 0;
    for (const candidate of selected) {
      const transitionId = `route_lifecycle_transition_${crypto.randomUUID()}`;
      const outcome = yield* db.withTransaction((transaction) =>
        transitionCandidate(transaction, candidate, input.principal_id, transitionId),
      );
      if (outcome === "transitioned") transitioned += 1;
      else stale += 1;
    }
    return { selected: selected.length, transitioned, stale };
  });
}

export function makeControlPlaneCommunityRouteExpiryStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): CommunityRouteExpiryStore {
  return {
    expire: (input) =>
      expireCommunityRouteEvidenceWithControlPlane(input).pipe(
        Effect.provide(runtime),
        Effect.mapError(() => new CommunityRouteExpiryStorageFailed()),
      ),
  };
}
