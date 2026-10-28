import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import { buildMegapotBeneficiarySnapshot } from "@pirate/domain";
import { Data, Effect, type Layer } from "effect";
import { sha256 } from "viem";
import { mapMegapotStorageFailure } from "./control-plane-error-classification.ts";

type Row = Readonly<Record<string, unknown>>;

export class MegapotTicketFirstCutoffFailed extends Data.TaggedError(
  "MegapotTicketFirstCutoffFailed",
)<{
  readonly reason:
    | "conflict"
    | "constraint"
    | "cutoff-conflict"
    | "invalid-config"
    | "invalid-row"
    | "outcome-unknown"
    | "unavailable";
}> {}

const failed = (reason: MegapotTicketFirstCutoffFailed["reason"]) =>
  new MegapotTicketFirstCutoffFailed({ reason });

const mapped = <A, E, R>(effect: Effect.Effect<A, E | ControlPlaneError, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      mapMegapotStorageFailure<E, MegapotTicketFirstCutoffFailed>(error, failed),
    ),
  );

function text(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
  return value;
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

type Beneficiary = Readonly<{ accountId: string; personaId: string }>;

function sameBeneficiaries(left: readonly Beneficiary[], right: readonly Beneficiary[]): boolean {
  const normalize = (values: readonly Beneficiary[]) =>
    values
      .map((value) => `${value.accountId}\u0000${value.personaId}`)
      .sort()
      .join("\u0001");
  return normalize(left) === normalize(right);
}

/**
 * Cutoff for ticket-first drawings. Their ticket was bought and its cost spent before
 * entries opened, so the freeze reserves nothing. With qualifiers it freezes the same
 * canonical beneficiary snapshot as commit-first drawings. A new single-funder
 * profile freezes its funder when no one qualifies; historical terms still hold
 * an empty drawing. The policy and identity are fixed before the contribution.
 */
export function makeMegapotTicketFirstCutoff(options: {
  readonly layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>;
  /** Only drawings of this attestation's legs are selected, locked and frozen. */
  readonly attestationId: string;
  readonly now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const provide = <A, E>(effect: Effect.Effect<A, E | ControlPlaneError, ControlPlaneDb>) =>
    mapped(Effect.provide(options.layer)(effect));

  const freezeOne = (input: {
    readonly poolLegId: string;
    readonly drawingId: bigint;
    readonly version: number;
    readonly termsHash: string;
    readonly shares: readonly Beneficiary[];
    readonly frozenAt: string;
  }) =>
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          const current = yield* transaction.execute<Row>({
            label: "megapot-ticket-first-cutoff.drawing.lock",
            text: `SELECT drawing.version, leg.leg_terms_hash,
                          leg.shared_song_terms_v2->>'empty_behavior' AS empty_behavior,
                          leg.fallback_beneficiary_account_id,leg.fallback_payout_persona_id
                     FROM megapot_pool_drawings drawing
                     JOIN song_reward_offer_legs leg ON leg.leg_id=drawing.pool_leg_id
                    WHERE drawing.pool_leg_id=$1 AND drawing.drawing_id=$2
                      AND drawing.purchase_order='ticket_first_v1'
                      AND drawing.status='entry_open'
                      AND drawing.entry_cutoff_at <= $3::timestamptz
                      AND leg.attestation_id=$4
                    FOR UPDATE OF drawing`,
            values: [
              input.poolLegId,
              input.drawingId.toString(),
              input.frozenAt,
              options.attestationId,
            ],
            readonly: false,
          });
          if (current.rows.length !== 1) return yield* failed("cutoff-conflict");
          const row = current.rows[0] as Row;
          if (
            Number(bigint(row, "version")) !== input.version ||
            text(row, "leg_terms_hash") !== input.termsHash
          ) {
            return yield* failed("cutoff-conflict");
          }
          const locked = yield* transaction.execute<Row>({
            label: "megapot-ticket-first-cutoff.shares.lock",
            text: `SELECT account_id, persona_id FROM megapot_pool_shares
                    WHERE pool_leg_id=$1 AND drawing_id=$2
                    ORDER BY account_id, persona_id FOR SHARE`,
            values: [input.poolLegId, input.drawingId.toString()],
            readonly: false,
          });
          const shares = locked.rows.map((share) => ({
            accountId: text(share, "account_id"),
            personaId: text(share, "persona_id"),
          }));
          if (!sameBeneficiaries(shares, input.shares)) return yield* failed("cutoff-conflict");
          const fallback =
            shares.length === 0 && row.empty_behavior === "single_funder_ticket_first_v1";
          const beneficiaries = fallback
            ? [
                {
                  accountId: text(row, "fallback_beneficiary_account_id"),
                  personaId: text(row, "fallback_payout_persona_id"),
                },
              ]
            : shares;
          const snapshot =
            beneficiaries.length === 0
              ? null
              : buildMegapotBeneficiarySnapshot({
                  poolLegId: input.poolLegId,
                  drawingId: input.drawingId,
                  termsHash: input.termsHash,
                  fallback,
                  beneficiaries,
                  sha256: (bytes) => sha256(bytes, "bytes"),
                });
          const nextVersion = input.version + 1;
          if (snapshot === null) {
            yield* transaction.execute({
              label: "megapot-ticket-first-cutoff.hold-transition.create",
              text: `INSERT INTO megapot_pool_drawing_transitions (
                       pool_leg_id, drawing_id, target_version, event_type, event
                     ) VALUES ($1,$2,$3,'cutoff',$4::jsonb)`,
              values: [
                input.poolLegId,
                input.drawingId.toString(),
                nextVersion,
                JSON.stringify({
                  type: "cutoff",
                  outcome: "operational_hold",
                  reason: "empty_ticketed_drawing",
                }),
              ],
              readonly: false,
            });
            const held = yield* transaction.execute({
              label: "megapot-ticket-first-cutoff.drawing.hold",
              text: `UPDATE megapot_pool_drawings
                        SET status='operational_hold', version=$3, frozen_share_count=0,
                            fallback_beneficiary=false, terminal_reason='empty_ticketed_drawing',
                            cutoff_frozen_at=$4::timestamptz, terminal_at=$4::timestamptz,
                            updated_at=clock_timestamp()
                      WHERE pool_leg_id=$1 AND drawing_id=$2 AND version=$3-1`,
              values: [input.poolLegId, input.drawingId.toString(), nextVersion, input.frozenAt],
              readonly: false,
            });
            if (held.rowCount !== 1) return yield* failed("cutoff-conflict");
            return {
              poolLegId: input.poolLegId,
              drawingId: input.drawingId,
              status: "held",
            } as const;
          }
          const snapshotId = `megapot_snapshot_${snapshot.published.snapshotHash.slice(2)}`;
          yield* transaction.execute({
            label: "megapot-ticket-first-cutoff.snapshot.create",
            text: `INSERT INTO megapot_pool_beneficiary_snapshots (
                     snapshot_id, pool_leg_id, drawing_id, domain, terms_hash,
                     algorithm_version, fallback, leaf_count, snapshot_hash,
                     published_artifact, frozen_at
                   ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::timestamptz)`,
            values: [
              snapshotId,
              input.poolLegId,
              input.drawingId.toString(),
              snapshot.published.domain,
              snapshot.published.termsHash,
              snapshot.published.algorithmVersion,
              snapshot.published.fallback,
              snapshot.published.leafCount,
              snapshot.published.snapshotHash,
              JSON.stringify(snapshot.published),
              input.frozenAt,
            ],
            readonly: false,
          });
          for (const [ordinal, leaf] of snapshot.privateLeaves.entries()) {
            yield* transaction.execute({
              label: "megapot-ticket-first-cutoff.snapshot-leaf.create",
              text: `INSERT INTO megapot_pool_snapshot_private_leaves (
                       snapshot_id, ordinal, account_id, persona_id, order_key, leaf_commitment
                     ) VALUES ($1,$2,$3,$4,$5,$6)`,
              values: [
                snapshotId,
                ordinal,
                leaf.accountId,
                leaf.personaId,
                leaf.orderKey,
                leaf.leafCommitment,
              ],
              readonly: false,
            });
          }
          yield* transaction.execute({
            label: "megapot-ticket-first-cutoff.freeze-transition.create",
            text: `INSERT INTO megapot_pool_drawing_transitions (
                     pool_leg_id, drawing_id, target_version, event_type, event
                   ) VALUES ($1,$2,$3,'cutoff',$4::jsonb)`,
            values: [
              input.poolLegId,
              input.drawingId.toString(),
              nextVersion,
              JSON.stringify({
                type: "cutoff",
                snapshot_hash: snapshot.published.snapshotHash,
                fallback,
                share_count: shares.length,
              }),
            ],
            readonly: false,
          });
          const frozen = yield* transaction.execute({
            label: "megapot-ticket-first-cutoff.drawing.freeze",
            text: `UPDATE megapot_pool_drawings
                      SET status='cutoff_frozen', version=$3, frozen_share_count=$4,
                          fallback_beneficiary=$7, snapshot_id=$5,
                          cutoff_frozen_at=$6::timestamptz, updated_at=clock_timestamp()
                    WHERE pool_leg_id=$1 AND drawing_id=$2 AND version=$3-1`,
            values: [
              input.poolLegId,
              input.drawingId.toString(),
              nextVersion,
              shares.length,
              snapshotId,
              input.frozenAt,
              fallback,
            ],
            readonly: false,
          });
          if (frozen.rowCount !== 1) return yield* failed("cutoff-conflict");
          return {
            poolLegId: input.poolLegId,
            drawingId: input.drawingId,
            status: "cutoff_frozen",
            snapshotId,
          } as const;
        }),
      );
    });

  const freezeDue = Effect.fn("MegapotTicketFirstCutoff.freezeDue")(function* (limit = 50) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      return yield* failed("invalid-config");
    }
    const frozenAt = new Date(now()).toISOString();
    return yield* provide(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const due = yield* db.execute<Row>({
          label: "megapot-ticket-first-cutoff.due.read",
          text: `SELECT drawing.pool_leg_id, drawing.drawing_id, drawing.version,
                        leg.leg_terms_hash
                   FROM megapot_pool_drawings drawing
                   JOIN song_reward_offer_legs leg ON leg.leg_id=drawing.pool_leg_id
                  WHERE drawing.purchase_order='ticket_first_v1'
                    AND drawing.status='entry_open'
                    AND drawing.entry_cutoff_at <= $1::timestamptz
                    AND leg.attestation_id=$3
                  ORDER BY drawing.entry_cutoff_at, drawing.pool_leg_id, drawing.drawing_id
                  LIMIT $2`,
          values: [frozenAt, limit, options.attestationId],
          readonly: true,
        });
        return yield* Effect.forEach(due.rows as Row[], (row) =>
          Effect.gen(function* () {
            const shares = yield* db.execute<Row>({
              label: "megapot-ticket-first-cutoff.shares.read",
              text: `SELECT account_id, persona_id FROM megapot_pool_shares
                      WHERE pool_leg_id=$1 AND drawing_id=$2
                      ORDER BY account_id, persona_id`,
              values: [text(row, "pool_leg_id"), text(row, "drawing_id")],
              readonly: true,
            });
            return yield* freezeOne({
              poolLegId: text(row, "pool_leg_id"),
              drawingId: bigint(row, "drawing_id"),
              version: Number(bigint(row, "version")),
              termsHash: text(row, "leg_terms_hash"),
              shares: shares.rows.map((share) => ({
                accountId: text(share, "account_id"),
                personaId: text(share, "persona_id"),
              })),
              frozenAt,
            });
          }),
        );
      }),
    );
  });

  return { freezeDue };
}
