import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import { Data, Effect, type Layer } from "effect";
import {
  type SpacesBitcoinNetwork,
  spacesTaprootOutputScriptFromAddress,
} from "./spaces-taproot-recipient.ts";

type Row = Readonly<Record<string, unknown>>;

export type SpacesTaprootPreparation = Readonly<{
  assignmentId: string;
  personaId: string;
  network: SpacesBitcoinNetwork;
  hdWalletIndex: number | null;
  status: "pending" | "active";
  address: string | null;
  outputScriptHex: string | null;
}>;

class SpacesTaprootPreparationConflict extends Data.TaggedError(
  "SpacesTaprootPreparationConflict",
)<{ readonly reason: "authority" | "request-mismatch" | "account-busy" }> {}

const validId = (value: string): boolean =>
  value.length > 0 && value.length <= 128 && value === value.trim();

const string = (row: Row, field: string): string => {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
  return value;
};

const index = (value: unknown): number => {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("invalid Taproot wallet index");
  return result;
};

const preparation = (row: Row): SpacesTaprootPreparation => {
  const status = string(row, "status");
  const network = string(row, "bitcoin_network");
  if (status !== "pending" && status !== "active") throw new Error("invalid Taproot status");
  if (network !== "mainnet" && network !== "testnet4" && network !== "regtest") {
    throw new Error("invalid Taproot network");
  }
  const address = row.address === null ? null : string(row, "address");
  const outputScriptHex = row.output_script_hex === null ? null : string(row, "output_script_hex");
  if (
    (status === "pending" && (address !== null || outputScriptHex !== null)) ||
    (status === "active" &&
      (address === null ||
        outputScriptHex === null ||
        spacesTaprootOutputScriptFromAddress(address, network) !== outputScriptHex))
  ) {
    throw new Error("invalid Taproot assignment");
  }
  return {
    assignmentId: string(row, "assignment_id"),
    personaId: string(row, "persona_id"),
    network,
    hdWalletIndex: row.hd_wallet_index === null ? null : index(row.hd_wallet_index),
    status,
    address,
    outputScriptHex,
  };
};

const SELECT_ASSIGNMENT = `SELECT assignment_id,persona_id,bitcoin_network,hd_wallet_index,
                                   status,address,output_script_hex,reservation_idempotency_key,
                                   privy_wallet_id
                              FROM persona_wallet_assignments
                             WHERE account_id=$1 AND persona_id=$2
                               AND chain_account_kind='bitcoin-taproot'
                               AND status IN ('pending','active')`;

/**
 * A private storage seam for Spec 014 §12.2. It never calls Privy. The pinned
 * browser SDK created a new Taproot wallet at the next index when add was
 * retried with an existing index. External creation therefore remains blocked
 * until provider snapshot and uncertain-outcome reconciliation are implemented.
 */
export function makeControlPlaneSpacesTaprootPreparationStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
) {
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.provide(runtime)(effect);

  return {
    read: (input: Readonly<{ accountId: string; personaId: string }>) =>
      provide(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "spaces-taproot.read",
            text: SELECT_ASSIGNMENT,
            values: [input.accountId, input.personaId],
            readonly: true,
          });
          if (result.rows.length > 1) return yield* Effect.die("duplicate Taproot assignment");
          return result.rows[0] === undefined ? null : preparation(result.rows[0]);
        }),
      ),

    prepare: (
      input: Readonly<{
        accountId: string;
        personaId: string;
        idempotencyKey: string;
        network: SpacesBitcoinNetwork;
      }>,
    ) =>
      provide(
        Effect.gen(function* () {
          if (
            !validId(input.accountId) ||
            !validId(input.personaId) ||
            !validId(input.idempotencyKey)
          ) {
            return yield* new SpacesTaprootPreparationConflict({ reason: "request-mismatch" });
          }
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              yield* transaction.execute({
                label: "spaces-taproot.prepare.lock",
                text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 14000214))",
                values: [JSON.stringify([input.accountId, "bitcoin-taproot"])],
                readonly: false,
              });
              const reusedKey = yield* transaction.execute<Row>({
                label: "spaces-taproot.prepare.key",
                text: `SELECT persona_id,status FROM persona_wallet_assignments
                        WHERE account_id=$1 AND chain_account_kind='bitcoin-taproot'
                          AND reservation_idempotency_key=$2 FOR UPDATE`,
                values: [input.accountId, input.idempotencyKey],
                readonly: false,
              });
              if (
                reusedKey.rows.some(
                  (row) => row.persona_id !== input.personaId || row.status === "tombstoned",
                )
              ) {
                return yield* new SpacesTaprootPreparationConflict({ reason: "request-mismatch" });
              }
              const owner = yield* transaction.execute<Row>({
                label: "spaces-taproot.prepare.owner",
                text: `SELECT 1 FROM personas AS persona
                        JOIN persona_wallet_assignments AS evm
                          ON evm.account_id=persona.account_id
                         AND evm.persona_id=persona.persona_id
                         AND evm.chain_account_kind='evm' AND evm.status='active'
                       WHERE persona.account_id=$1 AND persona.persona_id=$2
                         AND persona.status='active'
                       FOR UPDATE OF persona,evm`,
                values: [input.accountId, input.personaId],
                readonly: false,
              });
              if (owner.rows.length !== 1) {
                return yield* new SpacesTaprootPreparationConflict({ reason: "authority" });
              }
              const existing = yield* transaction.execute<Row>({
                label: "spaces-taproot.prepare.existing",
                text: `${SELECT_ASSIGNMENT} FOR UPDATE`,
                values: [input.accountId, input.personaId],
                readonly: false,
              });
              if (existing.rows.length > 1)
                return yield* Effect.die("duplicate Taproot assignment");
              if (existing.rows[0] !== undefined) {
                if (
                  existing.rows[0].reservation_idempotency_key !== input.idempotencyKey ||
                  existing.rows[0].bitcoin_network !== input.network
                ) {
                  return yield* new SpacesTaprootPreparationConflict({
                    reason: "request-mismatch",
                  });
                }
                return preparation(existing.rows[0]);
              }
              const otherPending = yield* transaction.execute<Row>({
                label: "spaces-taproot.prepare.account-busy",
                text: `SELECT 1 FROM persona_wallet_assignments
                        WHERE account_id=$1 AND chain_account_kind='bitcoin-taproot'
                          AND status='pending' LIMIT 1`,
                values: [input.accountId],
                readonly: true,
              });
              if (otherPending.rows.length !== 0) {
                return yield* new SpacesTaprootPreparationConflict({ reason: "account-busy" });
              }
              const configured = yield* transaction.execute<Row>({
                label: "spaces-taproot.prepare.network",
                text: "SELECT 1 FROM spaces_network_configuration WHERE network=$1",
                values: [input.network],
                readonly: true,
              });
              if (configured.rows.length !== 1) {
                return yield* new SpacesTaprootPreparationConflict({ reason: "request-mismatch" });
              }
              const inserted = yield* transaction.execute<Row>({
                label: "spaces-taproot.prepare.insert",
                text: `INSERT INTO persona_wallet_assignments (
                         assignment_id,persona_id,account_id,chain_account_kind,
                         hd_wallet_index,status,reservation_idempotency_key,bitcoin_network
                       ) VALUES ('persona_taproot_' || replace(gen_random_uuid()::text,'-',''),
                                 $2,$1,'bitcoin-taproot',NULL,'pending',$3,$4)
                       RETURNING assignment_id,persona_id,bitcoin_network,hd_wallet_index,
                                 status,address,output_script_hex`,
                values: [input.accountId, input.personaId, input.idempotencyKey, input.network],
                readonly: false,
              });
              if (inserted.rows.length !== 1) return yield* Effect.die("Taproot insert missing");
              return preparation(inserted.rows[0] as Row);
            }),
          );
        }),
      ),
  };
}
