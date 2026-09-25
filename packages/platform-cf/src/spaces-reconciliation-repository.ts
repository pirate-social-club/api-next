import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  type SpacesFinalIssuanceV1,
  type SpacesReconciliationStore,
  type SpacesVerificationTargetV1,
} from "@pirate/application";
import type { SpacesNetworkV1 } from "@pirate/domain";
import { Effect, type Layer } from "effect";
import {
  advisoryLock,
  instant,
  integer,
  mapped,
  one,
  type Row,
  storage,
  text,
} from "./handle-sales-internals.ts";

/**
 * Every due pending claim is eligible, with or without an operator callback.
 * The lease fences a verifier result obtained outside a database transaction.
 * No production runtime composes this store with a verifier yet.
 */

const KEY_LOCK_NAMESPACE = 53_004;
const CAP_LOCK_NAMESPACE = 53_005;
const LEASE_SECONDS = 120;
const RETRY_SECONDS = 300;
const MAX_CAPACITY = 25;

const newId = (prefix: string): string => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

const network = (value: unknown): SpacesNetworkV1 => {
  if (value !== "mainnet" && value !== "testnet4" && value !== "regtest") {
    throw new Error("invalid Spaces network");
  }
  return value;
};

const targetFromRow = (row: Row): SpacesVerificationTargetV1 => ({
  claim_id: text(row, "claim_id"),
  lease_token: text(row, "lease_token"),
  network: network(row.network),
  namespace_root: text(row, "namespace_root"),
  handle_label: text(row, "handle_label"),
  script_pubkey_hex: text(row, "script_pubkey_hex"),
});

const validFinalEvidence = (evidence: SpacesFinalIssuanceV1): boolean =>
  /^[0-9a-f]{64}$/u.test(evidence.certificate_sha256_hex) &&
  /^[0-9a-f]{64}$/u.test(evidence.commitment_root_hex) &&
  Number.isSafeInteger(evidence.mined_height) &&
  evidence.mined_height >= 0 &&
  Number.isSafeInteger(evidence.verified_tip_height) &&
  evidence.verified_tip_height - evidence.mined_height > 144 &&
  /^[!-~]{1,128}$/u.test(evidence.verifier_id) &&
  /^[!-~]{1,128}$/u.test(evidence.verifier_version) &&
  Number.isFinite(Date.parse(evidence.observed_at));

const unchanged = (rowCount: number) =>
  rowCount === 1 ? Effect.void : Effect.fail(storage("invalid-row"));

const markOverdue = Effect.fn("spacesReconciliationMarkOverdue")(function* (
  thresholdSeconds: number,
  capacity: number,
) {
  if (
    !Number.isSafeInteger(thresholdSeconds) ||
    thresholdSeconds < 1 ||
    thresholdSeconds > 31_536_000 ||
    !Number.isSafeInteger(capacity) ||
    capacity < 1 ||
    capacity > MAX_CAPACITY
  )
    return yield* Effect.fail(storage("invalid-row"));
  const db = yield* ControlPlaneDb;
  const result = yield* db.execute<Row>({
    label: "spaces-reconciliation.overdue.mark",
    text: `WITH overdue AS (
             SELECT verification.claim_id
               FROM spaces_issuance_verifications AS verification
               JOIN handle_claims AS claim ON claim.claim_id=verification.claim_id
              WHERE verification.status='pending' AND claim.state='issuance_pending'
                AND verification.overdue_marked_at IS NULL
                AND claim.created_at <= clock_timestamp()-($1::integer * interval '1 second')
              ORDER BY claim.created_at,verification.claim_id
              LIMIT $2
              FOR UPDATE OF verification SKIP LOCKED
           )
           UPDATE spaces_issuance_verifications AS verification
              SET overdue_marked_at=clock_timestamp(),updated_at=clock_timestamp()
             FROM overdue WHERE verification.claim_id=overdue.claim_id
           RETURNING verification.claim_id`,
    values: [thresholdSeconds, capacity],
    readonly: false,
  });
  return yield* Effect.try({
    try: () => result.rows.map((row) => text(row, "claim_id")),
    catch: () => storage("invalid-row"),
  });
});

const unalertedOverdue = Effect.fn("spacesReconciliationUnalertedOverdue")(function* (
  capacity: number,
) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
    return yield* Effect.fail(storage("invalid-row"));
  }
  const db = yield* ControlPlaneDb;
  const result = yield* db.execute<Row>({
    label: "spaces-reconciliation.overdue.list-unalerted",
    text: `SELECT claim_id FROM spaces_issuance_verifications
            WHERE status='pending' AND overdue_marked_at IS NOT NULL
              AND overdue_alerted_at IS NULL
            ORDER BY overdue_marked_at,claim_id LIMIT $1`,
    values: [capacity],
    readonly: true,
  });
  return yield* Effect.try({
    try: () => result.rows.map((row) => text(row, "claim_id")),
    catch: () => storage("invalid-row"),
  });
});

const markOverdueAlerted = Effect.fn("spacesReconciliationMarkOverdueAlerted")(function* (
  claimId: string,
) {
  const db = yield* ControlPlaneDb;
  yield* db.execute({
    label: "spaces-reconciliation.overdue.mark-alerted",
    text: `UPDATE spaces_issuance_verifications
              SET overdue_alerted_at=clock_timestamp(),updated_at=clock_timestamp()
            WHERE claim_id=$1 AND status='pending' AND overdue_marked_at IS NOT NULL
              AND overdue_alerted_at IS NULL`,
    values: [claimId],
    readonly: false,
  });
});

const unalertedScopeAnomalies = Effect.fn("spacesReconciliationUnalertedScopeAnomalies")(function* (
  capacity: number,
) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
    return yield* Effect.fail(storage("invalid-row"));
  }
  const db = yield* ControlPlaneDb;
  const result = yield* db.execute<Row>({
    label: "spaces-reconciliation.scope-anomaly.list-unalerted",
    text: `SELECT anomaly_id,reason FROM spaces_registry_scope_anomalies
              WHERE alerted_at IS NULL ORDER BY first_seen_at,anomaly_id LIMIT $1`,
    values: [capacity],
    readonly: true,
  });
  return yield* Effect.try({
    try: () =>
      result.rows.map((row) => ({
        anomaly_id: text(row, "anomaly_id"),
        reason: text(row, "reason"),
      })),
    catch: () => storage("invalid-row"),
  });
});

const markScopeAnomalyAlerted = Effect.fn("spacesReconciliationMarkScopeAnomalyAlerted")(function* (
  anomalyId: string,
) {
  const db = yield* ControlPlaneDb;
  yield* db.execute({
    label: "spaces-reconciliation.scope-anomaly.mark-alerted",
    text: `UPDATE spaces_registry_scope_anomalies SET alerted_at=clock_timestamp()
              WHERE anomaly_id=$1 AND alerted_at IS NULL`,
    values: [anomalyId],
    readonly: false,
  });
});

const leaseDue = Effect.fn("spacesReconciliationLeaseDue")(function* (capacity: number) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
    return yield* Effect.fail(storage("invalid-row"));
  }
  const db = yield* ControlPlaneDb;
  const leaseToken = newId("slease");
  const result = yield* db.withTransaction((transaction) =>
    transaction.execute<Row>({
      label: "spaces-reconciliation.due.lease",
      text: `WITH due AS (
               SELECT verification.claim_id
                 FROM spaces_issuance_verifications AS verification
                 JOIN handle_claims AS claim ON claim.claim_id=verification.claim_id
                WHERE verification.status='pending'
                  AND claim.family='spaces' AND claim.state='issuance_pending'
                  AND verification.next_verification_at <= clock_timestamp()
                  AND (verification.leased_until IS NULL
                    OR verification.leased_until <= clock_timestamp())
                ORDER BY verification.next_verification_at,verification.claim_id
                LIMIT $1
                FOR UPDATE OF verification SKIP LOCKED
             ), leased AS (
               UPDATE spaces_issuance_verifications AS verification
                  SET lease_token=$2,
                      leased_until=clock_timestamp()+($3::integer * interval '1 second'),
                      attempt_count=attempt_count+1,
                      last_attempted_at=clock_timestamp(),
                      updated_at=clock_timestamp()
                 FROM due
                WHERE verification.claim_id=due.claim_id
                RETURNING verification.claim_id,verification.lease_token
             )
             SELECT leased.claim_id,leased.lease_token,item.network,item.namespace_root,
                    item.handle_label,item.script_pubkey_hex
               FROM leased JOIN spaces_registry_items AS item ON item.claim_id=leased.claim_id
              ORDER BY leased.claim_id`,
      values: [capacity, leaseToken, LEASE_SECONDS],
      readonly: false,
    }),
  );
  return yield* Effect.try({
    try: () => result.rows.map(targetFromRow),
    catch: () => storage("invalid-row"),
  });
});

const retryLater = Effect.fn("spacesReconciliationRetryLater")(function* (
  target: SpacesVerificationTargetV1,
) {
  const db = yield* ControlPlaneDb;
  const result = yield* db.execute({
    label: "spaces-reconciliation.verification.retry",
    text: `UPDATE spaces_issuance_verifications
              SET lease_token=NULL,leased_until=NULL,verification_due=false,
                  next_verification_at=clock_timestamp()+($3::integer * interval '1 second'),
                  updated_at=clock_timestamp()
            WHERE claim_id=$1 AND lease_token=$2 AND status='pending'
              AND leased_until > clock_timestamp()`,
    values: [target.claim_id, target.lease_token, RETRY_SECONDS],
    readonly: false,
  });
  return result.rowCount === 1 ? ("scheduled" as const) : ("stale" as const);
});

const finalizeInTransaction = Effect.fn("spacesReconciliationFinalizeInTransaction")(function* (
  transaction: ControlPlaneTransaction,
  target: SpacesVerificationTargetV1,
  evidence: SpacesFinalIssuanceV1,
) {
  yield* advisoryLock(
    transaction,
    KEY_LOCK_NAMESPACE,
    ["spaces", target.namespace_root, target.handle_label],
    "spaces-reconciliation.key.lock",
  );
  const loaded = yield* transaction.execute<Row>({
    label: "spaces-reconciliation.claim.lock",
    text: `SELECT claim.*,item.state AS item_state,item.network AS item_network,
                    item.script_pubkey_hex AS item_script_pubkey_hex,
                    verification.status AS verification_status,verification.lease_token,
                    verification.leased_until > clock_timestamp() AS lease_active,
                    persona.status AS persona_status,
                    offering.community_id
               FROM spaces_registry_items AS item
               JOIN handle_claims AS claim ON claim.claim_id=item.claim_id
               JOIN spaces_issuance_verifications AS verification
                 ON verification.claim_id=claim.claim_id
               JOIN personas AS persona ON persona.persona_id=claim.owner_persona_id
               JOIN community_handle_offering_revisions AS offering
                 ON offering.offering_id=claim.offering_id
                AND offering.offering_hash=claim.offering_hash
              WHERE item.claim_id=$1
              FOR UPDATE OF item,claim,verification
              FOR SHARE OF persona`,
    values: [target.claim_id],
    readonly: false,
  });
  const row = loaded.rows[0];
  if (
    row === undefined ||
    row.state !== "issuance_pending" ||
    row.verification_status !== "pending" ||
    row.lease_token !== target.lease_token ||
    row.lease_active !== true
  )
    return "stale" as const;
  const same =
    row.family === "spaces" &&
    row.item_network === target.network &&
    row.namespace_root === target.namespace_root &&
    row.handle_label === target.handle_label &&
    row.item_script_pubkey_hex === target.script_pubkey_hex &&
    row.recipient_network === target.network &&
    row.recipient_script_pubkey_hex === target.script_pubkey_hex;
  if (!same) return yield* Effect.fail(storage("invalid-row"));
  const fence = yield* transaction.execute<Row>({
    label: "spaces-reconciliation.fence.lock",
    text: `SELECT pending_claim_id FROM handle_key_fences
              WHERE family='spaces' AND namespace_root=$1 AND handle_label=$2 FOR UPDATE`,
    values: [target.namespace_root, target.handle_label],
    readonly: false,
  });
  if (fence.rows[0]?.pending_claim_id !== target.claim_id) {
    return yield* Effect.fail(storage("invalid-row"));
  }
  const now = one(
    (yield* transaction.execute<Row>({
      label: "spaces-reconciliation.database-clock.read",
      text: "SELECT clock_timestamp() AS database_now",
      values: [],
      readonly: false,
    })).rows,
    "database clock",
  ).database_now;
  const issuedAt = instant(now);
  if (Date.parse(evidence.observed_at) > Date.parse(issuedAt)) {
    return yield* Effect.fail(storage("invalid-row"));
  }
  const grantStatus = row.persona_status === "active" ? "active" : "tombstoned";
  const grantId = newId("sgrant");
  const evidenceId = newId("sfinal");
  yield* transaction.execute({
    label: "spaces-reconciliation.evidence.insert",
    text: `INSERT INTO spaces_final_issuance_evidence (
               evidence_id,claim_id,network,namespace_root,handle_label,script_pubkey_hex,
               certificate_sha256_hex,commitment_root_hex,mined_height,
               verified_tip_height,verifier_id,verifier_version,observed_at,recorded_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::timestamptz,$14::timestamptz)`,
    values: [
      evidenceId,
      target.claim_id,
      target.network,
      target.namespace_root,
      target.handle_label,
      target.script_pubkey_hex,
      evidence.certificate_sha256_hex,
      evidence.commitment_root_hex,
      evidence.mined_height,
      evidence.verified_tip_height,
      evidence.verifier_id,
      evidence.verifier_version,
      evidence.observed_at,
      issuedAt,
    ],
    readonly: false,
  });
  const claim = yield* transaction.execute({
    label: "spaces-reconciliation.claim.issue",
    text: `UPDATE handle_claims SET state='issued',safe_reason=NULL,grant_id=$2,
                    updated_at=$3::timestamptz
              WHERE claim_id=$1 AND family='spaces' AND state='issuance_pending'`,
    values: [target.claim_id, grantId, issuedAt],
    readonly: false,
  });
  yield* unchanged(claim.rowCount);
  if (row.item_state === "undelivered" || row.item_state === "delivered") {
    const item = yield* transaction.execute({
      label: "spaces-reconciliation.item.stop",
      text: `UPDATE spaces_registry_items
                   SET state=CASE WHEN state='undelivered' THEN 'withdrawn'
                                  ELSE 'redelivery_stopped' END,
                       updated_at=GREATEST(updated_at,$2::timestamptz)
                 WHERE claim_id=$1 AND state=$3`,
      values: [target.claim_id, issuedAt, row.item_state],
      readonly: false,
    });
    yield* unchanged(item.rowCount);
  }
  const converted = yield* transaction.execute({
    label: "spaces-reconciliation.fence.permanent",
    text: `UPDATE handle_key_fences
                 SET pending_claim_id=NULL,permanent_grant_id=$4,
                     updated_at=GREATEST(updated_at,$5::timestamptz)
               WHERE family='spaces' AND namespace_root=$1 AND handle_label=$2
                 AND pending_claim_id=$3`,
    values: [target.namespace_root, target.handle_label, target.claim_id, grantId, issuedAt],
    readonly: false,
  });
  yield* unchanged(converted.rowCount);
  yield* advisoryLock(
    transaction,
    CAP_LOCK_NAMESPACE,
    [text(row, "actor_account_id"), text(row, "offering_id")],
    "spaces-reconciliation.account-cap.lock",
  );
  const counter = yield* transaction.execute({
    label: "spaces-reconciliation.account-cap.convert",
    text: `UPDATE handle_account_offering_grant_counters
                 SET pending_issuance_count=pending_issuance_count-1,
                     active_grant_count=active_grant_count+$3,
                     updated_at=GREATEST(updated_at,$4::timestamptz)
               WHERE account_id=$1 AND offering_id=$2 AND pending_issuance_count>0`,
    values: [
      text(row, "actor_account_id"),
      text(row, "offering_id"),
      grantStatus === "active" ? 1 : 0,
      issuedAt,
    ],
    readonly: false,
  });
  yield* unchanged(counter.rowCount);
  yield* transaction.execute({
    label: "spaces-reconciliation.grant.insert",
    text: `INSERT INTO handle_grants (
               grant_id,grant_generation,community_id,offering_id,offering_hash,claim_id,
               owner_account_id,owner_persona_id,sale_namespace_activation_id,
               sale_namespace_activation_generation,fulfillment_kind,family,namespace_root,
               handle_label,display_identifier,status,issued_at,updated_at,recipient_kind,
               recipient_network,recipient_taproot_assignment_id,recipient_script_pubkey_hex,
               spaces_final_evidence_id
             ) VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,'spaces_native_v1','spaces',$10,$11,
                       $12,$13,$14::timestamptz,$14::timestamptz,'persona_taproot_v1',
                       $15,$16,$17,$18)`,
    values: [
      grantId,
      text(row, "community_id"),
      text(row, "offering_id"),
      text(row, "offering_hash"),
      target.claim_id,
      text(row, "actor_account_id"),
      text(row, "owner_persona_id"),
      text(row, "sale_namespace_activation_id"),
      integer(row, "sale_namespace_activation_generation"),
      target.namespace_root,
      target.handle_label,
      text(row, "display_identifier"),
      grantStatus,
      issuedAt,
      target.network,
      text(row, "recipient_taproot_assignment_id"),
      target.script_pubkey_hex,
      evidenceId,
    ],
    readonly: false,
  });
  const verification = yield* transaction.execute({
    label: "spaces-reconciliation.verification.complete",
    text: `UPDATE spaces_issuance_verifications
                 SET status='verified',verification_due=false,lease_token=NULL,
                     leased_until=NULL,updated_at=$3::timestamptz
               WHERE claim_id=$1 AND lease_token=$2 AND status='pending'`,
    values: [target.claim_id, target.lease_token, issuedAt],
    readonly: false,
  });
  yield* unchanged(verification.rowCount);
  return "issued" as const;
});

const finalize = Effect.fn("spacesReconciliationFinalize")(function* (
  target: SpacesVerificationTargetV1,
  evidence: SpacesFinalIssuanceV1,
) {
  if (!validFinalEvidence(evidence)) return yield* Effect.fail(storage("invalid-row"));
  const db = yield* ControlPlaneDb;
  return yield* db.withTransaction((transaction) =>
    finalizeInTransaction(transaction, target, evidence),
  );
});

const recordConflict = Effect.fn("spacesReconciliationRecordConflict")(function* (
  target: SpacesVerificationTargetV1,
  observedScriptPubkeyHex: string,
  evidence: SpacesFinalIssuanceV1,
) {
  if (
    !validFinalEvidence(evidence) ||
    !/^5120[0-9a-f]{64}$/u.test(observedScriptPubkeyHex) ||
    observedScriptPubkeyHex === target.script_pubkey_hex
  )
    return yield* Effect.fail(storage("invalid-row"));
  const db = yield* ControlPlaneDb;
  return yield* db.withTransaction((transaction) =>
    Effect.gen(function* () {
      yield* advisoryLock(
        transaction,
        KEY_LOCK_NAMESPACE,
        ["spaces", target.namespace_root, target.handle_label],
        "spaces-reconciliation.conflict-key.lock",
      );
      const loaded = yield* transaction.execute<Row>({
        label: "spaces-reconciliation.conflict-claim.lock",
        text: `SELECT claim.state AS claim_state,claim.actor_account_id,claim.offering_id,
                      item.state AS item_state,item.network,item.namespace_root,item.handle_label,
                      item.script_pubkey_hex,verification.status AS verification_status,
                      verification.lease_token,
                      verification.leased_until > clock_timestamp() AS lease_active
                 FROM spaces_registry_items AS item
                 JOIN handle_claims AS claim ON claim.claim_id=item.claim_id
                 JOIN spaces_issuance_verifications AS verification
                   ON verification.claim_id=item.claim_id
                WHERE item.claim_id=$1
                FOR UPDATE OF item,claim,verification`,
        values: [target.claim_id],
        readonly: false,
      });
      const row = loaded.rows[0];
      if (
        row === undefined ||
        row.claim_state !== "issuance_pending" ||
        row.verification_status !== "pending" ||
        row.lease_token !== target.lease_token ||
        row.lease_active !== true
      )
        return "stale" as const;
      if (
        row.network !== target.network ||
        row.namespace_root !== target.namespace_root ||
        row.handle_label !== target.handle_label ||
        row.script_pubkey_hex !== target.script_pubkey_hex
      )
        return yield* Effect.fail(storage("invalid-row"));
      const fence = yield* transaction.execute<Row>({
        label: "spaces-reconciliation.conflict-fence.lock",
        text: `SELECT pending_claim_id FROM handle_key_fences
               WHERE family='spaces' AND namespace_root=$1 AND handle_label=$2 FOR UPDATE`,
        values: [target.namespace_root, target.handle_label],
        readonly: false,
      });
      if (fence.rows[0]?.pending_claim_id !== target.claim_id) {
        return yield* Effect.fail(storage("invalid-row"));
      }
      const now = instant(
        one(
          (yield* transaction.execute<Row>({
            label: "spaces-reconciliation.conflict-clock.read",
            text: "SELECT clock_timestamp() AS database_now",
            values: [],
            readonly: false,
          })).rows,
          "database clock",
        ).database_now,
      );
      if (Date.parse(evidence.observed_at) > Date.parse(now)) {
        return yield* Effect.fail(storage("invalid-row"));
      }
      const evidenceId = newId("sconfinal");
      const observationId = newId("srconflict");
      yield* transaction.execute({
        label: "spaces-reconciliation.final-conflict-evidence.insert",
        text: `INSERT INTO spaces_final_conflict_evidence (
                 evidence_id,claim_id,network,namespace_root,handle_label,
                 expected_script_pubkey_hex,observed_script_pubkey_hex,
                 certificate_sha256_hex,commitment_root_hex,
                 mined_height,verified_tip_height,verifier_id,verifier_version,
                 observed_at,recorded_at
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                         $14::timestamptz,$15::timestamptz)`,
        values: [
          evidenceId,
          target.claim_id,
          target.network,
          target.namespace_root,
          target.handle_label,
          target.script_pubkey_hex,
          observedScriptPubkeyHex,
          evidence.certificate_sha256_hex,
          evidence.commitment_root_hex,
          evidence.mined_height,
          evidence.verified_tip_height,
          evidence.verifier_id,
          evidence.verifier_version,
          evidence.observed_at,
          now,
        ],
        readonly: false,
      });
      yield* transaction.execute({
        label: "spaces-reconciliation.final-conflict-observation.insert",
        text: `INSERT INTO spaces_external_conflict_observations (
                 observation_id,family,network,namespace_root,handle_label,evidence_kind,
                 final_conflict_evidence_id,observed_at,recorded_at
               ) VALUES ($1,'spaces',$2,$3,$4,'final_conflict_evidence_v1',$5,
                         $6::timestamptz,$7::timestamptz)`,
        values: [
          observationId,
          target.network,
          target.namespace_root,
          target.handle_label,
          evidenceId,
          evidence.observed_at,
          now,
        ],
        readonly: false,
      });
      const claim = yield* transaction.execute({
        label: "spaces-reconciliation.conflict-claim.fail",
        text: `UPDATE handle_claims
                 SET state='issuance_failed',safe_reason='handle_unavailable',
                     updated_at=$2::timestamptz
               WHERE claim_id=$1 AND family='spaces' AND state='issuance_pending'`,
        values: [target.claim_id, now],
        readonly: false,
      });
      yield* unchanged(claim.rowCount);
      if (row.item_state === "undelivered" || row.item_state === "delivered") {
        const item = yield* transaction.execute({
          label: "spaces-reconciliation.conflict-item.stop",
          text: `UPDATE spaces_registry_items
                   SET state=CASE WHEN state='undelivered' THEN 'withdrawn'
                                  ELSE 'redelivery_stopped' END,
                       updated_at=GREATEST(updated_at,$2::timestamptz)
                 WHERE claim_id=$1 AND state=$3`,
          values: [target.claim_id, now, row.item_state],
          readonly: false,
        });
        yield* unchanged(item.rowCount);
      }
      const converted = yield* transaction.execute({
        label: "spaces-reconciliation.conflict-fence.convert",
        text: `UPDATE handle_key_fences
                   SET pending_claim_id=NULL,external_conflict_observation_id=$4,
                       updated_at=GREATEST(updated_at,$5::timestamptz)
                 WHERE family='spaces' AND namespace_root=$1 AND handle_label=$2
                   AND pending_claim_id=$3`,
        values: [target.namespace_root, target.handle_label, target.claim_id, observationId, now],
        readonly: false,
      });
      yield* unchanged(converted.rowCount);
      const accountId = text(row, "actor_account_id");
      const offeringId = text(row, "offering_id");
      yield* advisoryLock(
        transaction,
        CAP_LOCK_NAMESPACE,
        [accountId, offeringId],
        "spaces-reconciliation.conflict-account-cap.lock",
      );
      const counter = yield* transaction.execute({
        label: "spaces-reconciliation.conflict-account-cap.release",
        text: `UPDATE handle_account_offering_grant_counters
                   SET pending_issuance_count=pending_issuance_count-1,
                       updated_at=GREATEST(updated_at,$3::timestamptz)
                 WHERE account_id=$1 AND offering_id=$2 AND pending_issuance_count>0`,
        values: [accountId, offeringId, now],
        readonly: false,
      });
      yield* unchanged(counter.rowCount);
      const verification = yield* transaction.execute({
        label: "spaces-reconciliation.conflict-verification.close",
        text: `UPDATE spaces_issuance_verifications
                   SET status='closed',verification_due=false,lease_token=NULL,
                       leased_until=NULL,updated_at=$3::timestamptz
                 WHERE claim_id=$1 AND lease_token=$2 AND status='pending'`,
        values: [target.claim_id, target.lease_token, now],
        readonly: false,
      });
      yield* unchanged(verification.rowCount);
      return "conflict" as const;
    }),
  );
});

export function makeControlPlaneSpacesReconciliationStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): SpacesReconciliationStore {
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    mapped(Effect.provide(runtime)(effect));
  return {
    markOverdue: (thresholdSeconds, capacity) => provide(markOverdue(thresholdSeconds, capacity)),
    unalertedOverdue: (capacity) => provide(unalertedOverdue(capacity)),
    markOverdueAlerted: (claimId) => provide(markOverdueAlerted(claimId)),
    unalertedScopeAnomalies: (capacity) => provide(unalertedScopeAnomalies(capacity)),
    markScopeAnomalyAlerted: (anomalyId) => provide(markScopeAnomalyAlerted(anomalyId)),
    leaseDue: (capacity) => provide(leaseDue(capacity)),
    retryLater: (target) => provide(retryLater(target)),
    finalize: (target, evidence) => provide(finalize(target, evidence)),
    recordConflict: (target, observedScriptPubkeyHex, evidence) =>
      provide(recordConflict(target, observedScriptPubkeyHex, evidence)),
  } as SpacesReconciliationStore;
}
