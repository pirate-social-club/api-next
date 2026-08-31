import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneResult,
  type ControlPlaneTransaction,
} from "@pirate/application";
import {
  type HnsActiveLeaseRenewalAuthorityV1,
  type HnsActiveLeaseRenewalFinalizeOutcome,
  type HnsActiveLeaseRenewalPersistedControlIdentityV1,
  type HnsActiveLeaseRenewalReservation,
  type HnsActiveLeaseRenewalResultV2HashInput,
  HnsActiveLeaseRenewalStorageFailed,
  type HnsActiveLeaseRenewalStore,
  type HnsActiveLeaseRenewalStoredOperation,
  type HnsActiveLeaseRenewalTerminalResult,
  type HnsOwnerActiveLeaseRenewalRequestV1,
  hnsActiveLeaseRenewalRequestHash,
  hnsActiveLeaseRenewalRequirementHash,
  hnsActiveLeaseRenewalTerminalResultHash,
  hnsActiveLeaseRenewalTerminalResultPreimage,
} from "@pirate/application/namespace-ownership";
import { canonicalJson } from "@pirate/domain";
import { Effect, type Layer } from "effect";

type Row = Readonly<Record<string, unknown>>;
type Transaction = ControlPlaneTransaction;

const storageFailure = (): HnsActiveLeaseRenewalStorageFailed =>
  new HnsActiveLeaseRenewalStorageFailed();

function oneRow<RowType>(result: ControlPlaneResult<RowType>): RowType | null | undefined {
  if (result.rows.length > 1) return undefined;
  return result.rows[0] ?? null;
}

function stringValue(row: Row, name: string): string | null {
  return typeof row[name] === "string" ? row[name] : null;
}

function safeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^[0-9]+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function timestampValue(row: Row, name: string): string | null {
  const raw = row[name];
  if (raw instanceof Date && Number.isFinite(raw.getTime())) return raw.toISOString();
  if (typeof raw !== "string" || !Number.isFinite(Date.parse(raw))) return null;
  return new Date(Date.parse(raw)).toISOString();
}

const authoritySelect = `
  SELECT
    c.community_id,
    b.route_binding_id,
    b.binding_generation AS expected_binding_generation,
    b.verified_evidence_ref AS expected_verified_evidence_ref,
    e.evidence_digest AS expected_evidence_digest,
    ci.ownership_source,
    ci.txt_name,
    ci.expected_txt_value_sha256,
    ci.control_identity_digest AS expected_control_identity_digest,
    ci.chain_authority_digest AS expected_chain_authority_digest,
    ci.provider_evidence_ref AS prior_provider_evidence_ref,
    'hns-route-renewal-scheduler'::text AS principal_id,
    e.provider_id,
    e.provider_binding_hash,
    provider.provider_configuration_kind,
    provider.provider_configuration_reference,
    provider.provider_configuration_version,
    COALESCE(
      provider.provider_configuration_digest,
      configuration.provider_configuration_digest
    ) AS provider_configuration_digest,
    provider.environment,
    b.family,
    b.root_label,
    b.root_label_display,
    b.path_segment
  FROM communities AS c
  JOIN community_canonical_route_bindings AS b
    ON b.community_id = c.community_id
   AND b.route_binding_id = c.canonical_route_binding_id
  JOIN community_route_ownership_evidence AS e
    ON e.evidence_ref = b.verified_evidence_ref
  JOIN community_route_hns_control_identities AS ci
    ON ci.evidence_ref = e.evidence_ref
  JOIN LATERAL (
    SELECT s.provider_configuration_kind,
           s.provider_configuration_ref AS provider_configuration_reference,
           s.provider_configuration_version,
           NULL::text AS provider_configuration_digest,
           s.environment
      FROM namespace_ownership_evidence_snapshots AS s
     WHERE s.evidence_ref = e.evidence_ref
    UNION ALL
    SELECT s.provider_configuration_kind,
           s.provider_configuration_reference,
           s.provider_configuration_version,
           s.provider_configuration_digest,
           s.environment
      FROM community_route_revalidation_evidence_snapshots AS s
     WHERE s.evidence_ref = e.evidence_ref
    UNION ALL
    SELECT s.provider_configuration_kind,
           s.provider_configuration_reference,
           s.provider_configuration_version,
           s.provider_configuration_digest,
           s.environment
      FROM community_route_active_lease_renewal_evidence_snapshots AS s
     WHERE s.evidence_ref = e.evidence_ref
    UNION ALL
    SELECT 'managed'::text,
           observer.value ->> 'provider_configuration_reference',
           observer.value ->> 'provider_configuration_version',
           observer.value ->> 'provider_configuration_digest',
           observer.value ->> 'environment'
      FROM hns_operator_control_promotion_receipts AS receipt
      JOIN LATERAL (
        SELECT artifact,
               convert_from(
                 decode(artifact ->> 'bytes_hex', 'hex'),
                 'UTF8'
               )::jsonb AS value
          FROM jsonb_array_elements(
                 convert_from(receipt.candidate_bytes, 'UTF8')::jsonb -> 'artifacts'
               ) AS artifact
         WHERE artifact ->> 'name' = 'observer_evidence'
      ) AS observer ON TRUE
     WHERE receipt.receipt_id = e.operator_control_promotion_receipt_id
       AND receipt.evidence_ref = e.evidence_ref
       AND e.origin = 'operator_control_observation'
       AND receipt.observer_evidence_sha256 = observer.artifact ->> 'sha256'
       AND receipt.observer_evidence_reference = observer.value ->> 'evidence_reference'
       AND e.provider_binding_hash = observer.value ->> 'provider_configuration_digest'
       AND observer.value ->> 'status' = 'verified'
  ) AS provider ON TRUE
  LEFT JOIN hns_control_observer_configurations AS configuration
    ON configuration.provider_configuration_reference = provider.provider_configuration_reference
   AND configuration.provider_configuration_version = provider.provider_configuration_version
   AND (
     provider.provider_configuration_digest IS NULL
     OR configuration.provider_configuration_digest = provider.provider_configuration_digest
   )
 WHERE b.route_binding_id = $1
   AND c.status = 'active'
   AND b.family = 'hns'
   AND (
     provider.provider_configuration_digest IS NOT NULL
     OR configuration.provider_configuration_digest IS NOT NULL
   )
   AND b.ownership_status = 'verified'
   AND b.route_lifecycle_status = 'active'
   AND e.binding_generation = b.binding_generation
   AND e.family = b.family
   AND e.root_label = b.root_label
   AND e.root_label_display = b.root_label_display
   AND e.path_segment = b.path_segment
   AND e.expires_at IS NOT NULL
   AND e.expires_at > clock_timestamp()`;

function authorityFromRow(row: Row): Readonly<{
  readonly authority: HnsActiveLeaseRenewalAuthorityV1;
  readonly control_identity: HnsActiveLeaseRenewalPersistedControlIdentityV1;
}> | null {
  const expectedBindingGeneration = safeInteger(row.expected_binding_generation);
  const authorityFields = [
    "community_id",
    "route_binding_id",
    "expected_verified_evidence_ref",
    "expected_evidence_digest",
    "expected_control_identity_digest",
    "expected_chain_authority_digest",
    "prior_provider_evidence_ref",
    "principal_id",
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
    "ownership_source",
    "txt_name",
    "expected_txt_value_sha256",
  ] as const;
  const nullableValues = Object.fromEntries(
    authorityFields.map((field) => [field, stringValue(row, field)]),
  ) as Record<(typeof authorityFields)[number], string | null>;
  if (
    expectedBindingGeneration === null ||
    Object.values(nullableValues).some((value) => value === null)
  ) {
    return null;
  }
  const values = nullableValues as Record<(typeof authorityFields)[number], string>;
  if (
    values.family !== "hns" ||
    values.provider_id !== "hns.owner.v1" ||
    (values.provider_configuration_kind !== "managed" &&
      values.provider_configuration_kind !== "dynamic") ||
    (values.ownership_source !== "hns_parent_chain_txt" &&
      values.ownership_source !== "owner_authoritative_dns_txt")
  ) {
    return null;
  }
  return {
    authority: {
      community_id: values.community_id,
      route_binding_id: values.route_binding_id,
      expected_binding_generation: expectedBindingGeneration,
      expected_verified_evidence_ref: values.expected_verified_evidence_ref,
      expected_evidence_digest: values.expected_evidence_digest,
      expected_control_identity_digest: values.expected_control_identity_digest,
      expected_chain_authority_digest: values.expected_chain_authority_digest,
      prior_provider_evidence_ref: values.prior_provider_evidence_ref,
      principal_id: values.principal_id,
      provider_id: "hns.owner.v1",
      provider_binding_hash: values.provider_binding_hash,
      provider_configuration: {
        kind: values.provider_configuration_kind,
        reference: values.provider_configuration_reference,
        version: values.provider_configuration_version,
        digest: values.provider_configuration_digest,
      },
      protocol_version: "hns-active-lease-renewal-v1",
      environment: values.environment,
      route: {
        family: "hns",
        root_label: values.root_label,
        root_label_display: values.root_label_display,
        path_segment: values.path_segment,
        href: `/c/${values.path_segment}`,
        app_host: null,
      },
    },
    control_identity: {
      ownership_source: values.ownership_source,
      txt_name: values.txt_name,
      expected_txt_value_sha256: values.expected_txt_value_sha256,
      control_identity_digest: values.expected_control_identity_digest,
      chain_authority_digest: values.expected_chain_authority_digest,
    },
  };
}

function terminalFromRow(row: Row): HnsActiveLeaseRenewalStoredOperation["terminal"] {
  const documentText = stringValue(row, "terminal_result_document");
  const resultHash = stringValue(row, "result_hash");
  if (documentText === null || resultHash === null) return null;
  let values: unknown;
  try {
    values = JSON.parse(documentText) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(values) || values.length !== 13) return null;
  const outcome = values[7];
  if (typeof outcome !== "string") return null;
  const common = {
    active_lease_renewal_id: values[1],
    active_lease_renewal_attempt_id: values[2],
    route_binding_id: values[3],
    expected_binding_generation: values[4],
    idempotency_key: values[5],
    request_hash: values[6],
    outcome_status: outcome,
    evidence_ref_or_null: values[8],
    evidence_digest_or_null: values[9],
    provider_response_sha256_or_null: values[10],
    ownership_status_or_null: values[11],
    route_lifecycle_status_or_null: values[12],
  };
  return {
    result: common as HnsActiveLeaseRenewalTerminalResult,
    result_hash: resultHash,
  };
}

function storedFromRow(row: Row): HnsActiveLeaseRenewalStoredOperation | null {
  const decoded = authorityFromRow(row);
  if (decoded === null) return null;
  return { ...decoded, terminal: terminalFromRow(row) };
}

const storedSelect = `
  SELECT
    r.community_id, r.route_binding_id, r.expected_binding_generation,
    r.expected_verified_evidence_ref, r.expected_evidence_digest,
    r.expected_control_identity_digest, r.expected_chain_authority_digest,
    r.prior_provider_evidence_ref, r.principal_id, r.provider_id,
    r.provider_binding_hash, r.provider_configuration_kind,
    r.provider_configuration_reference, r.provider_configuration_version,
    r.provider_configuration_digest, r.environment, r.family, r.root_label,
    r.root_label_display, r.path_segment, ci.ownership_source, ci.txt_name,
    ci.expected_txt_value_sha256,
    terminal.terminal_result_document, terminal.result_hash
  FROM community_route_active_lease_renewals AS r
  JOIN community_route_hns_control_identities AS ci
    ON ci.evidence_ref = r.expected_verified_evidence_ref
  LEFT JOIN LATERAL (
    SELECT a.terminal_result_document, a.result_hash
      FROM community_route_active_lease_renewal_attempts AS a
     WHERE a.active_lease_renewal_id = r.active_lease_renewal_id
       AND a.state = 'consumed'
     ORDER BY a.terminal_at DESC
     LIMIT 1
  ) AS terminal ON TRUE`;

function loadStored(
  transaction: Transaction,
  renewalId: string,
): Effect.Effect<
  HnsActiveLeaseRenewalStoredOperation | null,
  ControlPlaneError | HnsActiveLeaseRenewalStorageFailed
> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "hns-active-renewal.load-stored",
      text: `${storedSelect} WHERE r.active_lease_renewal_id = $1`,
      values: [renewalId],
      readonly: true,
    });
    const row = oneRow(result);
    if (row === undefined) return yield* Effect.fail(storageFailure());
    return row === null ? null : storedFromRow(row);
  });
}

async function requestFor(
  authority: HnsActiveLeaseRenewalAuthorityV1,
  input: Readonly<{
    readonly renewal_id: string;
    readonly attempt_id: string;
    readonly attempt_number: number;
    readonly evidence_ref: string;
  }>,
): Promise<HnsOwnerActiveLeaseRenewalRequestV1> {
  const requirementHash = await hnsActiveLeaseRenewalRequirementHash(authority);
  const pending: HnsOwnerActiveLeaseRenewalRequestV1 = {
    version: "pirate-hns-active-lease-renewal-request-v1",
    operation_kind: "active_lease_renewal",
    active_lease_renewal_id: input.renewal_id,
    active_lease_renewal_attempt_id: input.attempt_id,
    community_id: authority.community_id,
    route_binding_id: authority.route_binding_id,
    expected_binding_generation: authority.expected_binding_generation,
    expected_verified_evidence_ref: authority.expected_verified_evidence_ref,
    expected_evidence_digest: authority.expected_evidence_digest,
    expected_control_identity_digest: authority.expected_control_identity_digest,
    expected_chain_authority_digest: authority.expected_chain_authority_digest,
    prior_provider_evidence_ref: authority.prior_provider_evidence_ref,
    attempt_number: input.attempt_number,
    evidence_ref: input.evidence_ref,
    requirement_hash: requirementHash,
    request_hash: "0".repeat(64),
    provider_id: authority.provider_id,
    provider_binding_hash: authority.provider_binding_hash,
    provider_configuration: authority.provider_configuration,
    protocol_version: authority.protocol_version,
    environment: authority.environment,
    route: authority.route,
  };
  return { ...pending, request_hash: await hnsActiveLeaseRenewalRequestHash(pending) };
}

function reservationFrom(
  stored: HnsActiveLeaseRenewalStoredOperation,
  request: HnsOwnerActiveLeaseRenewalRequestV1,
  idempotencyKey: string,
  row: Row,
): HnsActiveLeaseRenewalReservation | null {
  const fence = safeInteger(row.fence_token);
  const attemptNumber = safeInteger(row.attempt_number);
  const databaseNow = timestampValue(row, "database_now");
  const leaseExpiresAt = timestampValue(row, "lease_expires_at");
  const observationId = stringValue(row, "observation_id");
  return fence !== null &&
    attemptNumber !== null &&
    databaseNow !== null &&
    leaseExpiresAt !== null &&
    observationId !== null
    ? {
        stored,
        request,
        idempotency_key: idempotencyKey,
        attempt: {
          active_lease_renewal_attempt_id: request.active_lease_renewal_attempt_id,
          evidence_ref: request.evidence_ref,
          observation_id: observationId,
          fence_token: fence,
          attempt_number: attemptNumber,
          database_now: databaseNow,
          lease_expires_at: leaseExpiresAt,
        },
      }
    : null;
}

function makeStore(db: ControlPlaneDb["Service"]): HnsActiveLeaseRenewalStore {
  const resolve: HnsActiveLeaseRenewalStore["resolve"] = (input) =>
    db
      .execute<Row>({
        label: "hns-active-renewal.resolve",
        text: authoritySelect,
        values: [input.route_binding_id],
        readonly: true,
      })
      .pipe(
        Effect.flatMap((result) => {
          const row = oneRow(result);
          return row === undefined
            ? Effect.fail(storageFailure())
            : Effect.succeed(row === null ? null : authorityFromRow(row));
        }),
        Effect.mapError(() => storageFailure()),
      );

  const reserve: HnsActiveLeaseRenewalStore["reserve"] = (input) =>
    db
      .withTransaction((transaction) =>
        Effect.gen(function* () {
          const lockedResult = yield* transaction.execute<Row>({
            label: "hns-active-renewal.reserve-lock-authority",
            text: `${authoritySelect} FOR UPDATE OF c, b`,
            values: [input.expected.authority.route_binding_id],
            readonly: false,
          });
          const lockedRow = oneRow(lockedResult);
          const locked =
            lockedRow === null || lockedRow === undefined ? null : authorityFromRow(lockedRow);
          if (lockedRow === undefined) return yield* Effect.fail(storageFailure());
          if (locked === null) return { kind: "not_found" } as const;
          if (
            canonicalJson(locked.authority) !== canonicalJson(input.expected.authority) ||
            canonicalJson(locked.control_identity) !==
              canonicalJson(input.expected.control_identity)
          ) {
            return { kind: "conflict" } as const;
          }

          const existingResult = yield* transaction.execute<Row>({
            label: "hns-active-renewal.reserve-lock-operation",
            text: `SELECT active_lease_renewal_id, status
                     FROM community_route_active_lease_renewals
                    WHERE route_binding_id = $1 AND expected_binding_generation = $2
                    FOR UPDATE`,
            values: [
              locked.authority.route_binding_id,
              locked.authority.expected_binding_generation,
            ],
            readonly: false,
          });
          const existing = oneRow(existingResult);
          if (existing === undefined) return yield* Effect.fail(storageFailure());
          const renewalId =
            stringValue(existing ?? {}, "active_lease_renewal_id") ?? input.active_lease_renewal_id;
          if (existing === null) {
            const requirementHash = yield* Effect.promise(() =>
              hnsActiveLeaseRenewalRequirementHash(locked.authority),
            );
            const inserted = yield* transaction.execute({
              label: "hns-active-renewal.reserve-insert-operation",
              text: `INSERT INTO community_route_active_lease_renewals (
                       active_lease_renewal_id, community_id, route_binding_id,
                       principal_id, expected_binding_generation,
                       expected_verified_evidence_ref, expected_evidence_digest,
                       expected_control_identity_digest, expected_chain_authority_digest,
                       prior_provider_evidence_ref, requirement_hash, provider_id,
                       provider_binding_hash, provider_configuration_kind,
                       provider_configuration_reference, provider_configuration_version,
                       provider_configuration_digest, environment, root_label,
                       root_label_display, path_segment
                     ) VALUES (
                       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
                     )`,
              values: [
                renewalId,
                locked.authority.community_id,
                locked.authority.route_binding_id,
                locked.authority.principal_id,
                locked.authority.expected_binding_generation,
                locked.authority.expected_verified_evidence_ref,
                locked.authority.expected_evidence_digest,
                locked.authority.expected_control_identity_digest,
                locked.authority.expected_chain_authority_digest,
                locked.authority.prior_provider_evidence_ref,
                requirementHash,
                locked.authority.provider_id,
                locked.authority.provider_binding_hash,
                locked.authority.provider_configuration.kind,
                locked.authority.provider_configuration.reference,
                locked.authority.provider_configuration.version,
                locked.authority.provider_configuration.digest,
                locked.authority.environment,
                locked.authority.route.root_label,
                locked.authority.route.root_label_display,
                locked.authority.route.path_segment,
              ],
              readonly: false,
            });
            if (inserted.rowCount !== 1) return yield* Effect.fail(storageFailure());
          }

          const attemptResult = yield* transaction.execute<Row>({
            label: "hns-active-renewal.reserve-lock-attempt",
            text: `SELECT *, clock_timestamp() AS database_now
                     FROM community_route_active_lease_renewal_attempts
                    WHERE active_lease_renewal_id = $1 AND idempotency_key = $2
                    FOR UPDATE`,
            values: [renewalId, input.idempotency_key],
            readonly: false,
          });
          const existingAttempt = oneRow(attemptResult);
          if (existingAttempt === undefined) return yield* Effect.fail(storageFailure());
          if (existingAttempt !== null) {
            const stored = yield* loadStored(transaction, renewalId);
            if (stored === null) return yield* Effect.fail(storageFailure());
            if (stringValue(existingAttempt, "state") === "consumed") {
              return { kind: "replay", stored } as const;
            }
            const now = timestampValue(existingAttempt, "database_now");
            const lease = timestampValue(existingAttempt, "lease_expires_at");
            if (now === null || lease === null) return yield* Effect.fail(storageFailure());
            if (
              stringValue(existingAttempt, "state") === "leased" &&
              Date.parse(lease) > Date.parse(now)
            ) {
              return {
                kind: "in_flight",
                retry_after_seconds: Math.max(
                  1,
                  Math.ceil((Date.parse(lease) - Date.parse(now)) / 1_000),
                ),
              } as const;
            }
            const attemptNumber = safeInteger(existingAttempt.attempt_number);
            const attemptId = stringValue(existingAttempt, "active_lease_renewal_attempt_id");
            const evidenceRef = stringValue(existingAttempt, "evidence_ref");
            if (attemptNumber === null || attemptId === null || evidenceRef === null) {
              return yield* Effect.fail(storageFailure());
            }
            const request = yield* Effect.promise(() =>
              requestFor(locked.authority, {
                renewal_id: renewalId,
                attempt_id: attemptId,
                attempt_number: attemptNumber,
                evidence_ref: evidenceRef,
              }),
            );
            if (request.request_hash !== stringValue(existingAttempt, "request_hash")) {
              return { kind: "conflict" } as const;
            }
            const reacquiredResult = yield* transaction.execute<Row>({
              label: "hns-active-renewal.reserve-reacquire-attempt",
              text: `UPDATE community_route_active_lease_renewal_attempts
                        SET state = 'leased', fence_token = fence_token + 1,
                            lease_expires_at = clock_timestamp() + ($1 * INTERVAL '1 millisecond')
                      WHERE active_lease_renewal_attempt_id = $2
                        AND (state = 'released' OR lease_expires_at <= clock_timestamp())
                    RETURNING *, lease_expires_at - INTERVAL '16 seconds'
                                  AS database_now`,
              values: [input.lease_ms, attemptId],
              readonly: false,
            });
            const reacquired = oneRow(reacquiredResult);
            if (reacquired === undefined || reacquired === null)
              return { kind: "conflict" } as const;
            const reservation = reservationFrom(stored, request, input.idempotency_key, reacquired);
            return reservation === null
              ? yield* Effect.fail(storageFailure())
              : ({ kind: "acquired", reservation } as const);
          }

          const admissionResult = yield* transaction.execute<Row>({
            label: "hns-active-renewal.reserve-admission",
            text: `SELECT count(*) FILTER (WHERE state = 'consumed')::integer AS consumed_count,
                          min(lease_expires_at) FILTER (
                            WHERE state = 'leased' AND lease_expires_at > clock_timestamp()
                          ) AS live_lease
                     FROM community_route_active_lease_renewal_attempts
                    WHERE active_lease_renewal_id = $1`,
            values: [renewalId],
            readonly: false,
          });
          const admission = oneRow(admissionResult);
          const consumed =
            admission === null || admission === undefined
              ? null
              : safeInteger(admission.consumed_count);
          if (admission === null || admission === undefined || consumed === null)
            return yield* Effect.fail(storageFailure());
          if (consumed >= 3) return { kind: "budget_exhausted" } as const;
          if (timestampValue(admission, "live_lease") !== null)
            return { kind: "conflict" } as const;
          const request = yield* Effect.promise(() =>
            requestFor(locked.authority, {
              renewal_id: renewalId,
              attempt_id: input.active_lease_renewal_attempt_id,
              attempt_number: consumed + 1,
              evidence_ref: input.evidence_ref,
            }),
          );
          const insertedResult = yield* transaction.execute<Row>({
            label: "hns-active-renewal.reserve-insert-attempt",
            text: `INSERT INTO community_route_active_lease_renewal_attempts (
                     active_lease_renewal_attempt_id, active_lease_renewal_id,
                     route_binding_id, expected_binding_generation, attempt_number,
                     idempotency_key, request_hash, evidence_ref, observation_id,
                     lease_expires_at
                   ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
                     clock_timestamp() + ($10 * INTERVAL '1 millisecond'))
                   RETURNING *, lease_expires_at - INTERVAL '16 seconds'
                                 AS database_now`,
            values: [
              input.active_lease_renewal_attempt_id,
              renewalId,
              locked.authority.route_binding_id,
              locked.authority.expected_binding_generation,
              consumed + 1,
              input.idempotency_key,
              request.request_hash,
              input.evidence_ref,
              input.observation_id,
              input.lease_ms,
            ],
            readonly: false,
          });
          const inserted = oneRow(insertedResult);
          if (inserted === undefined || inserted === null)
            return yield* Effect.fail(storageFailure());
          const stored: HnsActiveLeaseRenewalStoredOperation = { ...locked, terminal: null };
          const reservation = reservationFrom(stored, request, input.idempotency_key, inserted);
          return reservation === null
            ? yield* Effect.fail(storageFailure())
            : ({ kind: "acquired", reservation } as const);
        }),
      )
      .pipe(Effect.mapError(() => storageFailure()));

  const release: HnsActiveLeaseRenewalStore["release"] = (reservation) =>
    db
      .execute<Row>({
        label: "hns-active-renewal.release",
        text: `UPDATE community_route_active_lease_renewal_attempts
                  SET state = 'released'
                WHERE active_lease_renewal_attempt_id = $1
                  AND active_lease_renewal_id = $2
                  AND fence_token = $3 AND state = 'leased'
              RETURNING active_lease_renewal_attempt_id`,
        values: [
          reservation.attempt.active_lease_renewal_attempt_id,
          reservation.request.active_lease_renewal_id,
          reservation.attempt.fence_token,
        ],
        readonly: false,
      })
      .pipe(
        Effect.map((result) =>
          result.rowCount === 1
            ? ({ kind: "released" } as const)
            : ({ kind: "lease_lost" } as const),
        ),
        Effect.mapError(() => storageFailure()),
      );

  const finalize: HnsActiveLeaseRenewalStore["finalize"] = (input) =>
    db
      .withTransaction((transaction) => finalizeInTransaction(transaction, input))
      .pipe(Effect.mapError(() => storageFailure()));

  return { resolve, reserve, release, finalize };
}

function replacementResult(
  input: Parameters<HnsActiveLeaseRenewalStore["finalize"]>[0],
  outcome: "lease_expired_before_commit" | "stale_cas",
): HnsActiveLeaseRenewalResultV2HashInput {
  const result = input.result;
  return {
    active_lease_renewal_id: result.active_lease_renewal_id,
    active_lease_renewal_attempt_id: result.active_lease_renewal_attempt_id,
    route_binding_id: result.route_binding_id,
    expected_binding_generation: result.expected_binding_generation,
    idempotency_key: result.idempotency_key,
    request_hash: result.request_hash,
    outcome_status: outcome,
    evidence_ref_or_null: null,
    evidence_digest_or_null: null,
    provider_response_sha256_or_null: result.provider_response_sha256_or_null,
    ownership_status_or_null: null,
    route_lifecycle_status_or_null: null,
  };
}

function finalizeInTransaction(
  transaction: Transaction,
  input: Parameters<HnsActiveLeaseRenewalStore["finalize"]>[0],
): Effect.Effect<
  HnsActiveLeaseRenewalFinalizeOutcome,
  ControlPlaneError | HnsActiveLeaseRenewalStorageFailed
> {
  return Effect.gen(function* () {
    const request = input.reservation.request;
    const lockResult = yield* transaction.execute<Row>({
      label: "hns-active-renewal.finalize-lock",
      text: `SELECT c.status AS community_status, c.canonical_route_binding_id,
                    b.binding_generation, b.verified_evidence_ref,
                    b.ownership_status, b.route_lifecycle_status,
                    e.expires_at AS evidence_expires_at,
                    r.status AS renewal_status,
                    a.state AS attempt_state, a.fence_token, a.lease_expires_at,
                    a.idempotency_key, a.request_hash
               FROM community_route_active_lease_renewals AS r
               JOIN communities AS c ON c.community_id = r.community_id
               JOIN community_canonical_route_bindings AS b
                 ON b.route_binding_id = r.route_binding_id AND b.community_id = r.community_id
               JOIN community_route_ownership_evidence AS e
                 ON e.evidence_ref = r.expected_verified_evidence_ref
               JOIN community_route_active_lease_renewal_attempts AS a
                 ON a.active_lease_renewal_id = r.active_lease_renewal_id
                AND a.active_lease_renewal_attempt_id = $2
              WHERE r.active_lease_renewal_id = $1
              FOR UPDATE OF c, b, r, a`,
      values: [request.active_lease_renewal_id, request.active_lease_renewal_attempt_id],
      readonly: false,
    });
    const locked = oneRow(lockResult);
    if (locked === undefined) return yield* Effect.fail(storageFailure());
    if (locked === null) return { kind: "conflict" } as const;
    if (stringValue(locked, "attempt_state") === "consumed") {
      const stored = yield* loadStored(transaction, request.active_lease_renewal_id);
      return stored === null
        ? ({ kind: "conflict" } as const)
        : ({ kind: "replay", stored } as const);
    }
    if (
      stringValue(locked, "attempt_state") !== "leased" ||
      safeInteger(locked.fence_token) !== input.reservation.attempt.fence_token ||
      stringValue(locked, "idempotency_key") !== input.reservation.idempotency_key ||
      stringValue(locked, "request_hash") !== request.request_hash
    ) {
      return { kind: "lease_lost" } as const;
    }
    const nowResult = yield* transaction.execute<Row>({
      label: "hns-active-renewal.finalize-now",
      text: "SELECT clock_timestamp() AS now",
      values: [],
      readonly: false,
    });
    const nowRow = oneRow(nowResult);
    const now = nowRow === null || nowRow === undefined ? null : timestampValue(nowRow, "now");
    if (now === null) return yield* Effect.fail(storageFailure());
    const stale =
      stringValue(locked, "community_status") !== "active" ||
      stringValue(locked, "canonical_route_binding_id") !== request.route_binding_id ||
      safeInteger(locked.binding_generation) !== request.expected_binding_generation ||
      stringValue(locked, "verified_evidence_ref") !== request.expected_verified_evidence_ref ||
      stringValue(locked, "ownership_status") !== "verified" ||
      stringValue(locked, "route_lifecycle_status") !== "active";
    const evidenceExpiresAt = timestampValue(locked, "evidence_expires_at");
    const expired = evidenceExpiresAt === null || Date.parse(evidenceExpiresAt) <= Date.parse(now);
    const finalResult: HnsActiveLeaseRenewalTerminalResult = stale
      ? replacementResult(input, "stale_cas")
      : expired
        ? replacementResult(input, "lease_expired_before_commit")
        : input.result;
    const resultHash = yield* Effect.promise(() =>
      hnsActiveLeaseRenewalTerminalResultHash(finalResult),
    );
    const resultDocument = hnsActiveLeaseRenewalTerminalResultPreimage(finalResult);
    const mutatesRoute = ![
      "renewal_evidence_ineligible",
      "lease_expired_before_commit",
      "stale_cas",
    ].includes(finalResult.outcome_status);
    if (mutatesRoute) {
      const ownership = finalResult.ownership_status_or_null;
      const lifecycle = finalResult.route_lifecycle_status_or_null;
      const verified = finalResult.outcome_status === "verified";
      const binding = yield* transaction.execute({
        label: "hns-active-renewal.finalize-binding",
        text: `UPDATE community_canonical_route_bindings
                  SET binding_generation = binding_generation + 1,
                      verified_evidence_ref = $1,
                      ownership_status = $2,
                      route_lifecycle_status = $3,
                      updated_at = $4::timestamptz
                WHERE route_binding_id = $5 AND community_id = $6
                  AND binding_generation = $7
                  AND verified_evidence_ref = $8
                  AND ownership_status = 'verified'
                  AND route_lifecycle_status = 'active'`,
        values: [
          verified ? (input.evidence?.evidence_ref ?? null) : null,
          ownership,
          lifecycle,
          now,
          request.route_binding_id,
          request.community_id,
          request.expected_binding_generation,
          request.expected_verified_evidence_ref,
        ],
        readonly: false,
      });
      if (binding.rowCount !== 1) return { kind: "conflict" } as const;
    }
    let responseDocument: unknown = null;
    if (input.provider_response_bytes !== null) {
      try {
        responseDocument = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(input.provider_response_bytes),
        ) as unknown;
      } catch {
        return yield* Effect.fail(storageFailure());
      }
    }
    const responseStatus =
      responseDocument !== null &&
      typeof responseDocument === "object" &&
      !Array.isArray(responseDocument)
        ? stringValue(responseDocument as Row, "status")
        : null;
    const terminalVersion =
      finalResult.outcome_status === "owner_authoritative_source_ineligible"
        ? "pirate-hns-active-lease-renewal-result-v3"
        : "pirate-hns-active-lease-renewal-result-v2";
    const responseVersion =
      finalResult.outcome_status === "owner_authoritative_source_ineligible"
        ? "pirate-hns-active-lease-renewal-response-v2"
        : input.provider_response_bytes === null
          ? null
          : "pirate-hns-active-lease-renewal-response-v1";
    const attempt = yield* transaction.execute({
      label: "hns-active-renewal.finalize-attempt",
      text: `UPDATE community_route_active_lease_renewal_attempts
                SET state = 'consumed', consumption_kind = $1,
                    terminal_result_version = $2, terminal_result_document = $3,
                    result_hash = $4, target_observation_contract_version = $5,
                    target_response_status = $6, provider_response_sha256 = $7,
                    raw_provider_response_bytes = $8, terminal_at = $9::timestamptz
              WHERE active_lease_renewal_attempt_id = $10
                AND fence_token = $11 AND state = 'leased'`,
      values: [
        finalResult.outcome_status,
        terminalVersion,
        resultDocument,
        resultHash,
        responseVersion,
        responseStatus,
        finalResult.provider_response_sha256_or_null,
        input.provider_response_bytes,
        now,
        request.active_lease_renewal_attempt_id,
        input.reservation.attempt.fence_token,
      ],
      readonly: false,
    });
    if (attempt.rowCount !== 1) return { kind: "lease_lost" } as const;
    const operation = yield* transaction.execute({
      label: "hns-active-renewal.finalize-operation",
      text: `UPDATE community_route_active_lease_renewals
                SET status = $1, terminal_at = $2::timestamptz
              WHERE active_lease_renewal_id = $3 AND status = 'pending'`,
      values: [
        finalResult.outcome_status === "verified" ? "completed" : "failed",
        now,
        request.active_lease_renewal_id,
      ],
      readonly: false,
    });
    if (operation.rowCount !== 1) return { kind: "conflict" } as const;

    if (finalResult.outcome_status === "verified") {
      const evidence = input.evidence;
      if (
        evidence === null ||
        finalResult.evidence_ref_or_null !== evidence.evidence_ref ||
        finalResult.evidence_digest_or_null !== evidence.evidence_digest ||
        responseDocument === null
      ) {
        return yield* Effect.fail(storageFailure());
      }
      const snapshot = yield* transaction.execute({
        label: "hns-active-renewal.finalize-snapshot",
        text: `INSERT INTO community_route_active_lease_renewal_evidence_snapshots (
                 evidence_ref, active_lease_renewal_id, active_lease_renewal_attempt_id,
                 community_id, route_binding_id, principal_id, requirement_hash,
                 expected_binding_generation, binding_generation,
                 expected_verified_evidence_ref, expected_evidence_digest,
                 expected_control_identity_digest, expected_chain_authority_digest,
                 prior_provider_evidence_ref, request_hash, provider_id,
                 provider_binding_hash, provider_configuration_kind,
                 provider_configuration_reference, provider_configuration_version,
                 provider_configuration_digest, environment, root_label,
                 root_label_display, path_segment, ownership_source, txt_name,
                 expected_txt_value_sha256, control_identity_digest,
                 chain_authority_digest, root_exists, root_control_verified,
                 expiry_horizon_sufficient, chain_network, chain_anchor_height,
                 chain_anchor_block_hash, chain_anchor_median_time, expiry_height,
                 observed_at, expires_at, provider_evidence_ref,
                 observer_result_sha256, provider_response_sha256, evidence_digest,
                 response_document, raw_response_bytes
               ) VALUES (
                 $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                 $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,TRUE,TRUE,TRUE,$31,
                 $32,$33,$34,$35,$36::timestamptz,$37::timestamptz,$38,$39,$40,$41,
                 $42::jsonb,$43
               )`,
        values: [
          evidence.evidence_ref,
          evidence.active_lease_renewal_id,
          evidence.active_lease_renewal_attempt_id,
          evidence.community_id,
          evidence.route_binding_id,
          evidence.principal_id,
          evidence.requirement_hash,
          evidence.expected_binding_generation,
          evidence.binding_generation,
          evidence.expected_verified_evidence_ref,
          evidence.expected_evidence_digest,
          evidence.expected_control_identity_digest,
          evidence.expected_chain_authority_digest,
          evidence.prior_provider_evidence_ref,
          evidence.request_hash,
          evidence.provider_id,
          evidence.provider_binding_hash,
          evidence.provider_configuration_kind,
          evidence.provider_configuration_reference,
          evidence.provider_configuration_version,
          evidence.provider_configuration_digest,
          evidence.environment,
          evidence.root_label,
          evidence.root_label_display,
          evidence.path_segment,
          evidence.ownership_source,
          evidence.txt_name,
          evidence.expected_txt_value_sha256,
          evidence.control_identity_digest,
          evidence.chain_authority_digest,
          evidence.chain_network,
          evidence.chain_anchor_height,
          evidence.chain_anchor_block_hash,
          evidence.chain_anchor_median_time,
          evidence.expiry_height,
          evidence.observed_at,
          evidence.expires_at,
          evidence.provider_evidence_ref,
          evidence.observer_result_sha256,
          evidence.provider_response_sha256,
          evidence.evidence_digest,
          JSON.stringify(responseDocument),
          input.provider_response_bytes,
        ],
        readonly: false,
      });
      if (snapshot.rowCount !== 1) return yield* Effect.fail(storageFailure());
      const identity = yield* transaction.execute({
        label: "hns-active-renewal.finalize-control-identity",
        text: `INSERT INTO community_route_hns_control_identities (
                 evidence_ref, ownership_source, root_label, txt_name,
                 expected_txt_value_sha256, control_identity_digest,
                 chain_authority_digest, provider_evidence_ref
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        values: [
          evidence.evidence_ref,
          evidence.ownership_source,
          evidence.root_label,
          evidence.txt_name,
          evidence.expected_txt_value_sha256,
          evidence.control_identity_digest,
          evidence.chain_authority_digest,
          evidence.provider_evidence_ref,
        ],
        readonly: false,
      });
      if (identity.rowCount !== 1) return yield* Effect.fail(storageFailure());
      const priorIdentityResult = yield* transaction.execute<Row>({
        label: "hns-active-renewal.finalize-prior-provider-identity",
        text: `SELECT provider_identity_digest
                 FROM community_route_ownership_evidence
                WHERE evidence_ref = $1`,
        values: [request.expected_verified_evidence_ref],
        readonly: true,
      });
      const priorIdentityRow = oneRow(priorIdentityResult);
      const providerIdentity =
        priorIdentityRow === null || priorIdentityRow === undefined
          ? null
          : stringValue(priorIdentityRow, "provider_identity_digest");
      if (providerIdentity === null) return yield* Effect.fail(storageFailure());
      const routeEvidence = yield* transaction.execute({
        label: "hns-active-renewal.finalize-route-evidence",
        text: `INSERT INTO community_route_ownership_evidence (
                 evidence_ref, verified_by_actor_id, family, root_label,
                 root_label_display, path_segment, requirement_hash, provider_id,
                 provider_binding_hash, provider_configuration_version,
                 provider_identity_digest, evidence_digest, binding_generation,
                 verified_at, expires_at, origin, active_lease_renewal_attempt_id
               ) VALUES ($1,NULL,'hns',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
                 $12::timestamptz,$13::timestamptz,'active_lease_renewal',$14)`,
        values: [
          evidence.evidence_ref,
          evidence.root_label,
          evidence.root_label_display,
          evidence.path_segment,
          evidence.requirement_hash,
          evidence.provider_id,
          evidence.provider_binding_hash,
          evidence.provider_configuration_version,
          providerIdentity,
          evidence.evidence_digest,
          evidence.binding_generation,
          evidence.observed_at,
          evidence.expires_at,
          evidence.active_lease_renewal_attempt_id,
        ],
        readonly: false,
      });
      if (routeEvidence.rowCount !== 1) return yield* Effect.fail(storageFailure());
    }
    const stored = yield* loadStored(transaction, request.active_lease_renewal_id);
    if (stored === null || stored.terminal === null) return yield* Effect.fail(storageFailure());
    return { kind: "committed", stored } as const;
  });
}

export function makeControlPlaneHnsActiveLeaseRenewalStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): HnsActiveLeaseRenewalStore {
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.provide(runtime)(effect).pipe(Effect.mapError(() => storageFailure()));
  return {
    resolve: (input) =>
      provide(Effect.flatMap(ControlPlaneDb, (db) => makeStore(db).resolve(input))),
    reserve: (input) =>
      provide(Effect.flatMap(ControlPlaneDb, (db) => makeStore(db).reserve(input))),
    release: (input) =>
      provide(Effect.flatMap(ControlPlaneDb, (db) => makeStore(db).release(input))),
    finalize: (input) =>
      provide(Effect.flatMap(ControlPlaneDb, (db) => makeStore(db).finalize(input))),
  };
}
