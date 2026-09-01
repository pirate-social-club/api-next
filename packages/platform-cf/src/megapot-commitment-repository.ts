import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  type MegapotCommitmentCandidate,
  type MegapotCommitmentFailure,
  type MegapotCommitmentProgress,
  MegapotCommitmentRejected,
  MegapotCommitmentStorageFailed,
  type MegapotCommitmentStore,
} from "@pirate/application";
import {
  MEGAPOT_BENEFICIARY_ALGORITHM_VERSION,
  MEGAPOT_SNAPSHOT_DOMAIN,
  type MegapotPublishedSnapshot,
} from "@pirate/domain";
import { Effect, type Layer } from "effect";
import { mapMegapotStorageFailure } from "./control-plane-error-classification.ts";

type Row = Readonly<Record<string, unknown>>;

const storage = (reason: MegapotCommitmentStorageFailed["reason"]) =>
  new MegapotCommitmentStorageFailed({ reason });
const rejected = (reason: MegapotCommitmentRejected["reason"]) =>
  new MegapotCommitmentRejected({ reason });

const mapped = <A, E, R>(effect: Effect.Effect<A, E | ControlPlaneError, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      mapMegapotStorageFailure<E, MegapotCommitmentStorageFailed>(error, storage),
    ),
  );

function text(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
  return value;
}

function nullableText(row: Row, field: string): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
  return value;
}

function integer(row: Row, field: string): number {
  const value = row[field];
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid ${field}`);
  return parsed;
}

function bigint(row: Row, field: string): bigint {
  const value = row[field];
  if (
    (typeof value !== "string" && typeof value !== "bigint" && typeof value !== "number") ||
    !/^[0-9]+$/u.test(String(value))
  ) {
    throw new Error(`invalid ${field}`);
  }
  return BigInt(value);
}

function bool(row: Row, field: string): boolean {
  const value = row[field];
  if (typeof value !== "boolean") throw new Error(`invalid ${field}`);
  return value;
}

function instant(row: Row, field: string): string {
  const value = row[field];
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  throw new Error(`invalid ${field}`);
}

function nullableInstant(row: Row, field: string): string | null {
  return row[field] === null || row[field] === undefined ? null : instant(row, field);
}

function stringArray(row: Row, field: string): readonly string[] {
  const value = row[field];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string")
  ) {
    throw new Error(`invalid ${field}`);
  }
  return value as readonly string[];
}

function snapshotFromRow(row: Row): MegapotPublishedSnapshot {
  const domain = text(row, "domain");
  const algorithmVersion = text(row, "algorithm_version");
  if (
    domain !== MEGAPOT_SNAPSHOT_DOMAIN ||
    algorithmVersion !== MEGAPOT_BENEFICIARY_ALGORITHM_VERSION
  ) {
    throw new Error("invalid snapshot version");
  }
  return {
    domain,
    poolLegId: text(row, "pool_leg_id"),
    drawingId: text(row, "drawing_id"),
    termsHash: text(row, "terms_hash"),
    algorithmVersion,
    fallback: bool(row, "fallback"),
    leafCount: integer(row, "leaf_count"),
    leafCommitments: stringArray(row, "leaf_commitments"),
    snapshotHash: text(row, "snapshot_hash"),
  };
}

function candidateFromRow(row: Row): MegapotCommitmentCandidate {
  return {
    poolLegId: text(row, "pool_leg_id"),
    drawingId: bigint(row, "drawing_id"),
    drawingVersion: integer(row, "drawing_version"),
    canPrepare: text(row, "drawing_status") === "cutoff_frozen",
    snapshotId: text(row, "snapshot_id"),
    snapshot: snapshotFromRow(row),
  };
}

function progressFromRow(row: Row): MegapotCommitmentProgress {
  const state = text(row, "commitment_state");
  if (state !== "prepared" && state !== "published") throw new Error("invalid commitment state");
  return {
    commitmentEffectId: text(row, "commitment_effect_id"),
    poolLegId: text(row, "pool_leg_id"),
    drawingId: bigint(row, "drawing_id"),
    drawingVersion: integer(row, "drawing_version"),
    snapshotId: text(row, "snapshot_id"),
    snapshot: snapshotFromRow(row),
    payloadHash: text(row, "payload_hash"),
    signingKeyId: text(row, "signing_key_id"),
    signature: text(row, "signature"),
    state,
    preparedAt: instant(row, "prepared_at"),
    publishedAt: nullableInstant(row, "published_at"),
    publicReference: nullableText(row, "public_reference"),
  };
}

const SNAPSHOT_SELECT = `
  SELECT drawing.pool_leg_id, drawing.drawing_id::text, drawing.version AS drawing_version,
         drawing.status AS drawing_status, snapshot.snapshot_id, snapshot.domain,
         snapshot.terms_hash, snapshot.algorithm_version, snapshot.fallback,
         snapshot.leaf_count, snapshot.snapshot_hash,
         ARRAY(
           SELECT leaf.leaf_commitment
             FROM megapot_pool_snapshot_private_leaves leaf
            WHERE leaf.snapshot_id=snapshot.snapshot_id ORDER BY leaf.ordinal
         ) AS leaf_commitments
    FROM megapot_pool_drawings drawing
    JOIN megapot_pool_beneficiary_snapshots snapshot
      ON snapshot.snapshot_id=drawing.snapshot_id`;

const PROGRESS_SELECT = `
  SELECT commitment.commitment_effect_id, commitment.payload_hash,
         commitment.signing_key_id, commitment.signature,
         commitment.state AS commitment_state, commitment.prepared_at,
         commitment.published_at, commitment.public_reference,
         drawing.pool_leg_id, drawing.drawing_id::text,
         drawing.version AS drawing_version, drawing.status AS drawing_status,
         snapshot.snapshot_id, snapshot.domain, snapshot.terms_hash,
         snapshot.algorithm_version, snapshot.fallback, snapshot.leaf_count,
         snapshot.snapshot_hash,
         ARRAY(
           SELECT leaf.leaf_commitment
             FROM megapot_pool_snapshot_private_leaves leaf
            WHERE leaf.snapshot_id=snapshot.snapshot_id ORDER BY leaf.ordinal
         ) AS leaf_commitments
    FROM megapot_pool_commitment_effects commitment
    JOIN megapot_pool_beneficiary_snapshots snapshot
      ON snapshot.snapshot_id=commitment.snapshot_id
    JOIN megapot_pool_drawings drawing
      ON drawing.snapshot_id=snapshot.snapshot_id`;

function loadCandidateIn(
  transaction: ControlPlaneTransaction,
  input: { readonly poolLegId: string; readonly drawingId: bigint; readonly lock: boolean },
): Effect.Effect<MegapotCommitmentCandidate, MegapotCommitmentFailure | ControlPlaneError> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "megapot-commitment.candidate.read",
      text: `${SNAPSHOT_SELECT}
              WHERE drawing.pool_leg_id=$1 AND drawing.drawing_id=$2
                AND drawing.snapshot_id IS NOT NULL
              ${input.lock ? "FOR UPDATE OF drawing" : ""}`,
      values: [input.poolLegId, input.drawingId.toString()],
      readonly: !input.lock,
    });
    if (result.rows.length !== 1) return yield* rejected("drawing-not-frozen");
    return yield* Effect.try({
      try: () => candidateFromRow(result.rows[0] as Row),
      catch: () => storage("invalid-row"),
    });
  });
}

function readProgressIn(
  transaction: ControlPlaneTransaction,
  commitmentEffectId: string,
): Effect.Effect<
  MegapotCommitmentProgress | null,
  MegapotCommitmentStorageFailed | ControlPlaneError
> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "megapot-commitment.progress.read",
      text: `${PROGRESS_SELECT} WHERE commitment.commitment_effect_id=$1`,
      values: [commitmentEffectId],
      readonly: true,
    });
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) return yield* storage("invalid-row");
    return yield* Effect.try({
      try: () => progressFromRow(result.rows[0] as Row),
      catch: () => storage("invalid-row"),
    });
  });
}

function sameCandidate(
  left: MegapotCommitmentCandidate,
  right: MegapotCommitmentCandidate,
): boolean {
  return (
    left.poolLegId === right.poolLegId &&
    left.drawingId === right.drawingId &&
    left.drawingVersion === right.drawingVersion &&
    left.snapshotId === right.snapshotId &&
    JSON.stringify(left.snapshot) === JSON.stringify(right.snapshot)
  );
}

export function makeControlPlaneMegapotCommitmentRepository() {
  return {
    loadCandidate: (input: Parameters<MegapotCommitmentStore["loadCandidate"]>[0]) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* loadCandidateIn(db, { ...input, lock: false });
        }),
      ),

    findProgress: (commitmentEffectId: string) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* readProgressIn(db, commitmentEffectId);
        }),
      ),

    prepare: (input: Parameters<MegapotCommitmentStore["prepare"]>[0]) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const current = yield* loadCandidateIn(transaction, {
                poolLegId: input.candidate.poolLegId,
                drawingId: input.candidate.drawingId,
                lock: true,
              });
              if (!sameCandidate(current, input.candidate) || !current.canPrepare) {
                return yield* rejected("commitment-conflict");
              }
              const existing = yield* readProgressIn(transaction, input.commitmentEffectId);
              if (existing !== null) {
                if (
                  existing.snapshotId !== current.snapshotId ||
                  existing.payloadHash !== input.payloadHash ||
                  existing.signingKeyId !== input.signingKeyId ||
                  existing.signature !== input.signature
                ) {
                  return yield* rejected("payload-conflict");
                }
                return existing;
              }
              yield* transaction.execute({
                label: "megapot-commitment.prepare",
                text: `INSERT INTO megapot_pool_commitment_effects (
                         commitment_effect_id, snapshot_id, payload_hash,
                         signing_key_id, signature, state, prepared_at
                       ) VALUES ($1,$2,$3,$4,$5,'prepared',$6::timestamptz)`,
                values: [
                  input.commitmentEffectId,
                  current.snapshotId,
                  input.payloadHash,
                  input.signingKeyId,
                  input.signature,
                  input.preparedAt,
                ],
                readonly: false,
              });
              const prepared = yield* readProgressIn(transaction, input.commitmentEffectId);
              if (prepared === null) return yield* storage("invalid-row");
              return prepared;
            }),
          );
        }),
      ),

    confirmPublished: (input: Parameters<MegapotCommitmentStore["confirmPublished"]>[0]) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const locked = yield* transaction.execute<Row>({
                label: "megapot-commitment.publish.lock",
                text: `SELECT commitment.snapshot_id, commitment.payload_hash,
                              commitment.state AS commitment_state,
                              commitment.public_reference, drawing.pool_leg_id,
                              drawing.drawing_id, drawing.version AS drawing_version,
                              drawing.status AS drawing_status,
                              drawing.commitment_effect_id
                         FROM megapot_pool_commitment_effects commitment
                         JOIN megapot_pool_drawings drawing
                           ON drawing.snapshot_id=commitment.snapshot_id
                        WHERE commitment.commitment_effect_id=$1
                        FOR UPDATE OF commitment, drawing`,
                values: [input.commitmentEffectId],
                readonly: false,
              });
              if (locked.rows.length !== 1) return yield* rejected("commitment-conflict");
              const row = locked.rows[0] as Row;
              if (text(row, "payload_hash") !== input.payloadHash) {
                return yield* rejected("payload-conflict");
              }
              if (text(row, "commitment_state") === "published") {
                if (nullableText(row, "public_reference") !== input.publicReference) {
                  return yield* rejected("payload-conflict");
                }
                const replay = yield* readProgressIn(transaction, input.commitmentEffectId);
                if (replay === null) return yield* storage("invalid-row");
                return replay;
              }
              if (text(row, "drawing_status") !== "cutoff_frozen") {
                return yield* rejected("drawing-not-frozen");
              }
              yield* transaction.execute({
                label: "megapot-commitment.publish",
                text: `UPDATE megapot_pool_commitment_effects
                          SET state='published', published_at=$2::timestamptz,
                              public_reference=$3
                        WHERE commitment_effect_id=$1 AND state='prepared'`,
                values: [input.commitmentEffectId, input.publishedAt, input.publicReference],
                readonly: false,
              });
              const nextVersion = integer(row, "drawing_version") + 1;
              yield* transaction.execute({
                label: "megapot-commitment.drawing-transition.create",
                text: `INSERT INTO megapot_pool_drawing_transitions (
                         pool_leg_id, drawing_id, target_version, event_type, event
                       ) VALUES ($1,$2,$3,'commitment_published',$4::jsonb)`,
                values: [
                  text(row, "pool_leg_id"),
                  bigint(row, "drawing_id").toString(),
                  nextVersion,
                  JSON.stringify({
                    type: "commitment_published",
                    commitment_effect_id: input.commitmentEffectId,
                    public_reference: input.publicReference,
                  }),
                ],
                readonly: false,
              });
              const drawing = yield* transaction.execute({
                label: "megapot-commitment.drawing.commit",
                text: `UPDATE megapot_pool_drawings
                          SET status='committed', version=$3, commitment_effect_id=$4,
                              updated_at=clock_timestamp()
                        WHERE pool_leg_id=$1 AND drawing_id=$2
                          AND status='cutoff_frozen' AND version=$3-1`,
                values: [
                  text(row, "pool_leg_id"),
                  bigint(row, "drawing_id").toString(),
                  nextVersion,
                  input.commitmentEffectId,
                ],
                readonly: false,
              });
              if (drawing.rowCount !== 1) return yield* rejected("commitment-conflict");
              const published = yield* readProgressIn(transaction, input.commitmentEffectId);
              if (published === null) return yield* storage("invalid-row");
              return published;
            }),
          );
        }),
      ),
  };
}

export const makeControlPlaneMegapotCommitmentStore = (
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): MegapotCommitmentStore => {
  const repository = makeControlPlaneMegapotCommitmentRepository();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    mapped(Effect.provide(layer)(effect));
  return {
    loadCandidate: (input) => provide(repository.loadCandidate(input)),
    findProgress: (commitmentEffectId) => provide(repository.findProgress(commitmentEffectId)),
    prepare: (input) => provide(repository.prepare(input)),
    confirmPublished: (input) => provide(repository.confirmPublished(input)),
  };
};
