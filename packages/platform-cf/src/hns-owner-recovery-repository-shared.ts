import type {
  ControlPlaneError,
  ControlPlaneResult,
  ControlPlaneTransaction,
  HnsOwnerRecoveryAuthorityV1,
  HnsOwnerRecoveryPersistedSessionAuthority,
  HnsOwnerRecoveryPersistedSessionV1,
  HnsOwnerRecoveryStoredPoll,
  HnsOwnerRecoveryTerminalResult,
} from "@pirate/application";
import { Effect, Predicate } from "effect";

export type HnsOwnerRecoveryRow = Readonly<Record<string, unknown>>;
export type HnsOwnerRecoveryExecutor = Pick<ControlPlaneTransaction, "execute">;

export function oneHnsOwnerRecoveryRow<RowType>(
  result: ControlPlaneResult<RowType>,
): RowType | null | undefined {
  if (result.rows.length > 1) return undefined;
  return result.rows[0] ?? null;
}

export function hnsOwnerRecoveryString(row: HnsOwnerRecoveryRow, name: string): string | null {
  return typeof row[name] === "string" ? row[name] : null;
}

export function hnsOwnerRecoveryInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^[0-9]+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

export function hnsOwnerRecoveryTimestamp(row: HnsOwnerRecoveryRow, name: string): string | null {
  const raw = row[name];
  if (raw instanceof Date && Number.isFinite(raw.getTime())) return raw.toISOString();
  if (typeof raw !== "string" || !Number.isFinite(Date.parse(raw))) return null;
  return new Date(Date.parse(raw)).toISOString();
}

function jsonObject(row: HnsOwnerRecoveryRow, name: string): Record<string, unknown> | null {
  const raw = row[name];
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  return Predicate.isObject(value) && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const ownerRecoveryAuthoritySql = `
  WITH current_route AS (
    SELECT c.created_by_user_id AS actor_id, c.community_id,
           b.route_binding_id, b.binding_generation, b.family, b.root_label,
           b.root_label_display, b.path_segment
      FROM communities AS c
      JOIN community_canonical_route_bindings AS b
        ON b.community_id = c.community_id
       AND b.route_binding_id = c.canonical_route_binding_id
     WHERE c.created_by_user_id = $1
       AND c.community_id = $2
       AND c.status = 'active'
       AND b.binding_generation = $3
       AND b.family = 'hns'
       AND b.verified_evidence_ref IS NULL
       AND b.route_lifecycle_status = 'suspended'
  ), prior_snapshot AS (
    SELECT e.evidence_ref, e.provider_id, e.provider_binding_hash,
           source.provider_configuration_kind,
           source.provider_configuration_reference,
           source.provider_configuration_version,
           configuration.provider_configuration_digest,
           source.environment
      FROM community_route_ownership_evidence AS e
      JOIN LATERAL (
        SELECT s.provider_configuration_kind,
               s.provider_configuration_ref AS provider_configuration_reference,
               s.provider_configuration_version, s.environment
          FROM namespace_ownership_evidence_snapshots AS s
         WHERE s.evidence_ref = e.evidence_ref
        UNION ALL
        SELECT s.provider_configuration_kind,
               s.provider_configuration_reference,
               s.provider_configuration_version, s.environment
          FROM community_route_revalidation_evidence_snapshots AS s
         WHERE s.evidence_ref = e.evidence_ref
        UNION ALL
        SELECT s.provider_configuration_kind,
               s.provider_configuration_reference,
               s.provider_configuration_version, s.environment
          FROM community_route_active_lease_renewal_evidence_snapshots AS s
         WHERE s.evidence_ref = e.evidence_ref
      ) AS source ON TRUE
      JOIN hns_control_observer_configurations AS configuration
        ON configuration.provider_configuration_reference =
             source.provider_configuration_reference
       AND configuration.provider_configuration_version =
             source.provider_configuration_version
     WHERE e.family = 'hns'
       AND e.provider_id = 'hns.owner.v1'
       AND e.provider_configuration_version = source.provider_configuration_version
  ), candidates AS (
    SELECT 'database_time_expiry_transition'::text AS recovery_authority_kind,
           transition.route_lifecycle_transition_id AS recovery_authority_reference,
           snapshot.provider_id, snapshot.provider_binding_hash,
           snapshot.provider_configuration_kind,
           snapshot.provider_configuration_reference,
           snapshot.provider_configuration_version,
           snapshot.provider_configuration_digest, snapshot.environment
      FROM current_route AS route
      JOIN community_route_lifecycle_transitions AS transition
        ON transition.community_id = route.community_id
       AND transition.route_binding_id = route.route_binding_id
       AND transition.resulting_binding_generation = route.binding_generation
       AND transition.transition_kind = 'database_time_expired'
       AND transition.family = route.family
       AND transition.root_label = route.root_label
       AND transition.root_label_display = route.root_label_display
       AND transition.path_segment = route.path_segment
      JOIN prior_snapshot AS snapshot
        ON snapshot.evidence_ref = transition.expected_verified_evidence_ref
    UNION ALL
    SELECT CASE session.operation_mode
             WHEN 'same_root_recovery' THEN 'owner_recovery_terminal'
             ELSE 'route_revalidation_terminal'
           END,
           attempt.route_revalidation_attempt_id,
           session.provider_id, session.provider_binding_hash,
           session.provider_configuration_kind,
           session.provider_configuration_reference,
           session.provider_configuration_version,
           CASE session.operation_mode
             WHEN 'same_root_recovery' THEN session.provider_configuration_digest
             ELSE snapshot.provider_configuration_digest
           END,
           session.environment
      FROM current_route AS route
      JOIN community_route_revalidation_completion_attempts AS attempt
        ON attempt.route_binding_id = route.route_binding_id
       AND attempt.expected_binding_generation + 1 = route.binding_generation
       AND attempt.state = 'consumed'
       AND attempt.consumption_kind NOT IN ('challenge_mismatch', 'stale_cas', 'verified')
      JOIN community_route_revalidation_sessions AS session
        ON session.route_revalidation_id = attempt.route_revalidation_id
       AND session.revalidation_session_id = attempt.revalidation_session_id
       AND session.community_id = route.community_id
       AND session.status IN ('failed', 'expired')
       AND session.operation_mode IN ('system_revalidation', 'same_root_recovery')
      LEFT JOIN prior_snapshot AS snapshot
        ON snapshot.evidence_ref = session.expected_verified_evidence_ref
     WHERE (
       session.operation_mode = 'same_root_recovery'
       AND session.provider_configuration_digest IS NOT NULL
     ) OR (
       session.operation_mode = 'system_revalidation'
       AND snapshot.evidence_ref IS NOT NULL
       AND snapshot.provider_id = session.provider_id
       AND snapshot.provider_binding_hash = session.provider_binding_hash
       AND snapshot.provider_configuration_kind = session.provider_configuration_kind
       AND snapshot.provider_configuration_reference = session.provider_configuration_reference
       AND snapshot.provider_configuration_version = session.provider_configuration_version
       AND snapshot.environment = session.environment
     )
    UNION ALL
    SELECT 'active_lease_renewal_terminal',
           attempt.active_lease_renewal_attempt_id,
           renewal.provider_id, renewal.provider_binding_hash,
           renewal.provider_configuration_kind,
           renewal.provider_configuration_reference,
           renewal.provider_configuration_version,
           renewal.provider_configuration_digest, renewal.environment
      FROM current_route AS route
      JOIN community_route_active_lease_renewal_attempts AS attempt
        ON attempt.route_binding_id = route.route_binding_id
       AND attempt.expected_binding_generation + 1 = route.binding_generation
       AND attempt.state = 'consumed'
       AND attempt.consumption_kind NOT IN (
         'verified', 'renewal_evidence_ineligible',
         'lease_expired_before_commit', 'stale_cas'
       )
      JOIN community_route_active_lease_renewals AS renewal
        ON renewal.active_lease_renewal_id = attempt.active_lease_renewal_id
       AND renewal.community_id = route.community_id
  )
  SELECT route.actor_id, route.community_id, route.route_binding_id,
         route.binding_generation AS expected_binding_generation,
         candidate.recovery_authority_kind, candidate.recovery_authority_reference,
         candidate.provider_id, candidate.provider_binding_hash,
         candidate.provider_configuration_kind,
         candidate.provider_configuration_reference,
         candidate.provider_configuration_version,
         candidate.provider_configuration_digest, candidate.environment,
         route.family, route.root_label, route.root_label_display, route.path_segment
    FROM current_route AS route
    JOIN candidates AS candidate ON TRUE
    JOIN hns_control_observer_configurations AS configuration
      ON configuration.provider_configuration_reference =
           candidate.provider_configuration_reference
     AND configuration.provider_configuration_version =
           candidate.provider_configuration_version
     AND configuration.provider_configuration_digest =
           candidate.provider_configuration_digest
   WHERE candidate.provider_id = 'hns.owner.v1'
   LIMIT 2`;

function hnsOwnerRecoveryAuthorityFromRow(
  row: HnsOwnerRecoveryRow,
): HnsOwnerRecoveryAuthorityV1 | null {
  const expectedGeneration = hnsOwnerRecoveryInteger(row.expected_binding_generation);
  const fields = [
    "actor_id",
    "community_id",
    "route_binding_id",
    "recovery_authority_kind",
    "recovery_authority_reference",
    "provider_id",
    "provider_binding_hash",
    "provider_configuration_kind",
    "provider_configuration_reference",
    "provider_configuration_version",
    "provider_configuration_digest",
    "environment",
    "family",
    "root_label",
    "root_label_display",
    "path_segment",
  ] as const;
  const nullable = Object.fromEntries(
    fields.map((field) => [field, hnsOwnerRecoveryString(row, field)]),
  ) as Record<(typeof fields)[number], string | null>;
  if (expectedGeneration === null || Object.values(nullable).some((value) => value === null)) {
    return null;
  }
  const value = nullable as Record<(typeof fields)[number], string>;
  if (
    value.provider_id !== "hns.owner.v1" ||
    value.family !== "hns" ||
    (value.provider_configuration_kind !== "managed" &&
      value.provider_configuration_kind !== "dynamic") ||
    ![
      "database_time_expiry_transition",
      "route_revalidation_terminal",
      "active_lease_renewal_terminal",
      "owner_recovery_terminal",
    ].includes(value.recovery_authority_kind)
  ) {
    return null;
  }
  return {
    actor_id: value.actor_id,
    community_id: value.community_id,
    route_binding_id: value.route_binding_id,
    expected_binding_generation: expectedGeneration,
    recovery_authority_kind:
      value.recovery_authority_kind as HnsOwnerRecoveryAuthorityV1["recovery_authority_kind"],
    recovery_authority_reference: value.recovery_authority_reference,
    provider_id: "hns.owner.v1",
    provider_binding_hash: value.provider_binding_hash,
    provider_configuration: {
      kind: value.provider_configuration_kind,
      reference: value.provider_configuration_reference,
      version: value.provider_configuration_version,
      digest: value.provider_configuration_digest,
    },
    protocol_version: "hns-owner-recovery-v1",
    environment: value.environment,
    route: {
      family: "hns",
      root_label: value.root_label,
      root_label_display: value.root_label_display,
      path_segment: value.path_segment,
      href: `/c/${value.path_segment}`,
      app_host: null,
    },
  };
}

export function queryHnsOwnerRecoveryAuthority(
  executor: HnsOwnerRecoveryExecutor,
  input: Readonly<{
    readonly actor_id: string;
    readonly community_id: string;
    readonly expected_generation: number;
  }>,
): Effect.Effect<HnsOwnerRecoveryAuthorityV1 | null, ControlPlaneError> {
  return executor
    .execute<HnsOwnerRecoveryRow>({
      label: "hns-owner-recovery.resolve-authority",
      text: ownerRecoveryAuthoritySql,
      values: [input.actor_id, input.community_id, input.expected_generation],
      readonly: true,
    })
    .pipe(
      Effect.map((result) =>
        result.rows.length === 1 ? hnsOwnerRecoveryAuthorityFromRow(result.rows[0] ?? {}) : null,
      ),
    );
}

const hnsOwnerRecoveryStoredSelect = `
  SELECT s.route_revalidation_id AS route_recovery_id,
         s.revalidation_session_id AS session_id,
         s.principal_id AS actor_id, s.community_id, s.route_binding_id,
         s.expected_binding_generation, s.recovery_authority_kind,
         s.recovery_authority_reference, s.requirement_hash,
         s.start_idempotency_key, s.public_start_hash, s.provider_start_hash,
         s.provider_id, s.provider_binding_hash, s.provider_configuration_kind,
         s.provider_configuration_reference, s.provider_configuration_version,
         s.provider_configuration_digest, s.protocol_version, s.environment,
         s.family, s.root_label, s.root_label_display, s.path_segment,
         s.upstream_session_ref, s.start_presentation, s.challenge_expires_at,
         s.started_at, s.status AS database_session_status,
         terminal.idempotency_key AS terminal_idempotency_key,
         terminal.completion_request_hash AS terminal_poll_hash,
         terminal.terminal_result_document, terminal.result_hash
    FROM community_route_revalidation_sessions AS s
    LEFT JOIN LATERAL (
      SELECT a.idempotency_key, a.completion_request_hash,
             a.terminal_result_document, a.result_hash
        FROM community_route_revalidation_completion_attempts AS a
       WHERE a.route_revalidation_id = s.route_revalidation_id
         AND a.revalidation_session_id = s.revalidation_session_id
         AND a.operation_mode = 'same_root_recovery'
         AND a.state = 'consumed'
       ORDER BY a.terminal_at DESC
       LIMIT 1
    ) AS terminal ON TRUE`;

function terminalFromRow(
  row: HnsOwnerRecoveryRow,
): HnsOwnerRecoveryStoredPoll["terminal"] | undefined {
  const documentText = hnsOwnerRecoveryString(row, "terminal_result_document");
  const resultHash = hnsOwnerRecoveryString(row, "result_hash");
  const idempotencyKey = hnsOwnerRecoveryString(row, "terminal_idempotency_key");
  const pollHash = hnsOwnerRecoveryString(row, "terminal_poll_hash");
  if (
    documentText === null &&
    resultHash === null &&
    idempotencyKey === null &&
    pollHash === null
  ) {
    return null;
  }
  if (
    documentText === null ||
    resultHash === null ||
    idempotencyKey === null ||
    pollHash === null
  ) {
    return undefined;
  }
  let document: unknown;
  try {
    document = JSON.parse(documentText) as unknown;
  } catch {
    return undefined;
  }
  if (!Array.isArray(document) || document.length !== 14) return undefined;
  const result = {
    route_recovery_id: document[1],
    session_id: document[2],
    recovery_attempt_id: document[3],
    route_binding_id: document[4],
    expected_binding_generation: document[5],
    idempotency_key: document[6],
    poll_hash: document[7],
    outcome_status: document[8],
    evidence_ref_or_null: document[9],
    evidence_digest_or_null: document[10],
    provider_response_sha256_or_null: document[11],
    ownership_status_or_null: document[12],
    route_lifecycle_status_or_null: document[13],
  } as HnsOwnerRecoveryTerminalResult;
  return { idempotency_key: idempotencyKey, poll_hash: pollHash, result_hash: resultHash, result };
}

function hnsOwnerRecoveryStoredFromRow(
  row: HnsOwnerRecoveryRow,
): HnsOwnerRecoveryStoredPoll | null {
  const generation = hnsOwnerRecoveryInteger(row.expected_binding_generation);
  const startedAt = hnsOwnerRecoveryTimestamp(row, "started_at");
  const challengeExpiresAt = hnsOwnerRecoveryTimestamp(row, "challenge_expires_at");
  const presentation = jsonObject(row, "start_presentation");
  const payload =
    presentation !== null && Predicate.isObject(presentation.payload)
      ? (presentation.payload as Record<string, unknown>)
      : null;
  const fields = [
    "route_recovery_id",
    "session_id",
    "actor_id",
    "community_id",
    "route_binding_id",
    "recovery_authority_kind",
    "recovery_authority_reference",
    "requirement_hash",
    "start_idempotency_key",
    "public_start_hash",
    "provider_start_hash",
    "provider_id",
    "provider_binding_hash",
    "provider_configuration_kind",
    "provider_configuration_reference",
    "provider_configuration_version",
    "provider_configuration_digest",
    "protocol_version",
    "environment",
    "family",
    "root_label",
    "root_label_display",
    "path_segment",
    "upstream_session_ref",
  ] as const;
  const nullable = Object.fromEntries(
    fields.map((field) => [field, hnsOwnerRecoveryString(row, field)]),
  ) as Record<(typeof fields)[number], string | null>;
  if (
    generation === null ||
    startedAt === null ||
    challengeExpiresAt === null ||
    presentation === null ||
    payload === null ||
    Object.values(nullable).some((value) => value === null)
  ) {
    return null;
  }
  const value = nullable as Record<(typeof fields)[number], string>;
  const ownershipSource = payload.ownership_source;
  const challengeName = payload.challenge_name;
  const challengeValue = payload.challenge_value;
  if (
    value.provider_id !== "hns.owner.v1" ||
    value.protocol_version !== "hns-owner-recovery-v1" ||
    value.family !== "hns" ||
    (value.provider_configuration_kind !== "managed" &&
      value.provider_configuration_kind !== "dynamic") ||
    (ownershipSource !== "hns_parent_chain_txt" &&
      ownershipSource !== "owner_authoritative_dns_txt") ||
    typeof challengeName !== "string" ||
    typeof challengeValue !== "string" ||
    ![
      "database_time_expiry_transition",
      "route_revalidation_terminal",
      "active_lease_renewal_terminal",
      "owner_recovery_terminal",
    ].includes(value.recovery_authority_kind)
  ) {
    return null;
  }
  const terminal = terminalFromRow(row);
  if (terminal === undefined) return null;
  const session: HnsOwnerRecoveryPersistedSessionV1 = {
    route_recovery_id: value.route_recovery_id,
    session_id: value.session_id,
    operation_mode: "same_root_recovery",
    actor_id: value.actor_id,
    community_id: value.community_id,
    route_binding_id: value.route_binding_id,
    expected_binding_generation: generation,
    recovery_authority_kind:
      value.recovery_authority_kind as HnsOwnerRecoveryPersistedSessionV1["recovery_authority_kind"],
    recovery_authority_reference: value.recovery_authority_reference,
    requirement_hash: value.requirement_hash,
    public_start_hash: value.public_start_hash,
    provider_start_hash: value.provider_start_hash,
    provider_id: "hns.owner.v1",
    provider_binding_hash: value.provider_binding_hash,
    provider_configuration: {
      kind: value.provider_configuration_kind,
      reference: value.provider_configuration_reference,
      version: value.provider_configuration_version,
      digest: value.provider_configuration_digest,
    },
    protocol_version: "hns-owner-recovery-v1",
    environment: value.environment,
    route: {
      family: "hns",
      root_label: value.root_label,
      root_label_display: value.root_label_display,
      path_segment: value.path_segment,
      href: `/c/${value.path_segment}`,
      app_host: null,
    },
    upstream_session_ref: value.upstream_session_ref,
    ownership_source: ownershipSource,
    challenge_name: challengeName,
    challenge_value: challengeValue,
    challenge_expires_at: challengeExpiresAt,
    status: "pending",
    started_at: startedAt,
  };
  const sessionAuthority: HnsOwnerRecoveryPersistedSessionAuthority = {
    expected_route_recovery_id: value.route_recovery_id,
    expected_session_id: value.session_id,
    start_idempotency_key: value.start_idempotency_key,
    expected_public_start_hash: value.public_start_hash,
    expected_upstream_session_ref: value.upstream_session_ref,
    expected_ownership_source: ownershipSource,
    expected_challenge_expires_at: challengeExpiresAt,
  };
  return { session, session_authority: sessionAuthority, terminal };
}

export function loadHnsOwnerRecoveryStored(
  executor: HnsOwnerRecoveryExecutor,
  whereSql: string,
  values: ReadonlyArray<unknown>,
  readonly: boolean,
): Effect.Effect<HnsOwnerRecoveryStoredPoll | null | undefined, ControlPlaneError> {
  return executor
    .execute<HnsOwnerRecoveryRow>({
      label: "hns-owner-recovery.load-stored",
      text: `${hnsOwnerRecoveryStoredSelect} ${whereSql}`,
      values,
      readonly,
    })
    .pipe(
      Effect.map((result) => {
        const row = oneHnsOwnerRecoveryRow(result);
        if (row === undefined) return undefined;
        return row === null ? null : hnsOwnerRecoveryStoredFromRow(row);
      }),
    );
}
