import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  type HnsOwnerRecoveryEvidenceEnvelopeV1,
  type HnsOwnerRecoveryPollAttempt,
  HnsOwnerRecoveryPollStorageFailed,
  type HnsOwnerRecoveryPollStore,
  type HnsOwnerRecoveryTerminalResult,
  hnsOwnerRecoveryTerminalResultHash,
  hnsOwnerRecoveryTerminalResultPreimage,
} from "@pirate/application";
import { canonicalJson } from "@pirate/domain";
import { Effect, type Layer, Predicate } from "effect";
import {
  type HnsOwnerRecoveryRow,
  hnsOwnerRecoveryInteger,
  hnsOwnerRecoveryString,
  hnsOwnerRecoveryTimestamp,
  loadHnsOwnerRecoveryStored,
  oneHnsOwnerRecoveryRow,
} from "./hns-owner-recovery-repository-shared.ts";

const storageFailure = (): HnsOwnerRecoveryPollStorageFailed =>
  new HnsOwnerRecoveryPollStorageFailed();

function attemptFromRow(row: HnsOwnerRecoveryRow): HnsOwnerRecoveryPollAttempt | null {
  const attemptId = hnsOwnerRecoveryString(row, "route_revalidation_attempt_id");
  const evidenceRef = hnsOwnerRecoveryString(row, "evidence_ref");
  const observationId = hnsOwnerRecoveryString(row, "observation_id");
  const fence = hnsOwnerRecoveryInteger(row.fence_token);
  const now = hnsOwnerRecoveryTimestamp(row, "database_now");
  const lease = hnsOwnerRecoveryTimestamp(row, "lease_expires_at");
  return attemptId !== null &&
    evidenceRef !== null &&
    observationId !== null &&
    fence !== null &&
    now !== null &&
    lease !== null
    ? {
        recovery_attempt_id: attemptId,
        evidence_ref: evidenceRef,
        observation_id: observationId,
        fence_token: fence,
        database_now: now,
        lease_expires_at: lease,
      }
    : null;
}

function replacementResult(
  input: Parameters<HnsOwnerRecoveryPollStore["finalize"]>[0],
  outcome: "session_expired" | "stale_cas",
): HnsOwnerRecoveryTerminalResult {
  const session = input.expected.session;
  return {
    route_recovery_id: session.route_recovery_id,
    session_id: session.session_id,
    recovery_attempt_id: input.attempt.recovery_attempt_id,
    route_binding_id: session.route_binding_id,
    expected_binding_generation: session.expected_binding_generation,
    idempotency_key: input.request.idempotency_key,
    poll_hash: input.poll_hash as HnsOwnerRecoveryTerminalResult["poll_hash"],
    outcome_status: outcome,
    evidence_ref_or_null: null,
    evidence_digest_or_null: null,
    provider_response_sha256_or_null: null,
    ownership_status_or_null: outcome === "session_expired" ? "expired" : null,
    route_lifecycle_status_or_null: outcome === "session_expired" ? "suspended" : null,
  };
}

function terminalVersion(result: HnsOwnerRecoveryTerminalResult): string {
  return result.outcome_status === "owner_authoritative_source_ineligible"
    ? "pirate-hns-owner-recovery-result-v2"
    : "pirate-hns-owner-recovery-result-v1";
}

function terminalSessionStatus(result: HnsOwnerRecoveryTerminalResult): string {
  return result.outcome_status === "verified"
    ? "completed"
    : result.outcome_status === "session_expired"
      ? "expired"
      : "failed";
}

function rawResponseMetadata(bytes: Uint8Array | null): Readonly<{
  version: "pirate-hns-target-observation-v2" | "pirate-hns-target-observation-v3";
  status: "verified" | "rejected" | "ineligible";
  document: Record<string, unknown>;
}> | null {
  if (bytes === null) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return null;
  }
  if (!Predicate.isObject(decoded) || Array.isArray(decoded)) return null;
  const document = decoded as Record<string, unknown>;
  const version = document.observation_contract_version;
  const status = document.status;
  return (version === "pirate-hns-target-observation-v2" ||
    version === "pirate-hns-target-observation-v3") &&
    (status === "verified" || status === "rejected" || status === "ineligible")
    ? { version, status, document }
    : null;
}

function makePollStore(db: ControlPlaneDb["Service"]): HnsOwnerRecoveryPollStore {
  const load: HnsOwnerRecoveryPollStore["load"] = (input) =>
    loadHnsOwnerRecoveryStored(
      db,
      `WHERE s.route_revalidation_id = $1
         AND s.revalidation_session_id = $2
         AND s.principal_id = $3 AND s.community_id = $4
         AND s.operation_mode = 'same_root_recovery'`,
      [input.route_recovery_id, input.session_id, input.actor_id, input.community_id],
      true,
    ).pipe(
      Effect.flatMap((stored) =>
        stored === undefined ? Effect.fail(storageFailure()) : Effect.succeed(stored),
      ),
      Effect.mapError(() => storageFailure()),
    );

  const reserve: HnsOwnerRecoveryPollStore["reserve"] = (input) =>
    db
      .withTransaction((transaction) =>
        Effect.gen(function* () {
          const session = input.expected.session;
          const lockedRoute = yield* transaction.execute<HnsOwnerRecoveryRow>({
            label: "hns-owner-recovery.poll-lock-route",
            text: `SELECT c.community_id, c.created_by_user_id, b.*
                     FROM communities AS c
                     JOIN community_canonical_route_bindings AS b
                       ON b.community_id = c.community_id
                      AND b.route_binding_id = c.canonical_route_binding_id
                    WHERE c.community_id = $1 AND c.created_by_user_id = $2
                      AND b.route_binding_id = $3
                    FOR UPDATE OF c, b`,
            values: [session.community_id, session.actor_id, session.route_binding_id],
            readonly: false,
          });
          const route = oneHnsOwnerRecoveryRow(lockedRoute);
          if (route === undefined) return yield* Effect.fail(storageFailure());
          if (route === null) return { kind: "not_found" } as const;
          const lockedStored = yield* loadHnsOwnerRecoveryStored(
            transaction,
            `WHERE s.route_revalidation_id = $1
               AND s.revalidation_session_id = $2
               AND s.principal_id = $3 AND s.community_id = $4
               AND s.operation_mode = 'same_root_recovery'
             FOR UPDATE OF s`,
            [
              input.request.route_recovery_id,
              input.request.session_id,
              input.request.actor_id,
              input.request.community_id,
            ],
            false,
          );
          if (lockedStored === undefined) return yield* Effect.fail(storageFailure());
          if (lockedStored === null) return { kind: "not_found" } as const;
          if (lockedStored.terminal !== null)
            return { kind: "replay", stored: lockedStored } as const;
          if (canonicalJson(lockedStored) !== canonicalJson(input.expected)) {
            return { kind: "conflict" } as const;
          }

          const existingResult = yield* transaction.execute<HnsOwnerRecoveryRow>({
            label: "hns-owner-recovery.poll-lock-attempt",
            text: `SELECT *, clock_timestamp() AS database_now
                     FROM community_route_revalidation_completion_attempts
                    WHERE route_revalidation_id = $1 AND idempotency_key = $2
                      AND operation_mode = 'same_root_recovery'
                    FOR UPDATE`,
            values: [session.route_recovery_id, input.request.idempotency_key],
            readonly: false,
          });
          const existing = oneHnsOwnerRecoveryRow(existingResult);
          if (existing === undefined) return yield* Effect.fail(storageFailure());
          if (existing !== null) {
            if (
              hnsOwnerRecoveryString(existing, "completion_request_hash") !== input.poll_hash ||
              hnsOwnerRecoveryString(existing, "revalidation_session_id") !== session.session_id ||
              hnsOwnerRecoveryString(existing, "route_binding_id") !== session.route_binding_id
            ) {
              return { kind: "conflict" } as const;
            }
            if (hnsOwnerRecoveryString(existing, "state") === "consumed") {
              const stored = yield* loadHnsOwnerRecoveryStored(
                transaction,
                `WHERE s.route_revalidation_id = $1 AND s.revalidation_session_id = $2
                   AND s.operation_mode = 'same_root_recovery'`,
                [session.route_recovery_id, session.session_id],
                false,
              );
              return stored === null || stored === undefined
                ? yield* Effect.fail(storageFailure())
                : ({ kind: "replay", stored } as const);
            }
            const lease = hnsOwnerRecoveryTimestamp(existing, "lease_expires_at");
            const now = hnsOwnerRecoveryTimestamp(existing, "database_now");
            if (
              hnsOwnerRecoveryString(existing, "state") === "leased" &&
              lease !== null &&
              now !== null &&
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
            const attemptId = hnsOwnerRecoveryString(existing, "route_revalidation_attempt_id");
            if (attemptId === null) return yield* Effect.fail(storageFailure());
            const reacquiredResult = yield* transaction.execute<HnsOwnerRecoveryRow>({
              label: "hns-owner-recovery.poll-reacquire-attempt",
              text: `UPDATE community_route_revalidation_completion_attempts
                        SET state = 'leased', fence_token = fence_token + 1,
                            lease_expires_at = clock_timestamp() + ($1 * INTERVAL '1 millisecond')
                      WHERE route_revalidation_attempt_id = $2
                        AND (state = 'released' OR lease_expires_at <= clock_timestamp())
                    RETURNING *, lease_expires_at - INTERVAL '16 seconds'
                                  AS database_now`,
              values: [input.lease_ms, attemptId],
              readonly: false,
            });
            const reacquired = oneHnsOwnerRecoveryRow(reacquiredResult);
            const attempt =
              reacquired === null || reacquired === undefined ? null : attemptFromRow(reacquired);
            return attempt === null
              ? ({ kind: "conflict" } as const)
              : ({ kind: "acquired", attempt, stored: lockedStored } as const);
          }

          const admissionResult = yield* transaction.execute<HnsOwnerRecoveryRow>({
            label: "hns-owner-recovery.poll-admission",
            text: `SELECT count(*) FILTER (WHERE state = 'consumed')::integer AS consumed_count,
                          min(lease_expires_at) FILTER (
                            WHERE state = 'leased' AND lease_expires_at > clock_timestamp()
                          ) AS live_lease
                     FROM community_route_revalidation_completion_attempts
                    WHERE route_revalidation_id = $1
                      AND operation_mode = 'same_root_recovery'`,
            values: [session.route_recovery_id],
            readonly: false,
          });
          const admission = oneHnsOwnerRecoveryRow(admissionResult);
          const consumed =
            admission === null || admission === undefined
              ? null
              : hnsOwnerRecoveryInteger(admission.consumed_count);
          if (admission === null || admission === undefined || consumed === null) {
            return yield* Effect.fail(storageFailure());
          }
          if (consumed >= 3) return { kind: "budget_exhausted" } as const;
          if (hnsOwnerRecoveryTimestamp(admission, "live_lease") !== null) {
            return { kind: "conflict" } as const;
          }
          const insertedResult = yield* transaction.execute<HnsOwnerRecoveryRow>({
            label: "hns-owner-recovery.poll-insert-attempt",
            text: `INSERT INTO community_route_revalidation_completion_attempts (
                     route_revalidation_attempt_id, route_revalidation_id,
                     revalidation_session_id, route_binding_id,
                     expected_binding_generation, expected_verified_evidence_ref,
                     attempt_number, idempotency_key, completion_request_hash,
                     evidence_ref, lease_expires_at, operation_mode, observation_id
                   ) VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,
                     clock_timestamp() + ($10 * INTERVAL '1 millisecond'),
                     'same_root_recovery',$11)
                   RETURNING *, lease_expires_at - INTERVAL '16 seconds'
                                 AS database_now`,
            values: [
              input.recovery_attempt_id,
              session.route_recovery_id,
              session.session_id,
              session.route_binding_id,
              session.expected_binding_generation,
              consumed + 1,
              input.request.idempotency_key,
              input.poll_hash,
              input.evidence_ref,
              input.lease_ms,
              input.observation_id,
            ],
            readonly: false,
          });
          const inserted = oneHnsOwnerRecoveryRow(insertedResult);
          const attempt =
            inserted === null || inserted === undefined ? null : attemptFromRow(inserted);
          return attempt === null
            ? yield* Effect.fail(storageFailure())
            : ({ kind: "acquired", attempt, stored: lockedStored } as const);
        }),
      )
      .pipe(Effect.mapError(() => storageFailure()));

  const release: HnsOwnerRecoveryPollStore["release"] = (input) =>
    db
      .withTransaction((transaction) =>
        Effect.gen(function* () {
          const released = yield* transaction.execute({
            label: "hns-owner-recovery.poll-release",
            text: `UPDATE community_route_revalidation_completion_attempts
                      SET state = 'released'
                    WHERE route_revalidation_attempt_id = $1
                      AND route_revalidation_id = $2 AND revalidation_session_id = $3
                      AND idempotency_key = $4 AND completion_request_hash = $5
                      AND fence_token = $6 AND state = 'leased'
                    RETURNING route_revalidation_attempt_id`,
            values: [
              input.attempt.recovery_attempt_id,
              input.request.route_recovery_id,
              input.request.session_id,
              input.request.idempotency_key,
              input.poll_hash,
              input.attempt.fence_token,
            ],
            readonly: false,
          });
          if (released.rowCount === 1) return { kind: "released" } as const;
          const stored = yield* loadHnsOwnerRecoveryStored(
            transaction,
            `WHERE s.route_revalidation_id = $1 AND s.revalidation_session_id = $2
               AND s.operation_mode = 'same_root_recovery'`,
            [input.request.route_recovery_id, input.request.session_id],
            false,
          );
          if (stored !== null && stored !== undefined && stored.terminal !== null) {
            return { kind: "replay", stored } as const;
          }
          const attemptResult = yield* transaction.execute<HnsOwnerRecoveryRow>({
            label: "hns-owner-recovery.poll-release-inspect",
            text: `SELECT route_revalidation_id, revalidation_session_id,
                          idempotency_key, completion_request_hash
                     FROM community_route_revalidation_completion_attempts
                    WHERE route_revalidation_attempt_id = $1`,
            values: [input.attempt.recovery_attempt_id],
            readonly: true,
          });
          const row = oneHnsOwnerRecoveryRow(attemptResult);
          return row !== null &&
            row !== undefined &&
            hnsOwnerRecoveryString(row, "route_revalidation_id") ===
              input.request.route_recovery_id &&
            hnsOwnerRecoveryString(row, "revalidation_session_id") === input.request.session_id &&
            hnsOwnerRecoveryString(row, "idempotency_key") === input.request.idempotency_key &&
            hnsOwnerRecoveryString(row, "completion_request_hash") === input.poll_hash
            ? ({ kind: "lease_lost" } as const)
            : ({ kind: "conflict" } as const);
        }),
      )
      .pipe(Effect.mapError(() => storageFailure()));

  const finalize: HnsOwnerRecoveryPollStore["finalize"] = (input) =>
    db
      .withTransaction((transaction) =>
        Effect.gen(function* () {
          const session = input.expected.session;
          const lockedRouteResult = yield* transaction.execute<HnsOwnerRecoveryRow>({
            label: "hns-owner-recovery.poll-finalize-lock-route",
            text: `SELECT c.created_by_user_id, c.status AS community_status, b.*,
                          clock_timestamp() AS database_now
                     FROM communities AS c
                     JOIN community_canonical_route_bindings AS b
                       ON b.community_id = c.community_id
                      AND b.route_binding_id = c.canonical_route_binding_id
                    WHERE c.community_id = $1 AND b.route_binding_id = $2
                    FOR UPDATE OF c, b`,
            values: [session.community_id, session.route_binding_id],
            readonly: false,
          });
          const route = oneHnsOwnerRecoveryRow(lockedRouteResult);
          if (route === undefined) return yield* Effect.fail(storageFailure());
          if (route === null) return { kind: "conflict" } as const;

          const lockedStored = yield* loadHnsOwnerRecoveryStored(
            transaction,
            `WHERE s.route_revalidation_id = $1 AND s.revalidation_session_id = $2
               AND s.operation_mode = 'same_root_recovery'
             FOR UPDATE OF s`,
            [session.route_recovery_id, session.session_id],
            false,
          );
          if (lockedStored === undefined) return yield* Effect.fail(storageFailure());
          if (lockedStored === null) return { kind: "conflict" } as const;
          if (lockedStored.terminal !== null)
            return { kind: "replay", stored: lockedStored } as const;
          if (canonicalJson(lockedStored) !== canonicalJson(input.expected)) {
            return { kind: "conflict" } as const;
          }
          const attemptResult = yield* transaction.execute<HnsOwnerRecoveryRow>({
            label: "hns-owner-recovery.poll-finalize-lock-attempt",
            text: `SELECT *, clock_timestamp() AS database_now
                     FROM community_route_revalidation_completion_attempts
                    WHERE route_revalidation_attempt_id = $1
                    FOR UPDATE`,
            values: [input.attempt.recovery_attempt_id],
            readonly: false,
          });
          const attemptRow = oneHnsOwnerRecoveryRow(attemptResult);
          if (attemptRow === undefined) return yield* Effect.fail(storageFailure());
          if (attemptRow === null) return { kind: "conflict" } as const;
          if (hnsOwnerRecoveryString(attemptRow, "state") === "consumed") {
            const stored = yield* loadHnsOwnerRecoveryStored(
              transaction,
              `WHERE s.route_revalidation_id = $1 AND s.revalidation_session_id = $2
                 AND s.operation_mode = 'same_root_recovery'`,
              [session.route_recovery_id, session.session_id],
              false,
            );
            return stored === null || stored === undefined
              ? yield* Effect.fail(storageFailure())
              : ({ kind: "replay", stored } as const);
          }
          const fence = hnsOwnerRecoveryInteger(attemptRow.fence_token);
          const lease = hnsOwnerRecoveryTimestamp(attemptRow, "lease_expires_at");
          const now = hnsOwnerRecoveryTimestamp(attemptRow, "database_now");
          if (
            hnsOwnerRecoveryString(attemptRow, "state") !== "leased" ||
            fence !== input.attempt.fence_token ||
            lease === null ||
            now === null ||
            Date.parse(lease) <= Date.parse(now) ||
            hnsOwnerRecoveryString(attemptRow, "route_revalidation_id") !==
              session.route_recovery_id ||
            hnsOwnerRecoveryString(attemptRow, "revalidation_session_id") !== session.session_id ||
            hnsOwnerRecoveryString(attemptRow, "idempotency_key") !==
              input.request.idempotency_key ||
            hnsOwnerRecoveryString(attemptRow, "completion_request_hash") !== input.poll_hash
          ) {
            return { kind: "lease_lost" } as const;
          }

          const sessionExpired = Date.parse(session.challenge_expires_at) <= Date.parse(now);
          const routeMatches =
            hnsOwnerRecoveryString(route, "created_by_user_id") === session.actor_id &&
            hnsOwnerRecoveryString(route, "community_status") === "active" &&
            hnsOwnerRecoveryInteger(route.binding_generation) ===
              session.expected_binding_generation &&
            route.verified_evidence_ref === null &&
            hnsOwnerRecoveryString(route, "route_lifecycle_status") === "suspended" &&
            hnsOwnerRecoveryString(route, "family") === "hns" &&
            hnsOwnerRecoveryString(route, "root_label") === session.route.root_label &&
            hnsOwnerRecoveryString(route, "root_label_display") ===
              session.route.root_label_display &&
            hnsOwnerRecoveryString(route, "path_segment") === session.route.path_segment;
          const effectiveResult = !routeMatches
            ? replacementResult(input, "stale_cas")
            : sessionExpired
              ? replacementResult(input, "session_expired")
              : input.result;
          if (input.result.outcome_status === "session_expired" && !sessionExpired) {
            return { kind: "conflict" } as const;
          }
          const keepsProviderResult =
            canonicalJson(effectiveResult) === canonicalJson(input.result);
          const retainedBytes = keepsProviderResult ? input.provider_response_bytes : null;
          const responseMetadata = rawResponseMetadata(retainedBytes);
          const providerHash = keepsProviderResult
            ? effectiveResult.provider_response_sha256_or_null
            : null;
          if (
            (providerHash === null) !== (retainedBytes === null) ||
            (providerHash !== null && responseMetadata === null)
          ) {
            return { kind: "conflict" } as const;
          }
          const terminalDocument = hnsOwnerRecoveryTerminalResultPreimage(effectiveResult);
          const resultHash = yield* Effect.promise(() =>
            hnsOwnerRecoveryTerminalResultHash(effectiveResult),
          );

          const consumed = yield* transaction.execute({
            label: "hns-owner-recovery.poll-finalize-attempt",
            text: `UPDATE community_route_revalidation_completion_attempts
                      SET state = 'consumed', consumption_kind = $1,
                          terminal_result_version = $2,
                          terminal_result_document = $3, result_hash = $4,
                          target_observation_contract_version = $5,
                          target_response_status = $6,
                          provider_response_sha256 = $7,
                          raw_provider_response_bytes = $8,
                          terminal_at = date_trunc('milliseconds', clock_timestamp())
                    WHERE route_revalidation_attempt_id = $9
                      AND state = 'leased' AND fence_token = $10
                      AND lease_expires_at > clock_timestamp()`,
            values: [
              effectiveResult.outcome_status,
              terminalVersion(effectiveResult),
              terminalDocument,
              resultHash,
              responseMetadata?.version ?? null,
              responseMetadata?.status ?? null,
              providerHash,
              retainedBytes,
              input.attempt.recovery_attempt_id,
              input.attempt.fence_token,
            ],
            readonly: false,
          });
          if (consumed.rowCount !== 1) return { kind: "lease_lost" } as const;

          if (effectiveResult.outcome_status !== "stale_cas") {
            const updatedBinding = yield* transaction.execute({
              label: "hns-owner-recovery.poll-finalize-binding",
              text: `UPDATE community_canonical_route_bindings
                        SET binding_generation = binding_generation + 1,
                            verified_evidence_ref = $1,
                            ownership_status = $2,
                            route_lifecycle_status = $3,
                            updated_at = clock_timestamp()
                      WHERE route_binding_id = $4 AND community_id = $5
                        AND binding_generation = $6
                        AND verified_evidence_ref IS NULL
                        AND route_lifecycle_status = 'suspended'`,
              values: [
                effectiveResult.evidence_ref_or_null,
                effectiveResult.ownership_status_or_null,
                effectiveResult.route_lifecycle_status_or_null,
                session.route_binding_id,
                session.community_id,
                session.expected_binding_generation,
              ],
              readonly: false,
            });
            if (updatedBinding.rowCount !== 1) return { kind: "conflict" } as const;
          }

          const sessionTerminal = yield* transaction.execute({
            label: "hns-owner-recovery.poll-finalize-session",
            text: `UPDATE community_route_revalidation_sessions
                      SET status = $1, terminal_at = clock_timestamp()
                    WHERE route_revalidation_id = $2 AND revalidation_session_id = $3
                      AND operation_mode = 'same_root_recovery' AND status = 'pending'`,
            values: [
              terminalSessionStatus(effectiveResult),
              session.route_recovery_id,
              session.session_id,
            ],
            readonly: false,
          });
          if (sessionTerminal.rowCount !== 1) return { kind: "conflict" } as const;

          if (effectiveResult.outcome_status === "verified") {
            const evidence = input.evidence;
            if (
              evidence === null ||
              responseMetadata === null ||
              responseMetadata.status !== "verified" ||
              evidence.evidence_ref !== effectiveResult.evidence_ref_or_null ||
              evidence.evidence_digest !== effectiveResult.evidence_digest_or_null ||
              evidence.provider_response_sha256 !== providerHash
            ) {
              return yield* Effect.fail(storageFailure());
            }
            yield* insertVerifiedEvidence(
              transaction,
              evidence,
              responseMetadata,
              retainedBytes,
              input.attempt.fence_token,
            );
          } else if (input.evidence !== null && keepsProviderResult) {
            return yield* Effect.fail(storageFailure());
          }

          const stored = yield* loadHnsOwnerRecoveryStored(
            transaction,
            `WHERE s.route_revalidation_id = $1 AND s.revalidation_session_id = $2
               AND s.operation_mode = 'same_root_recovery'`,
            [session.route_recovery_id, session.session_id],
            false,
          );
          if (stored === null || stored === undefined || stored.terminal === null) {
            return yield* Effect.fail(storageFailure());
          }
          return { kind: "committed", stored } as const;
        }),
      )
      .pipe(Effect.mapError(() => storageFailure()));

  return { load, reserve, release, finalize };
}

function insertVerifiedEvidence(
  transaction: ControlPlaneTransaction,
  evidence: HnsOwnerRecoveryEvidenceEnvelopeV1,
  metadata: NonNullable<ReturnType<typeof rawResponseMetadata>>,
  bytes: Uint8Array | null,
  fenceToken: number,
): Effect.Effect<void, ControlPlaneError | HnsOwnerRecoveryPollStorageFailed> {
  return Effect.gen(function* () {
    if (bytes === null) return yield* Effect.fail(storageFailure());
    const controlIdentity = metadata.document.control_identity_digest;
    const chainAuthority = metadata.document.chain_authority_digest;
    if (typeof controlIdentity !== "string" || typeof chainAuthority !== "string") {
      return yield* Effect.fail(storageFailure());
    }
    const snapshot = yield* transaction.execute({
      label: "hns-owner-recovery.poll-insert-snapshot",
      text: `INSERT INTO community_route_revalidation_evidence_snapshots (
               evidence_ref, route_revalidation_attempt_id, route_revalidation_id,
               revalidation_session_id, community_id, route_binding_id,
               principal_kind, principal_id, requirement_hash,
               expected_binding_generation, binding_generation,
               expected_verified_evidence_ref, start_request_hash, provider_id,
               provider_binding_hash, provider_configuration_kind,
               provider_configuration_reference, provider_configuration_version,
               protocol_version, environment, family, root_label,
               root_label_display, path_segment, upstream_session_ref,
               fence_token, abi_version, ownership_source, challenge_name,
               challenge_value_sha256, root_exists, root_control_verified,
               expiry_horizon_sufficient, chain_network, chain_anchor_height,
               chain_anchor_block_hash, chain_anchor_median_time, expiry_height,
               observed_at, expires_at, provider_evidence_ref, observation_sha256,
               provider_identity_digest, evidence_digest, observation,
               raw_response_bytes, operation_mode, recovery_authority_kind,
               recovery_authority_reference, public_start_hash,
               provider_start_hash, poll_hash, provider_configuration_digest,
               challenge_expires_at, observation_contract_version
             ) VALUES (
               $1,$2,$3,$4,$5,$6,'user',$7,$8,$9,$10,NULL,$11,$12,$13,$14,$15,$16,
               'hns-owner-recovery-v1',$17,'hns',$18,$19,$20,$21,$22,
               'pirate-hns-owner-recovery-evidence-v1',$23,$24,$25,true,true,true,
               $26,$27,$28,$29,$30,$31::timestamptz,$32::timestamptz,$33,$34,$35,$36,
               $37::jsonb,$38,'same_root_recovery',$39,$40,$41,$42,$43,$44,$45::timestamptz,$46
             )`,
      values: [
        evidence.evidence_ref,
        evidence.recovery_attempt_id,
        evidence.route_recovery_id,
        evidence.session_id,
        evidence.community_id,
        evidence.route_binding_id,
        evidence.actor_id,
        evidence.requirement_hash,
        evidence.expected_binding_generation,
        evidence.binding_generation,
        evidence.public_start_hash,
        evidence.provider_id,
        evidence.provider_binding_hash,
        evidence.provider_configuration_kind,
        evidence.provider_configuration_reference,
        evidence.provider_configuration_version,
        evidence.environment,
        evidence.root_label,
        evidence.root_label_display,
        evidence.path_segment,
        metadata.document.upstream_session_ref,
        fenceToken,
        evidence.ownership_source,
        evidence.challenge_name,
        evidence.challenge_value_sha256,
        evidence.chain_network,
        evidence.chain_anchor_height,
        evidence.chain_anchor_block_hash,
        evidence.chain_anchor_median_time,
        evidence.expiry_height,
        evidence.observed_at,
        evidence.expires_at,
        evidence.provider_evidence_ref,
        evidence.provider_response_sha256,
        evidence.provider_identity_digest,
        evidence.evidence_digest,
        JSON.stringify(metadata.document),
        bytes,
        evidence.recovery_authority_kind,
        evidence.recovery_authority_reference,
        evidence.public_start_hash,
        evidence.provider_start_hash,
        evidence.poll_hash,
        evidence.provider_configuration_digest,
        evidence.challenge_expires_at,
        metadata.version,
      ],
      readonly: false,
    });
    if (snapshot.rowCount !== 1) return yield* Effect.fail(storageFailure());
    const identity = yield* transaction.execute({
      label: "hns-owner-recovery.poll-insert-control-identity",
      text: `INSERT INTO community_route_hns_control_identities (
               evidence_ref, ownership_source, root_label, txt_name,
               expected_txt_value_sha256, control_identity_digest,
               chain_authority_digest, provider_evidence_ref
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      values: [
        evidence.evidence_ref,
        evidence.ownership_source,
        evidence.root_label,
        evidence.challenge_name,
        evidence.challenge_value_sha256,
        controlIdentity,
        chainAuthority,
        evidence.provider_evidence_ref,
      ],
      readonly: false,
    });
    if (identity.rowCount !== 1) return yield* Effect.fail(storageFailure());
    const routeEvidence = yield* transaction.execute({
      label: "hns-owner-recovery.poll-insert-route-evidence",
      text: `INSERT INTO community_route_ownership_evidence (
               evidence_ref, creation_ceremony_intent_id, verified_by_actor_id,
               family, root_label, root_label_display, path_segment,
               requirement_hash, provider_id, provider_binding_hash,
               provider_configuration_version, provider_identity_digest,
               evidence_digest, evidence_receipt_id, binding_generation,
               verified_at, expires_at, origin, route_revalidation_attempt_id,
               route_attachment_ceremony_intent_id,
               operator_control_promotion_receipt_id,
               active_lease_renewal_attempt_id
             ) VALUES (
               $1,NULL,$2,'hns',$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,$12,
               $13::timestamptz,$14::timestamptz,'route_revalidation',$15,NULL,NULL,NULL
             )`,
      values: [
        evidence.evidence_ref,
        evidence.actor_id,
        evidence.root_label,
        evidence.root_label_display,
        evidence.path_segment,
        evidence.requirement_hash,
        evidence.provider_id,
        evidence.provider_binding_hash,
        evidence.provider_configuration_version,
        evidence.provider_identity_digest,
        evidence.evidence_digest,
        evidence.binding_generation,
        evidence.observed_at,
        evidence.expires_at,
        evidence.recovery_attempt_id,
      ],
      readonly: false,
    });
    if (routeEvidence.rowCount !== 1) return yield* Effect.fail(storageFailure());
  });
}

export function makeControlPlaneHnsOwnerRecoveryPollStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): HnsOwnerRecoveryPollStore {
  const provide = <A, E>(use: (db: ControlPlaneDb["Service"]) => Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      return yield* use(db);
    }).pipe(
      Effect.provide(runtime),
      Effect.mapError(() => storageFailure()),
    );
  return {
    load: (input) => provide((db) => makePollStore(db).load(input)),
    reserve: (input) => provide((db) => makePollStore(db).reserve(input)),
    release: (input) => provide((db) => makePollStore(db).release(input)),
    finalize: (input) => provide((db) => makePollStore(db).finalize(input)),
  };
}
