import { createHash } from "node:crypto";
import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  type HandleSalesStorageFailed,
  type SpacesRegistryAckEntryV1,
  type SpacesRegistryCredentialV1,
  type SpacesRegistryEntryDispositionV1,
  type SpacesRegistryPendingResultV1,
  type SpacesRegistryStopResultV1,
  type SpacesRegistryStore,
} from "@pirate/application";
import {
  applySpacesCapChangeV1,
  parseSpacesHandleV1,
  reduceSpacesIssuanceV1,
  type SpacesCapReservationStateV1,
  type SpacesClaimStateV1,
  type SpacesHandleKeyFenceStateV1,
  type SpacesIssuanceDecisionV1,
  type SpacesIssuanceStateV1,
  type SpacesNetworkV1,
  type SpacesRegistryItemStateV1,
} from "@pirate/domain";
import { Effect, type Layer } from "effect";
import {
  advisoryLock,
  integer,
  mapped,
  one,
  type Row,
  storage,
  stringArray,
  text,
} from "./handle-sales-internals.ts";
import {
  spacesRegistryTokenCredentialIdV1,
  spacesRegistryTokenVerifierV1,
  spacesRegistryVerifierMatchesV1,
} from "./spaces-registry-credential.ts";

/**
 * The private Spaces registry store (spec 012 §5.3.13.5, §5.3.13.7, and
 * §5.3.13.8) behind the upstream wire of subs 4dcc923. Every change to a
 * claim, its registry item, its key fence, and its account-cap reservation is
 * decided by the S1 issuance reducer and written in one transaction with the
 * observation that caused it. Nothing here writes a grant.
 *
 * Scope is the credential's operator instance and environment, intersected
 * with its explicitly allowed spaces and the spaces currently assigned to that
 * instance. An acknowledgment or commit entry applies to the latest delivered
 * item of its key, and only when that delivery was made under the current
 * operator-assignment generation; an earlier generation's callback is fenced.
 */

type Tx = ControlPlaneTransaction;
type Endpoint = "pending" | "ack" | "committed";
type AnomalyReason =
  | "numeric_space"
  | "invalid_space"
  | "space_not_assigned"
  | "malformed_entry"
  | "handle_unparseable"
  | "handle_out_of_scope"
  | "no_delivered_item"
  | "contradicts_recorded_outcome"
  | "claim_terminal";

/** The same key and account-cap lock namespaces as quote, reservation, and claim. */
const KEY_LOCK_NAMESPACE = 53_004;
const CAP_LOCK_NAMESPACE = 53_005;

const FORBIDDEN: SpacesRegistryPendingResultV1 = { kind: "forbidden" };
const NO_HANDLES: SpacesRegistryPendingResultV1 = { kind: "handles", handles: [] };

const newId = (prefix: string): string =>
  `${prefix}_${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex")}`;

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const decoded = <A>(decode: () => A) =>
  Effect.try({ try: decode, catch: () => storage("invalid-row") });

const invariant = (condition: boolean) =>
  condition ? Effect.void : Effect.fail(storage("invalid-row"));

const network = (row: Row, key: string): SpacesNetworkV1 => {
  const value = text(row, key);
  if (value !== "mainnet" && value !== "testnet4" && value !== "regtest") {
    throw new Error(`invalid ${key}`);
  }
  return value;
};

const databaseNow = Effect.fn("spacesRegistryDatabaseNow")(function* (transaction: Tx) {
  const clock = yield* transaction.execute<Row>({
    label: "spaces-registry.database-clock.read",
    text: "SELECT clock_timestamp() AS database_now",
    values: [],
    readonly: false,
  });
  return one(clock.rows, "database clock").database_now;
});

/**
 * Repeats of one anomaly by one credential count on a single row. The raw
 * subject is kept as a digest, with a copy only when it is short printable
 * ASCII, so no operator input can break the row or grow it without bound.
 */
const recordAnomaly = Effect.fn("spacesRegistryRecordAnomaly")(function* (
  transaction: Tx,
  input: Readonly<{
    credential: SpacesRegistryCredentialV1;
    endpoint: Endpoint;
    reason: AnomalyReason;
    subject: string;
  }>,
) {
  yield* transaction.execute({
    label: "spaces-registry.anomaly.record",
    text: `INSERT INTO spaces_registry_scope_anomalies (
             anomaly_id,credential_id,operator_instance_id,endpoint,reason,subject_digest,
             subject_text,first_seen_at,last_seen_at,occurrence_count
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp(),clock_timestamp(),1)
           ON CONFLICT (credential_id,endpoint,reason,subject_digest) DO UPDATE SET
             last_seen_at=GREATEST(spaces_registry_scope_anomalies.last_seen_at,
                                   EXCLUDED.last_seen_at),
             occurrence_count=spaces_registry_scope_anomalies.occurrence_count+1`,
    values: [
      newId("sranom"),
      input.credential.credential_id,
      input.credential.operator_instance_id,
      input.endpoint,
      input.reason,
      sha256Hex(input.subject),
      /^[!-~]{1,300}$/u.test(input.subject) ? input.subject : null,
    ],
    readonly: false,
  });
  return "anomaly" as const;
});

type AssignedScope = Readonly<{ assignmentId: string; assignmentGeneration: number }>;

/**
 * The root is in scope when the credential allows it and the root's current
 * active assignment belongs to the credential's live operator instance.
 */
const assignedScope = Effect.fn("spacesRegistryAssignedScope")(function* (
  transaction: Tx,
  credential: SpacesRegistryCredentialV1,
  root: string,
) {
  const result = yield* transaction.execute<Row>({
    label: "spaces-registry.scope.read",
    text: `SELECT current_assignment.operator_assignment_id,current_assignment.current_generation
             FROM spaces_registry_credentials AS credential
             JOIN spaces_operator_instances AS instance
               ON instance.operator_instance_id=credential.operator_instance_id
              AND instance.status='active'
             JOIN spaces_operator_assignment_current AS current_assignment
               ON current_assignment.network=instance.network
              AND current_assignment.canonical_root=$2
              AND current_assignment.status='active'
             JOIN spaces_operator_assignment_revisions AS revision
               ON revision.operator_assignment_id=current_assignment.operator_assignment_id
              AND revision.operator_assignment_generation=current_assignment.current_generation
              AND revision.operator_instance_id=credential.operator_instance_id
            WHERE credential.credential_id=$1
              AND (credential.status='active'
                OR (credential.status='retiring'
                  AND credential.accept_until > clock_timestamp()))
              AND $2=ANY(credential.allowed_roots)`,
    values: [credential.credential_id, root],
    readonly: false,
  });
  const row = result.rows[0];
  if (row === undefined) return null;
  return yield* decoded(
    (): AssignedScope => ({
      assignmentId: text(row, "operator_assignment_id"),
      assignmentGeneration: integer(row, "current_generation"),
    }),
  );
});

/** The latest item of a key that any `/pending` response has included. */
const latestDeliveredItem = Effect.fn("spacesRegistryLatestDeliveredItem")(function* (
  transaction: Tx,
  input: Readonly<{ network: SpacesNetworkV1; root: string; label: string }>,
) {
  const result = yield* transaction.execute<Row>({
    label: "spaces-registry.item.latest-delivered.read",
    text: `SELECT claim_id FROM spaces_registry_items
            WHERE network=$1 AND namespace_root=$2 AND handle_label=$3
              AND delivery_generation > 0
            ORDER BY created_at DESC,claim_id DESC
            LIMIT 1`,
    values: [input.network, input.root, input.label],
    readonly: false,
  });
  const row = result.rows[0];
  return row === undefined ? null : yield* decoded(() => text(row, "claim_id"));
});

type LoadedIssuance = Readonly<{
  claimId: string;
  network: SpacesNetworkV1;
  root: string;
  label: string;
  scriptPubkeyHex: string;
  accountId: string;
  offeringId: string;
  deliveryGeneration: number;
  delivery: AssignedScope | null;
  state: SpacesIssuanceStateV1;
}>;

const claimState = (value: unknown): SpacesClaimStateV1 => {
  if (value !== "issuance_pending" && value !== "issued" && value !== "issuance_failed") {
    throw new Error("invalid Spaces claim state");
  }
  return value;
};

const ITEM_STATES: ReadonlySet<string> = new Set<SpacesRegistryItemStateV1>([
  "undelivered",
  "delivered",
  "redelivery_stopped",
  "settled_same_spk",
  "settled_different_spk",
  "settled_invalid",
  "withdrawn",
]);

const itemState = (value: unknown): SpacesRegistryItemStateV1 => {
  if (typeof value !== "string" || !ITEM_STATES.has(value)) {
    throw new Error("invalid Spaces registry item state");
  }
  return value as SpacesRegistryItemStateV1;
};

const capState = (claim: SpacesClaimStateV1): SpacesCapReservationStateV1 =>
  claim === "issuance_pending"
    ? "reserved"
    : claim === "issued"
      ? "converted_to_grant"
      : "released";

/**
 * Locks and reads the claim's item, claim, and verification rows, its latest
 * delivery, and its key fence. The caller holds the key lock, which every
 * fence writer takes first, so the fence cannot move underneath.
 */
const loadIssuance = Effect.fn("spacesRegistryLoadIssuance")(function* (
  transaction: Tx,
  claimId: string,
) {
  const result = yield* transaction.execute<Row>({
    label: "spaces-registry.issuance.lock",
    text: `SELECT item.claim_id,item.state AS item_state,item.delivery_generation,item.network,
                  item.namespace_root,item.handle_label,item.script_pubkey_hex,
                  claim.state AS claim_state,claim.actor_account_id,claim.offering_id,
                  verification.verification_due,
                  delivery.operator_assignment_id AS delivery_assignment_id,
                  delivery.operator_assignment_generation AS delivery_assignment_generation
             FROM spaces_registry_items AS item
             JOIN handle_claims AS claim ON claim.claim_id=item.claim_id
             JOIN spaces_issuance_verifications AS verification
               ON verification.claim_id=item.claim_id
             LEFT JOIN spaces_registry_deliveries AS delivery
               ON delivery.claim_id=item.claim_id
              AND delivery.delivery_generation=item.delivery_generation
            WHERE item.claim_id=$1
            FOR UPDATE OF item,claim,verification`,
    values: [claimId],
    readonly: false,
  });
  const row = result.rows[0];
  if (row === undefined) return null;
  const identity = yield* decoded(() => ({
    network: network(row, "network"),
    root: text(row, "namespace_root"),
    label: text(row, "handle_label"),
  }));
  const fence = yield* transaction.execute<Row>({
    label: "spaces-registry.key-fence.lock",
    text: `SELECT pending_claim_id,external_conflict_observation_id,permanent_grant_id
             FROM handle_key_fences
            WHERE family='spaces' AND namespace_root=$1 AND handle_label=$2
            FOR UPDATE`,
    values: [identity.root, identity.label],
    readonly: false,
  });
  const fenceRow = fence.rows[0];
  return yield* decoded((): LoadedIssuance => {
    const claim = claimState(row.claim_state);
    const fenceState: SpacesHandleKeyFenceStateV1 =
      fenceRow === undefined
        ? "released"
        : fenceRow.pending_claim_id === claimId
          ? "pending_issuance"
          : fenceRow.external_conflict_observation_id !== null
            ? "external_conflict"
            : fenceRow.permanent_grant_id !== null
              ? "permanent_grant"
              : "released";
    if (typeof row.verification_due !== "boolean") throw new Error("invalid verification");
    return {
      claimId,
      ...identity,
      scriptPubkeyHex: text(row, "script_pubkey_hex"),
      accountId: text(row, "actor_account_id"),
      offeringId: text(row, "offering_id"),
      deliveryGeneration: integer(row, "delivery_generation"),
      delivery:
        row.delivery_assignment_id === null
          ? null
          : {
              assignmentId: text(row, "delivery_assignment_id"),
              assignmentGeneration: integer(row, "delivery_assignment_generation"),
            },
      state: {
        claim,
        item: itemState(row.item_state),
        fence: fenceState,
        cap: capState(claim),
        verification_due: row.verification_due,
      },
    };
  });
});

type Applied = Extract<SpacesIssuanceDecisionV1, { kind: "applied" }>;
type ConflictEvidence = Readonly<{ acknowledgmentId: string }>;

/**
 * Writes one applied reducer decision: the item, the claim's terminal failure,
 * the key fence, the account-cap slot, and the verification schedule. Each
 * write is conditioned on the state that was read, so a lost race fails the
 * transaction instead of writing over it.
 */
const persistDecision = Effect.fn("spacesRegistryPersistDecision")(function* (
  transaction: Tx,
  loaded: LoadedIssuance,
  decision: Applied,
  context: Readonly<{
    now: unknown;
    failureReason: "handle_unavailable" | "invalid_handle" | "issuance_failed";
    conflict: ConflictEvidence | null;
  }>,
) {
  const { state } = loaded;
  const { next } = decision;
  if (next.item !== state.item) {
    const item = yield* transaction.execute({
      label: "spaces-registry.item.transition",
      text: `UPDATE spaces_registry_items
                SET state=$3,updated_at=GREATEST(updated_at,$4::timestamptz)
              WHERE claim_id=$1 AND state=$2`,
      values: [loaded.claimId, state.item, next.item, context.now],
      readonly: false,
    });
    yield* invariant(item.rowCount === 1);
  }
  if (next.claim !== state.claim) {
    yield* invariant(state.claim === "issuance_pending" && next.claim === "issuance_failed");
    const claim = yield* transaction.execute({
      label: "spaces-registry.claim.fail",
      text: `UPDATE handle_claims
                SET state='issuance_failed',safe_reason=$2,
                    updated_at=GREATEST(updated_at,$3::timestamptz)
              WHERE claim_id=$1 AND family='spaces' AND state='issuance_pending'`,
      values: [loaded.claimId, context.failureReason, context.now],
      readonly: false,
    });
    yield* invariant(claim.rowCount === 1);
  }
  if (next.fence !== state.fence) {
    yield* invariant(state.fence === "pending_issuance");
    if (next.fence === "released") {
      const released = yield* transaction.execute({
        label: "spaces-registry.key-fence.release",
        text: `DELETE FROM handle_key_fences
                WHERE family='spaces' AND namespace_root=$1 AND handle_label=$2
                  AND pending_claim_id=$3`,
        values: [loaded.root, loaded.label, loaded.claimId],
        readonly: false,
      });
      yield* invariant(released.rowCount === 1);
    } else {
      yield* invariant(next.fence === "external_conflict" && context.conflict !== null);
      const observationId = newId("srconflict");
      yield* transaction.execute({
        label: "spaces-registry.external-conflict.insert",
        text: `INSERT INTO spaces_external_conflict_observations (
                 observation_id,family,network,namespace_root,handle_label,evidence_kind,
                 registry_acknowledgment_id,observed_at
               ) VALUES ($1,'spaces',$2,$3,$4,'registry_acknowledgment_v1',$5,$6::timestamptz)`,
        values: [
          observationId,
          loaded.network,
          loaded.root,
          loaded.label,
          context.conflict?.acknowledgmentId,
          context.now,
        ],
        readonly: false,
      });
      const converted = yield* transaction.execute({
        label: "spaces-registry.key-fence.external-conflict",
        text: `UPDATE handle_key_fences
                  SET pending_claim_id=NULL,external_conflict_observation_id=$4,
                      updated_at=GREATEST(updated_at,$5::timestamptz)
                WHERE family='spaces' AND namespace_root=$1 AND handle_label=$2
                  AND pending_claim_id=$3`,
        values: [loaded.root, loaded.label, loaded.claimId, observationId, context.now],
        readonly: false,
      });
      yield* invariant(converted.rowCount === 1);
    }
  }
  if (decision.cap_change !== null) {
    yield* invariant(decision.cap_change === "release");
    yield* advisoryLock(
      transaction,
      CAP_LOCK_NAMESPACE,
      [loaded.accountId, loaded.offeringId],
      "spaces-registry.account-cap.lock",
    );
    const counter = yield* transaction.execute<Row>({
      label: "spaces-registry.account-cap.read",
      text: `SELECT active_grant_count,pending_issuance_count
               FROM handle_account_offering_grant_counters
              WHERE account_id=$1 AND offering_id=$2
              FOR UPDATE`,
      values: [loaded.accountId, loaded.offeringId],
      readonly: false,
    });
    const counterRow = counter.rows[0];
    const current = yield* decoded(() => {
      if (counterRow === undefined) throw new Error("missing Spaces cap counter");
      return {
        active_grant_count: integer(counterRow, "active_grant_count"),
        pending_issuance_count: integer(counterRow, "pending_issuance_count"),
      };
    });
    const released = yield* decoded(() => applySpacesCapChangeV1(current, "release"));
    const updated = yield* transaction.execute({
      label: "spaces-registry.account-cap.release",
      text: `UPDATE handle_account_offering_grant_counters
                SET pending_issuance_count=$3,updated_at=GREATEST(updated_at,$5::timestamptz)
              WHERE account_id=$1 AND offering_id=$2 AND pending_issuance_count=$4`,
      values: [
        loaded.accountId,
        loaded.offeringId,
        released.pending_issuance_count,
        current.pending_issuance_count,
        context.now,
      ],
      readonly: false,
    });
    yield* invariant(updated.rowCount === 1);
  }
  if (next.claim === "issuance_failed" && state.claim !== "issuance_failed") {
    const closed = yield* transaction.execute({
      label: "spaces-registry.verification.close",
      text: `UPDATE spaces_issuance_verifications
                SET status='closed',verification_due=false,
                    updated_at=GREATEST(updated_at,$2::timestamptz)
              WHERE claim_id=$1 AND status='pending'`,
      values: [loaded.claimId, context.now],
      readonly: false,
    });
    yield* invariant(closed.rowCount === 1);
  } else if (next.verification_due && !state.verification_due) {
    const due = yield* transaction.execute({
      label: "spaces-registry.verification.due",
      text: `UPDATE spaces_issuance_verifications
                SET verification_due=true,
                    next_verification_at=LEAST(next_verification_at,$2::timestamptz),
                    updated_at=GREATEST(updated_at,$2::timestamptz)
              WHERE claim_id=$1 AND status='pending'`,
      values: [loaded.claimId, context.now],
      readonly: false,
    });
    yield* invariant(due.rowCount === 1);
  }
  if (decision.alert === "invalid_outcome") {
    // The applied `invalid` acknowledgment row is the durable alert record;
    // intake validation should have made it impossible.
    yield* Effect.logWarning("Spaces registry acknowledged an invalid handle").pipe(
      Effect.annotateLogs({ claim_id: loaded.claimId }),
    );
  }
});

/**
 * Whether a delivery of the key other than this item's deliveries under the
 * acknowledging assignment is still unacknowledged. Such a delivery could
 * still stage and issue the name, so an `invalid` outcome keeps the fence.
 */
const unresolvedDeliveryRemains = Effect.fn("spacesRegistryUnresolvedDeliveryRemains")(function* (
  transaction: Tx,
  loaded: LoadedIssuance,
  assignmentId: string,
) {
  const result = yield* transaction.execute<Row>({
    label: "spaces-registry.deliveries.unresolved.read",
    text: `SELECT EXISTS (
               SELECT 1
                 FROM spaces_registry_deliveries AS delivery
                WHERE delivery.network=$1
                  AND delivery.namespace_root=$2
                  AND delivery.handle_label=$3
                  AND NOT (delivery.claim_id=$4 AND delivery.operator_assignment_id=$5)
                  AND NOT EXISTS (
                    SELECT 1
                      FROM spaces_registry_acknowledgments AS acknowledgment
                     WHERE acknowledgment.claim_id=delivery.claim_id
                       AND acknowledgment.operator_assignment_id=delivery.operator_assignment_id
                  )
             ) AS remains`,
    values: [loaded.network, loaded.root, loaded.label, loaded.claimId, assignmentId],
    readonly: false,
  });
  return one(result.rows, "unresolved deliveries").remains === true;
});

const OCCUPANCY: Readonly<
  Record<
    Exclude<Extract<SpacesRegistryAckEntryV1, { kind: "outcome" }>["outcome"], "invalid">,
    readonly ["staged" | "committed", "same_script" | "different_script"]
  >
> = {
  staged: ["staged", "same_script"],
  already_staged_same_spk: ["staged", "same_script"],
  already_committed_same_spk: ["committed", "same_script"],
  already_staged_different_spk: ["staged", "different_script"],
  already_committed_different_spk: ["committed", "different_script"],
};

type MatchedEntry = Readonly<{ loaded: LoadedIssuance; scope: AssignedScope }>;

/**
 * Resolves an entry's handle to the latest delivered item of its key within
 * the credential's scope, holding the key lock. Anything else is an anomaly;
 * a delivery under another operator-assignment generation is stale.
 */
const matchEntry = Effect.fn("spacesRegistryMatchEntry")(function* (
  transaction: Tx,
  input: Readonly<{
    credential: SpacesRegistryCredentialV1;
    endpoint: Endpoint;
    handle: string;
    subject: string;
  }>,
) {
  const anomaly = (reason: AnomalyReason) =>
    recordAnomaly(transaction, {
      credential: input.credential,
      endpoint: input.endpoint,
      reason,
      subject: input.subject,
    });
  const name = parseSpacesHandleV1(input.handle);
  if (name === null) return yield* anomaly("handle_unparseable");
  const scope = yield* assignedScope(transaction, input.credential, name.namespace_root);
  if (scope === null) return yield* anomaly("handle_out_of_scope");
  yield* advisoryLock(
    transaction,
    KEY_LOCK_NAMESPACE,
    ["spaces", name.namespace_root, name.handle_label],
    "spaces-registry.key.lock",
  );
  const claimId = yield* latestDeliveredItem(transaction, {
    network: input.credential.network,
    root: name.namespace_root,
    label: name.handle_label,
  });
  if (claimId === null) return yield* anomaly("no_delivered_item");
  const loaded = yield* loadIssuance(transaction, claimId);
  if (loaded === null || loaded.delivery === null)
    return yield* Effect.fail(storage("invalid-row"));
  if (
    loaded.delivery.assignmentId !== scope.assignmentId ||
    loaded.delivery.assignmentGeneration !== scope.assignmentGeneration
  ) {
    return "stale" as const;
  }
  return { loaded, scope } satisfies MatchedEntry;
});

const applyAcknowledgment = Effect.fn("spacesRegistryApplyAcknowledgment")(function* (
  transaction: Tx,
  credential: SpacesRegistryCredentialV1,
  entry: SpacesRegistryAckEntryV1,
) {
  if (entry.kind === "malformed") {
    return yield* recordAnomaly(transaction, {
      credential,
      endpoint: "ack",
      reason: "malformed_entry",
      subject: entry.raw,
    });
  }
  const subject = `${entry.handle}|${entry.outcome}`;
  const matched = yield* matchEntry(transaction, {
    credential,
    endpoint: "ack",
    handle: entry.handle,
    subject,
  });
  if (typeof matched === "string") return matched;
  const { loaded, scope } = matched;
  const decision = reduceSpacesIssuanceV1(loaded.state, {
    kind: "acknowledged",
    outcome: entry.outcome,
    unresolved_delivery_of_key_remains:
      entry.outcome === "invalid"
        ? yield* unresolvedDeliveryRemains(transaction, loaded, scope.assignmentId)
        : false,
  });
  if (decision.kind === "unchanged") return "unchanged" as const;
  if (decision.kind !== "applied") {
    return yield* recordAnomaly(transaction, {
      credential,
      endpoint: "ack",
      reason: decision.kind === "scope_anomaly" ? decision.reason : "claim_terminal",
      subject,
    });
  }
  const now = yield* databaseNow(transaction);
  const acknowledgmentId = newId("srack");
  yield* transaction.execute({
    label: "spaces-registry.acknowledgment.insert",
    text: `INSERT INTO spaces_registry_acknowledgments (
             acknowledgment_id,claim_id,delivery_generation,network,namespace_root,handle_label,
             outcome,credential_id,operator_instance_id,operator_assignment_id,
             operator_assignment_generation,received_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz)`,
    values: [
      acknowledgmentId,
      loaded.claimId,
      loaded.deliveryGeneration,
      loaded.network,
      loaded.root,
      loaded.label,
      entry.outcome,
      credential.credential_id,
      credential.operator_instance_id,
      scope.assignmentId,
      scope.assignmentGeneration,
      now,
    ],
    readonly: false,
  });
  if (entry.outcome !== "invalid") {
    const [occupancy, relation] = OCCUPANCY[entry.outcome];
    yield* transaction.execute({
      label: "spaces-registry.occupancy.insert",
      text: `INSERT INTO spaces_registry_occupancy_observations (
               occupancy_observation_id,network,namespace_root,handle_label,source_kind,
               registry_acknowledgment_id,occupancy,owner_relation,compared_script_pubkey_hex,
               observed_at
             ) VALUES ($1,$2,$3,$4,'registry_acknowledgment_v1',$5,$6,$7,$8,$9::timestamptz)`,
      values: [
        newId("srocc"),
        loaded.network,
        loaded.root,
        loaded.label,
        acknowledgmentId,
        occupancy,
        relation,
        loaded.scriptPubkeyHex,
        now,
      ],
      readonly: false,
    });
  }
  yield* persistDecision(transaction, loaded, decision, {
    now,
    failureReason: entry.outcome === "invalid" ? "invalid_handle" : "handle_unavailable",
    conflict: { acknowledgmentId },
  });
  return "applied" as const;
});

const applyCommitHint = Effect.fn("spacesRegistryApplyCommitHint")(function* (
  transaction: Tx,
  credential: SpacesRegistryCredentialV1,
  hintId: string,
  handle: string,
) {
  const matched = yield* matchEntry(transaction, {
    credential,
    endpoint: "committed",
    handle,
    subject: handle,
  });
  if (typeof matched === "string") return matched;
  const { loaded } = matched;
  yield* transaction.execute({
    label: "spaces-registry.commit-hint.claim.insert",
    text: `INSERT INTO spaces_registry_commit_hint_claims (commit_hint_id,claim_id)
           VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    values: [hintId, loaded.claimId],
    readonly: false,
  });
  const decision = reduceSpacesIssuanceV1(loaded.state, { kind: "committed_hint" });
  if (decision.kind === "unchanged") return "unchanged" as const;
  if (decision.kind !== "applied") {
    return yield* recordAnomaly(transaction, {
      credential,
      endpoint: "committed",
      reason: decision.kind === "scope_anomaly" ? decision.reason : "claim_terminal",
      subject: handle,
    });
  }
  // A hint only makes the claim due sooner; it never creates a grant.
  yield* persistDecision(transaction, loaded, decision, {
    now: yield* databaseNow(transaction),
    failureReason: "issuance_failed",
    conflict: null,
  });
  return "applied" as const;
});

const DELIVERY_ONLY_STATE = {
  fence: "pending_issuance",
  cap: "reserved",
  verification_due: false,
} as const;

function makeControlPlaneSpacesRegistryRepository() {
  return {
    authenticate: (input: Parameters<SpacesRegistryStore["authenticate"]>[0]) =>
      Effect.gen(function* () {
        const presented = spacesRegistryTokenVerifierV1(input.token);
        const credentialId = spacesRegistryTokenCredentialIdV1(input.token);
        if (credentialId === null) return null;
        const db = yield* ControlPlaneDb;
        const result = yield* mapped(
          db.execute<Row>({
            label: "spaces-registry.credential.authenticate",
            text: `SELECT credential.credential_id,credential.operator_instance_id,
                          credential.environment,credential.allowed_roots,
                          credential.verifier_sha256_hex,instance.network,
                          (credential.status='active'
                            OR (credential.status='retiring'
                              AND credential.accept_until > clock_timestamp())) AS accepted,
                          instance.status='active' AS instance_active
                     FROM spaces_registry_credentials AS credential
                     JOIN spaces_operator_instances AS instance
                       ON instance.operator_instance_id=credential.operator_instance_id
                    WHERE credential.credential_id=$1`,
            values: [credentialId],
            readonly: true,
          }),
        );
        const row = result.rows[0];
        const stored = typeof row?.verifier_sha256_hex === "string" ? row.verifier_sha256_hex : "";
        const matches = spacesRegistryVerifierMatchesV1(presented, stored);
        if (
          row === undefined ||
          !matches ||
          row.accepted !== true ||
          row.instance_active !== true ||
          row.environment !== input.environment
        ) {
          return null;
        }
        return yield* decoded(
          (): SpacesRegistryCredentialV1 => ({
            credential_id: text(row, "credential_id"),
            operator_instance_id: text(row, "operator_instance_id"),
            network: network(row, "network"),
            allowed_roots: [...stringArray(row.allowed_roots)],
          }),
        );
      }),

    pending: (input: Parameters<SpacesRegistryStore["pending"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* mapped(
          db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const { credential, space } = input;
              if (space.kind !== "root") {
                yield* recordAnomaly(transaction, {
                  credential,
                  endpoint: "pending",
                  reason: space.kind === "numeric" ? "numeric_space" : "invalid_space",
                  subject: space.raw,
                });
                return FORBIDDEN;
              }
              const root = space.canonical_root;
              const scope = yield* assignedScope(transaction, credential, root);
              if (scope === null) {
                yield* recordAnomaly(transaction, {
                  credential,
                  endpoint: "pending",
                  reason: "space_not_assigned",
                  subject: `@${root}`,
                });
                return FORBIDDEN;
              }
              // Assigned but not active and ready: the operator adopts a
              // delegated space on the first handle it stages, so nothing is
              // served until the activation is effective under this assignment.
              const ready = yield* transaction.execute<Row>({
                label: "spaces-registry.pending.activation.read",
                text: `SELECT effective.sale_namespace_activation_id
                         FROM community_handle_sale_namespace_activation_current AS current_activation
                         JOIN LATERAL effective_community_handle_sale_namespace_v1(
                           current_activation.sale_namespace_activation_id,clock_timestamp()
                         ) AS effective ON TRUE
                        WHERE current_activation.family='spaces'
                          AND current_activation.canonical_root=$1
                          AND effective.family='spaces'
                          AND effective.spaces_network=$2
                          AND effective.spaces_operator_assignment_id=$3
                          AND effective.spaces_operator_assignment_generation=$4`,
                values: [root, credential.network, scope.assignmentId, scope.assignmentGeneration],
                readonly: false,
              });
              if (ready.rows.length === 0) return NO_HANDLES;
              const selected = yield* transaction.execute<Row>({
                label: "spaces-registry.pending.items.lock",
                text: `SELECT item.claim_id,item.state,claim.state AS claim_state
                         FROM spaces_registry_items AS item
                         JOIN handle_claims AS claim ON claim.claim_id=item.claim_id
                        WHERE item.network=$1 AND item.namespace_root=$2
                          AND item.state IN ('undelivered','delivered')
                          AND claim.state='issuance_pending'
                        ORDER BY item.created_at,item.claim_id
                        LIMIT $3
                        FOR UPDATE OF item,claim`,
                values: [credential.network, root, input.capacity],
                readonly: false,
              });
              const claimIds = yield* decoded(() =>
                selected.rows
                  .filter(
                    (row) =>
                      reduceSpacesIssuanceV1(
                        {
                          ...DELIVERY_ONLY_STATE,
                          claim: claimState(row.claim_state),
                          item: itemState(row.state),
                        },
                        { kind: "delivery_recorded" },
                      ).kind === "applied",
                  )
                  .map((row) => text(row, "claim_id")),
              );
              if (claimIds.length === 0) return NO_HANDLES;
              const now = yield* databaseNow(transaction);
              const advanced = yield* transaction.execute<Row>({
                label: "spaces-registry.pending.items.deliver",
                text: `UPDATE spaces_registry_items AS item
                          SET state='delivered',
                              delivery_generation=item.delivery_generation+1,
                              last_delivered_at=GREATEST(
                                $2::timestamptz,COALESCE(item.last_delivered_at,item.created_at)
                              ),
                              updated_at=GREATEST(item.updated_at,$2::timestamptz)
                        WHERE item.claim_id=ANY($1::text[])
                          AND item.state IN ('undelivered','delivered')
                        RETURNING item.claim_id,item.handle,item.script_pubkey_hex`,
                values: [claimIds, now],
                readonly: false,
              });
              yield* invariant(advanced.rowCount === claimIds.length);
              const recorded = yield* transaction.execute({
                label: "spaces-registry.pending.deliveries.insert",
                text: `INSERT INTO spaces_registry_deliveries (
                         claim_id,delivery_generation,network,namespace_root,handle_label,
                         credential_id,operator_instance_id,operator_assignment_id,
                         operator_assignment_generation,delivered_at
                       )
                       SELECT item.claim_id,item.delivery_generation,item.network,
                              item.namespace_root,item.handle_label,$2,$3,$4,$5,
                              item.last_delivered_at
                         FROM spaces_registry_items AS item
                        WHERE item.claim_id=ANY($1::text[])`,
                values: [
                  claimIds,
                  credential.credential_id,
                  credential.operator_instance_id,
                  scope.assignmentId,
                  scope.assignmentGeneration,
                ],
                readonly: false,
              });
              yield* invariant(recorded.rowCount === claimIds.length);
              const byClaim = new Map(advanced.rows.map((row) => [row.claim_id, row]));
              const handles = yield* decoded(() =>
                claimIds.map((claimId) => {
                  const row = byClaim.get(claimId);
                  if (row === undefined) throw new Error("missing delivered item");
                  return {
                    handle: text(row, "handle"),
                    script_pubkey: text(row, "script_pubkey_hex"),
                  };
                }),
              );
              return { kind: "handles", handles } satisfies SpacesRegistryPendingResultV1;
            }),
          ),
        );
      }),

    acknowledge: (input: Parameters<SpacesRegistryStore["acknowledge"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* mapped(
          db.withTransaction((transaction) =>
            applyAcknowledgment(transaction, input.credential, input.entry),
          ),
        );
      }),

    committed: (input: Parameters<SpacesRegistryStore["committed"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const hintId = newId("srhint");
        yield* mapped(
          db.withTransaction((transaction) =>
            transaction.execute({
              label: "spaces-registry.commit-hint.insert",
              text: `INSERT INTO spaces_registry_commit_hints (
                       commit_hint_id,credential_id,operator_instance_id,network,
                       commitment_root_hex,reported_handle_count,received_at
                     ) VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp())`,
              values: [
                hintId,
                input.credential.credential_id,
                input.credential.operator_instance_id,
                input.credential.network,
                input.commitment_root_hex,
                input.handles.length,
              ],
              readonly: false,
            }),
          ),
        );
        return yield* Effect.forEach(
          input.handles,
          (handle) =>
            mapped(
              db.withTransaction((transaction) =>
                applyCommitHint(transaction, input.credential, hintId, handle),
              ),
            ),
          { concurrency: 1 },
        );
      }),

    stopClaim: (input: Parameters<SpacesRegistryStore["stopClaim"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* mapped(
          db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const key = yield* transaction.execute<Row>({
                label: "spaces-registry.stop.item.read",
                text: `SELECT namespace_root,handle_label FROM spaces_registry_items
                        WHERE claim_id=$1`,
                values: [input.claimId],
                readonly: false,
              });
              const keyRow = key.rows[0];
              if (keyRow === undefined) {
                return { kind: "not_found" } satisfies SpacesRegistryStopResultV1;
              }
              yield* advisoryLock(
                transaction,
                KEY_LOCK_NAMESPACE,
                [
                  "spaces",
                  yield* decoded(() => text(keyRow, "namespace_root")),
                  yield* decoded(() => text(keyRow, "handle_label")),
                ],
                "spaces-registry.stop.key.lock",
              );
              const loaded = yield* loadIssuance(transaction, input.claimId);
              if (loaded === null) return yield* Effect.fail(storage("invalid-row"));
              const decision = reduceSpacesIssuanceV1(loaded.state, { kind: "platform_stop" });
              if (decision.kind !== "applied") {
                return { kind: "unchanged" } satisfies SpacesRegistryStopResultV1;
              }
              yield* persistDecision(transaction, loaded, decision, {
                now: yield* databaseNow(transaction),
                failureReason: "issuance_failed",
                conflict: null,
              });
              return {
                kind: decision.next.item === "withdrawn" ? "withdrawn" : "redelivery_stopped",
              } satisfies SpacesRegistryStopResultV1;
            }),
          ),
        );
      }),
  };
}

export function makeControlPlaneSpacesRegistryStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): SpacesRegistryStore {
  const repository = makeControlPlaneSpacesRegistryRepository();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    mapped(Effect.provide(runtime)(effect));
  const store = {
    authenticate: (input: Parameters<SpacesRegistryStore["authenticate"]>[0]) =>
      provide(repository.authenticate(input)),
    pending: (input: Parameters<SpacesRegistryStore["pending"]>[0]) =>
      provide(repository.pending(input)),
    acknowledge: (input: Parameters<SpacesRegistryStore["acknowledge"]>[0]) =>
      provide(repository.acknowledge(input)),
    committed: (input: Parameters<SpacesRegistryStore["committed"]>[0]) =>
      provide(repository.committed(input)),
    stopClaim: (input: Parameters<SpacesRegistryStore["stopClaim"]>[0]) =>
      provide(repository.stopClaim(input)),
  };
  // The repository maps every ControlPlaneError before this boundary. The
  // assertion hides only Effect's conservative union left by withTransaction.
  return store as unknown as SpacesRegistryStore;
}
