import {
  ControlPlaneDb,
  type ControlPlaneError,
  type HnsOwnerRecoveryAuthorityResolver,
  type HnsOwnerRecoveryStartReservation,
  HnsOwnerRecoveryStartStorageFailed,
  type HnsOwnerRecoveryStartStore,
} from "@pirate/application";
import { canonicalJson } from "@pirate/domain";
import { Effect, type Layer } from "effect";
import {
  type HnsOwnerRecoveryRow,
  hnsOwnerRecoveryInteger,
  hnsOwnerRecoveryString,
  hnsOwnerRecoveryTimestamp,
  loadHnsOwnerRecoveryStored,
  oneHnsOwnerRecoveryRow,
  queryHnsOwnerRecoveryAuthority,
} from "./hns-owner-recovery-repository-shared.ts";

const storageFailure = (): HnsOwnerRecoveryStartStorageFailed =>
  new HnsOwnerRecoveryStartStorageFailed();

function reservationFromRow(
  row: HnsOwnerRecoveryRow,
  authority: HnsOwnerRecoveryStartReservation["authority"],
): HnsOwnerRecoveryStartReservation | null {
  const reservationId = hnsOwnerRecoveryString(row, "start_reservation_id");
  const recoveryId = hnsOwnerRecoveryString(row, "route_revalidation_id");
  const sessionId = hnsOwnerRecoveryString(row, "revalidation_session_id");
  const fence = hnsOwnerRecoveryInteger(row.fence_token);
  const startedAt = hnsOwnerRecoveryTimestamp(row, "database_started_at");
  const leaseExpiresAt = hnsOwnerRecoveryTimestamp(row, "lease_expires_at");
  return reservationId !== null &&
    recoveryId !== null &&
    sessionId !== null &&
    fence !== null &&
    startedAt !== null &&
    leaseExpiresAt !== null
    ? {
        reservation_id: reservationId,
        route_recovery_id: recoveryId,
        session_id: sessionId,
        fence_token: fence,
        database_started_at: startedAt,
        lease_expires_at: leaseExpiresAt,
        authority,
      }
    : null;
}

function makeAuthorityResolver(db: ControlPlaneDb["Service"]): HnsOwnerRecoveryAuthorityResolver {
  return {
    resolve: (input) =>
      queryHnsOwnerRecoveryAuthority(db, input).pipe(Effect.mapError(() => storageFailure())),
  };
}

function makeStartStore(db: ControlPlaneDb["Service"]): HnsOwnerRecoveryStartStore {
  const replay: HnsOwnerRecoveryStartStore["replay"] = (input) =>
    Effect.gen(function* () {
      const result = yield* db.execute<HnsOwnerRecoveryRow>({
        label: "hns-owner-recovery.start-replay",
        text: `SELECT route_revalidation_id, revalidation_session_id,
                      start_idempotency_key, public_start_hash, state,
                      lease_expires_at, clock_timestamp() AS database_now
                 FROM community_route_revalidation_start_reservations
                WHERE operation_mode = 'same_root_recovery'
                  AND principal_id = $1 AND community_id = $2
                  AND expected_binding_generation = $3
                LIMIT 2`,
        values: [input.actor_id, input.community_id, input.expected_generation],
        readonly: true,
      });
      if (result.rows.length > 1) return { kind: "conflict" } as const;
      const row = result.rows[0];
      if (row === undefined) return { kind: "none" } as const;
      if (hnsOwnerRecoveryString(row, "start_idempotency_key") !== input.idempotency_key) {
        return { kind: "conflict" } as const;
      }
      const recoveryId = hnsOwnerRecoveryString(row, "route_revalidation_id");
      const sessionId = hnsOwnerRecoveryString(row, "revalidation_session_id");
      const state = hnsOwnerRecoveryString(row, "state");
      if (recoveryId === null || sessionId === null || state === null) {
        return yield* Effect.fail(storageFailure());
      }
      if (state === "finalized") {
        const stored = yield* loadHnsOwnerRecoveryStored(
          db,
          `WHERE s.route_revalidation_id = $1
                 AND s.revalidation_session_id = $2
                 AND s.operation_mode = 'same_root_recovery'`,
          [recoveryId, sessionId],
          true,
        );
        if (stored === null || stored === undefined) {
          return yield* Effect.fail(storageFailure());
        }
        return { kind: "replay", stored } as const;
      }
      const lease = hnsOwnerRecoveryTimestamp(row, "lease_expires_at");
      const now = hnsOwnerRecoveryTimestamp(row, "database_now");
      if (
        state === "acquired" &&
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
      return { kind: "none" } as const;
    }).pipe(Effect.mapError(() => storageFailure()));

  const reserve: HnsOwnerRecoveryStartStore["reserve"] = (input) =>
    db
      .withTransaction((transaction) =>
        Effect.gen(function* () {
          const lockedRoute = yield* transaction.execute<HnsOwnerRecoveryRow>({
            label: "hns-owner-recovery.start-lock-route",
            text: `SELECT c.community_id, b.route_binding_id
                     FROM communities AS c
                     JOIN community_canonical_route_bindings AS b
                       ON b.community_id = c.community_id
                      AND b.route_binding_id = c.canonical_route_binding_id
                    WHERE c.created_by_user_id = $1 AND c.community_id = $2
                      AND b.binding_generation = $3
                    FOR UPDATE OF c, b`,
            values: [
              input.request.actor_id,
              input.request.community_id,
              input.request.expected_generation,
            ],
            readonly: false,
          });
          if (oneHnsOwnerRecoveryRow(lockedRoute) === undefined) {
            return yield* Effect.fail(storageFailure());
          }
          if (lockedRoute.rows.length === 0) return { kind: "not_found" } as const;
          const authority = yield* queryHnsOwnerRecoveryAuthority(transaction, {
            actor_id: input.request.actor_id,
            community_id: input.request.community_id,
            expected_generation: input.request.expected_generation,
          });
          if (authority === null) return { kind: "not_found" } as const;
          if (canonicalJson(authority) !== canonicalJson(input.expected_authority)) {
            return { kind: "conflict" } as const;
          }

          const existingResult = yield* transaction.execute<HnsOwnerRecoveryRow>({
            label: "hns-owner-recovery.start-lock-reservation",
            text: `SELECT *, clock_timestamp() AS database_now
                     FROM community_route_revalidation_start_reservations
                    WHERE route_binding_id = $1 AND expected_binding_generation = $2
                    FOR UPDATE`,
            values: [authority.route_binding_id, authority.expected_binding_generation],
            readonly: false,
          });
          const existing = oneHnsOwnerRecoveryRow(existingResult);
          if (existing === undefined) return yield* Effect.fail(storageFailure());
          if (existing !== null) {
            if (
              hnsOwnerRecoveryString(existing, "operation_mode") !== "same_root_recovery" ||
              hnsOwnerRecoveryString(existing, "principal_id") !== authority.actor_id ||
              hnsOwnerRecoveryString(existing, "start_idempotency_key") !==
                input.request.idempotency_key ||
              hnsOwnerRecoveryString(existing, "requirement_hash") !== input.requirement_hash ||
              hnsOwnerRecoveryString(existing, "public_start_hash") !== input.public_start_hash
            ) {
              return { kind: "conflict" } as const;
            }
            const recoveryId = hnsOwnerRecoveryString(existing, "route_revalidation_id");
            const sessionId = hnsOwnerRecoveryString(existing, "revalidation_session_id");
            const state = hnsOwnerRecoveryString(existing, "state");
            if (recoveryId === null || sessionId === null || state === null) {
              return yield* Effect.fail(storageFailure());
            }
            if (state === "finalized") {
              const stored = yield* loadHnsOwnerRecoveryStored(
                transaction,
                `WHERE s.route_revalidation_id = $1
                   AND s.revalidation_session_id = $2
                   AND s.operation_mode = 'same_root_recovery'`,
                [recoveryId, sessionId],
                false,
              );
              return stored === null || stored === undefined
                ? yield* Effect.fail(storageFailure())
                : ({ kind: "replay", stored } as const);
            }
            const lease = hnsOwnerRecoveryTimestamp(existing, "lease_expires_at");
            const now = hnsOwnerRecoveryTimestamp(existing, "database_now");
            if (
              state === "acquired" &&
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
            const reacquiredResult = yield* transaction.execute<HnsOwnerRecoveryRow>({
              label: "hns-owner-recovery.start-reacquire",
              text: `UPDATE community_route_revalidation_start_reservations
                        SET state = 'acquired', fence_token = fence_token + 1,
                            lease_expires_at = clock_timestamp() + ($1 * INTERVAL '1 millisecond')
                      WHERE route_revalidation_id = $2 AND revalidation_session_id = $3
                        AND (state = 'released' OR lease_expires_at <= clock_timestamp())
                    RETURNING *, challenge_expires_at - INTERVAL '1 hour'
                                  AS database_started_at`,
              values: [input.lease_ms, recoveryId, sessionId],
              readonly: false,
            });
            const reacquired = oneHnsOwnerRecoveryRow(reacquiredResult);
            if (reacquired === undefined || reacquired === null) {
              return { kind: "conflict" } as const;
            }
            const reservation = reservationFromRow(reacquired, authority);
            return reservation === null
              ? yield* Effect.fail(storageFailure())
              : ({ kind: "acquired", reservation } as const);
          }

          const insertedResult = yield* transaction.execute<HnsOwnerRecoveryRow>({
            label: "hns-owner-recovery.start-insert-reservation",
            text: `INSERT INTO community_route_revalidation_start_reservations (
                     route_revalidation_id, revalidation_session_id, community_id,
                     route_binding_id, principal_kind, principal_id,
                     expected_binding_generation, expected_verified_evidence_ref,
                     requirement_hash, provider_id, provider_binding_hash,
                     provider_configuration_kind, provider_configuration_reference,
                     provider_configuration_version, protocol_version, environment,
                     family, root_label, root_label_display, path_segment,
                     start_request_hash, lease_expires_at, operation_mode,
                     start_reservation_id, start_idempotency_key,
                     recovery_authority_kind, recovery_authority_reference,
                     public_start_hash, provider_configuration_digest
                   ) VALUES (
                     $1,$2,$3,$4,'user',$5,$6,NULL,$7,$8,$9,$10,$11,$12,
                     'hns-owner-recovery-v1',$13,'hns',$14,$15,$16,$17,
                     clock_timestamp() + ($18 * INTERVAL '1 millisecond'),
                     'same_root_recovery',$19,$20,$21,$22,$23,$24
                   )
                   RETURNING *, challenge_expires_at - INTERVAL '1 hour'
                                 AS database_started_at`,
            values: [
              input.route_recovery_id,
              input.session_id,
              authority.community_id,
              authority.route_binding_id,
              authority.actor_id,
              authority.expected_binding_generation,
              input.requirement_hash,
              authority.provider_id,
              authority.provider_binding_hash,
              authority.provider_configuration.kind,
              authority.provider_configuration.reference,
              authority.provider_configuration.version,
              authority.environment,
              authority.route.root_label,
              authority.route.root_label_display,
              authority.route.path_segment,
              input.public_start_hash,
              input.lease_ms,
              input.reservation_id,
              input.request.idempotency_key,
              authority.recovery_authority_kind,
              authority.recovery_authority_reference,
              input.public_start_hash,
              authority.provider_configuration.digest,
            ],
            readonly: false,
          });
          const inserted = oneHnsOwnerRecoveryRow(insertedResult);
          if (inserted === undefined || inserted === null) {
            return yield* Effect.fail(storageFailure());
          }
          const reservation = reservationFromRow(inserted, authority);
          return reservation === null
            ? yield* Effect.fail(storageFailure())
            : ({ kind: "acquired", reservation } as const);
        }),
      )
      .pipe(Effect.mapError(() => storageFailure()));

  const finalize: HnsOwnerRecoveryStartStore["finalize"] = (input) =>
    db
      .withTransaction((transaction) =>
        Effect.gen(function* () {
          const lockedResult = yield* transaction.execute<HnsOwnerRecoveryRow>({
            label: "hns-owner-recovery.start-finalize-lock",
            text: `SELECT *, clock_timestamp() AS database_now
                     FROM community_route_revalidation_start_reservations
                    WHERE route_revalidation_id = $1 AND revalidation_session_id = $2
                    FOR UPDATE`,
            values: [input.reservation.route_recovery_id, input.reservation.session_id],
            readonly: false,
          });
          const locked = oneHnsOwnerRecoveryRow(lockedResult);
          if (locked === undefined) return yield* Effect.fail(storageFailure());
          if (locked === null) return { kind: "stale" } as const;
          if (hnsOwnerRecoveryString(locked, "state") === "finalized") {
            const stored = yield* loadHnsOwnerRecoveryStored(
              transaction,
              `WHERE s.route_revalidation_id = $1
                 AND s.revalidation_session_id = $2
                 AND s.operation_mode = 'same_root_recovery'`,
              [input.reservation.route_recovery_id, input.reservation.session_id],
              false,
            );
            return stored === null || stored === undefined
              ? yield* Effect.fail(storageFailure())
              : ({ kind: "replay", stored } as const);
          }
          const fence = hnsOwnerRecoveryInteger(locked.fence_token);
          const lease = hnsOwnerRecoveryTimestamp(locked, "lease_expires_at");
          const now = hnsOwnerRecoveryTimestamp(locked, "database_now");
          if (
            hnsOwnerRecoveryString(locked, "state") !== "acquired" ||
            fence !== input.reservation.fence_token ||
            lease === null ||
            now === null ||
            Date.parse(lease) <= Date.parse(now) ||
            hnsOwnerRecoveryString(locked, "start_idempotency_key") !==
              input.start_idempotency_key ||
            hnsOwnerRecoveryString(locked, "public_start_hash") !== input.public_start_hash ||
            hnsOwnerRecoveryString(locked, "provider_start_hash") !== null
          ) {
            return { kind: "stale" } as const;
          }
          const finalizedReservation = yield* transaction.execute({
            label: "hns-owner-recovery.start-finalize-reservation",
            text: `UPDATE community_route_revalidation_start_reservations
                      SET state = 'finalized', provider_start_hash = $1
                    WHERE route_revalidation_id = $2 AND revalidation_session_id = $3
                      AND state = 'acquired' AND fence_token = $4
                      AND lease_expires_at > clock_timestamp()`,
            values: [
              input.session.provider_start_hash,
              input.reservation.route_recovery_id,
              input.reservation.session_id,
              input.reservation.fence_token,
            ],
            readonly: false,
          });
          if (finalizedReservation.rowCount !== 1) return { kind: "stale" } as const;

          const presentation = {
            kind: "embedded_sdk",
            session_id: input.session.upstream_session_ref,
            protocol: "hns-txt-challenge",
            version: "1",
            payload: {
              ownership_source: input.session.ownership_source,
              challenge_name: input.session.challenge_name,
              challenge_value: input.session.challenge_value,
              expires_at: input.session.challenge_expires_at,
            },
          };
          const inserted = yield* transaction.execute({
            label: "hns-owner-recovery.start-insert-session",
            text: `INSERT INTO community_route_revalidation_sessions (
                     revalidation_session_id, route_revalidation_id, start_fence_token,
                     community_id, route_binding_id, principal_kind, principal_id,
                     expected_binding_generation, expected_verified_evidence_ref,
                     requirement_hash, start_request_hash, provider_id,
                     provider_binding_hash, provider_configuration_kind,
                     provider_configuration_reference, provider_configuration_version,
                     protocol_version, environment, family, root_label,
                     root_label_display, path_segment, upstream_session_ref,
                     start_presentation, status, started_at, expires_at,
                     operation_mode, start_idempotency_key, recovery_authority_kind,
                     recovery_authority_reference, public_start_hash, provider_start_hash,
                     provider_configuration_digest, challenge_expires_at
                   ) VALUES (
                     $1,$2,$3,$4,$5,'user',$6,$7,NULL,$8,$9,$10,$11,$12,$13,$14,
                     'hns-owner-recovery-v1',$15,'hns',$16,$17,$18,$19,$20::jsonb,
                     'pending',$21::timestamptz,$22::timestamptz,
                     'same_root_recovery',$23,$24,$25,$26,$27,$28,$22::timestamptz
                   )`,
            values: [
              input.session.session_id,
              input.session.route_recovery_id,
              input.reservation.fence_token,
              input.session.community_id,
              input.session.route_binding_id,
              input.session.actor_id,
              input.session.expected_binding_generation,
              input.session.requirement_hash,
              input.public_start_hash,
              input.session.provider_id,
              input.session.provider_binding_hash,
              input.session.provider_configuration.kind,
              input.session.provider_configuration.reference,
              input.session.provider_configuration.version,
              input.session.environment,
              input.session.route.root_label,
              input.session.route.root_label_display,
              input.session.route.path_segment,
              input.session.upstream_session_ref,
              JSON.stringify(presentation),
              input.session.started_at,
              input.session.challenge_expires_at,
              input.start_idempotency_key,
              input.session.recovery_authority_kind,
              input.session.recovery_authority_reference,
              input.public_start_hash,
              input.session.provider_start_hash,
              input.session.provider_configuration.digest,
            ],
            readonly: false,
          });
          if (inserted.rowCount !== 1) return yield* Effect.fail(storageFailure());
          const stored = yield* loadHnsOwnerRecoveryStored(
            transaction,
            `WHERE s.route_revalidation_id = $1
               AND s.revalidation_session_id = $2
               AND s.operation_mode = 'same_root_recovery'`,
            [input.reservation.route_recovery_id, input.reservation.session_id],
            false,
          );
          if (
            stored === null ||
            stored === undefined ||
            canonicalJson(stored.session) !== canonicalJson(input.session) ||
            canonicalJson(stored.session_authority) !== canonicalJson(input.session_authority)
          ) {
            return yield* Effect.fail(storageFailure());
          }
          return { kind: "created" } as const;
        }),
      )
      .pipe(Effect.mapError(() => storageFailure()));

  const release: HnsOwnerRecoveryStartStore["release"] = (reservation) =>
    db
      .execute({
        label: "hns-owner-recovery.start-release",
        text: `UPDATE community_route_revalidation_start_reservations
                  SET state = 'released'
                WHERE route_revalidation_id = $1 AND revalidation_session_id = $2
                  AND start_reservation_id = $3 AND fence_token = $4
                  AND state = 'acquired'`,
        values: [
          reservation.route_recovery_id,
          reservation.session_id,
          reservation.reservation_id,
          reservation.fence_token,
        ],
        readonly: false,
      })
      .pipe(
        Effect.asVoid,
        Effect.mapError(() => storageFailure()),
      );

  return { replay, reserve, finalize, release };
}

function provideRuntime<A, E>(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  use: (db: ControlPlaneDb["Service"]) => Effect.Effect<A, E>,
): Effect.Effect<A, E | HnsOwnerRecoveryStartStorageFailed> {
  return Effect.gen(function* () {
    const db = yield* ControlPlaneDb;
    return yield* use(db);
  }).pipe(
    Effect.provide(runtime),
    Effect.mapError(() => storageFailure()),
  );
}

export function makeControlPlaneHnsOwnerRecoveryAuthorityResolver(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): HnsOwnerRecoveryAuthorityResolver {
  return {
    resolve: (input) => provideRuntime(runtime, (db) => makeAuthorityResolver(db).resolve(input)),
  };
}

export function makeControlPlaneHnsOwnerRecoveryStartStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): HnsOwnerRecoveryStartStore {
  return {
    replay: (input) => provideRuntime(runtime, (db) => makeStartStore(db).replay(input)),
    reserve: (input) => provideRuntime(runtime, (db) => makeStartStore(db).reserve(input)),
    finalize: (input) => provideRuntime(runtime, (db) => makeStartStore(db).finalize(input)),
    release: (input) => provideRuntime(runtime, (db) => makeStartStore(db).release(input)),
  };
}
