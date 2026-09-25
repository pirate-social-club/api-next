import { createHash, randomBytes } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import { Effect, type Layer } from "effect";
import {
  type EmbeddedTaprootWallet,
  reconcileEmbeddedTaprootWallets,
} from "./spaces-taproot-inventory.ts";
import type { SpacesBitcoinNetwork } from "./spaces-taproot-recipient.ts";

type Row = Readonly<Record<string, unknown>>;
type Tx = Parameters<ControlPlaneDb["Service"]["withTransaction"]>[0] extends (
  transaction: infer T,
) => unknown
  ? T
  : never;

export class SpacesTaprootIntentRefused extends Error {
  constructor(readonly reason: "authority" | "conflict" | "unavailable" | "invalid") {
    super(`Taproot creation ${reason}`);
  }
}

const required = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${key}`);
  return value;
};
const wallets = (value: unknown): readonly EmbeddedTaprootWallet[] => {
  if (!Array.isArray(value)) throw new Error("invalid stored Taproot inventory");
  return value as readonly EmbeddedTaprootWallet[];
};
const inventoryIdentity = (items: readonly EmbeddedTaprootWallet[]) =>
  JSON.stringify(
    items.map((wallet) => [
      wallet.providerId,
      wallet.index,
      wallet.address,
      wallet.outputScriptHex,
      wallet.publicKeyHex,
    ]),
  );
const query = async (tx: Tx, label: string, text: string, values: readonly unknown[]) =>
  Effect.runPromise(tx.execute<Row>({ label, text, values, readonly: false }));
const transact = <T>(db: ControlPlaneDb["Service"], action: (tx: Tx) => Promise<T>) =>
  Effect.runPromise(
    db.withTransaction((tx) =>
      Effect.tryPromise({ try: () => action(tx), catch: (error) => error }),
    ),
  );

const intentSql = `SELECT intent.*,assignment.status AS assignment_status,
                          assignment.privy_wallet_id,assignment.address,assignment.output_script_hex
                     FROM spaces_taproot_creation_intents AS intent
                     JOIN persona_wallet_assignments AS assignment
                       ON assignment.assignment_id=intent.assignment_id
                    WHERE intent.assignment_id=$1 AND intent.account_id=$2
                      AND intent.persona_id=$3 FOR UPDATE OF intent,assignment`;

const one = (rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined) throw new SpacesTaprootIntentRefused("authority");
  return rows[0];
};

export type TaprootIntentIdentity = Readonly<{
  accountId: string;
  personaId: string;
  assignmentId: string;
  network: SpacesBitcoinNetwork;
}>;

/** Domain-separated challenge. The browser signs these 32 bytes with its Taproot wallet. */
export function taprootRecipientChallengeDigest(
  assignmentId: string,
  providerId: string,
  outputScriptHex: string,
  nonceHex: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "pirate-spaces-taproot-recipient-v1",
        assignmentId,
        providerId,
        outputScriptHex,
        nonceHex,
      ]),
    )
    .digest("hex");
}

export function taprootRecipientSignatureValid(
  digestHex: string,
  outputScriptHex: string,
  signatureHex: string,
): boolean {
  if (
    !/^[0-9a-f]{64}$/u.test(digestHex) ||
    !/^5120[0-9a-f]{64}$/u.test(outputScriptHex) ||
    !/^[0-9a-f]{128}$/u.test(signatureHex)
  )
    return false;
  try {
    return schnorr.verify(
      Buffer.from(signatureHex, "hex"),
      Buffer.from(digestHex, "hex"),
      Buffer.from(outputScriptHex.slice(4), "hex"),
    );
  } catch {
    return false;
  }
}

/** Database intent never invokes Privy add. The caller supplies independently read inventory. */
export function makeControlPlaneSpacesTaprootIntentStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
) {
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.provide(runtime)(effect);
  return {
    prepare: (identity: TaprootIntentIdentity, baseline: readonly EmbeddedTaprootWallet[]) =>
      provide(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* Effect.tryPromise({
            try: () =>
              transact(db, async (tx) => {
                const assignment = one(
                  (
                    await query(
                      tx,
                      "taproot-intent.assignment",
                      `SELECT assignment_id FROM persona_wallet_assignments WHERE assignment_id=$1 AND account_id=$2 AND persona_id=$3 AND bitcoin_network=$4 AND chain_account_kind='bitcoin-taproot' AND status='pending' FOR UPDATE`,
                      [
                        identity.assignmentId,
                        identity.accountId,
                        identity.personaId,
                        identity.network,
                      ],
                    )
                  ).rows,
                );
                if (required(assignment, "assignment_id") !== identity.assignmentId)
                  throw new SpacesTaprootIntentRefused("authority");
                const existing = (
                  await query(tx, "taproot-intent.existing", intentSql, [
                    identity.assignmentId,
                    identity.accountId,
                    identity.personaId,
                  ])
                ).rows[0];
                if (existing !== undefined) {
                  if (
                    inventoryIdentity(wallets(existing.baseline_wallets)) !==
                    inventoryIdentity(baseline)
                  )
                    throw new SpacesTaprootIntentRefused("conflict");
                  return {
                    assignmentId: identity.assignmentId,
                    state: required(existing, "state"),
                  };
                }
                await query(
                  tx,
                  "taproot-intent.insert",
                  `INSERT INTO spaces_taproot_creation_intents (assignment_id,account_id,persona_id,bitcoin_network,baseline_wallets,challenge_nonce_hex,state) VALUES ($1,$2,$3,$4,$5::jsonb,$6,'prepared')`,
                  [
                    identity.assignmentId,
                    identity.accountId,
                    identity.personaId,
                    identity.network,
                    JSON.stringify(baseline),
                    Buffer.from(randomBytes(32)).toString("hex"),
                  ],
                );
                return { assignmentId: identity.assignmentId, state: "prepared" };
              }),
            catch: (error) => error,
          });
        }),
      ),
    beginCreate: (identity: TaprootIntentIdentity) =>
      provide(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* Effect.tryPromise({
            try: () =>
              transact(db, async (tx) => {
                const row = one(
                  (
                    await query(tx, "taproot-intent.begin.read", intentSql, [
                      identity.assignmentId,
                      identity.accountId,
                      identity.personaId,
                    ])
                  ).rows,
                );
                if (required(row, "bitcoin_network") !== identity.network)
                  throw new SpacesTaprootIntentRefused("authority");
                if (row.assignment_status !== "pending")
                  throw new SpacesTaprootIntentRefused("conflict");
                if (row.state !== "prepared")
                  return { mayCreate: false, state: required(row, "state") };
                await query(
                  tx,
                  "taproot-intent.begin.mark",
                  `UPDATE spaces_taproot_creation_intents SET state='create_started',started_at=clock_timestamp() WHERE assignment_id=$1`,
                  [identity.assignmentId],
                );
                return { mayCreate: true, state: "create_started" };
              }),
            catch: (error) => error,
          });
        }),
      ),
    status: (identity: TaprootIntentIdentity, inventory: readonly EmbeddedTaprootWallet[]) =>
      provide(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* Effect.tryPromise({
            try: () =>
              transact(db, async (tx) => {
                const row = one(
                  (
                    await query(tx, "taproot-intent.status.read", intentSql, [
                      identity.assignmentId,
                      identity.accountId,
                      identity.personaId,
                    ])
                  ).rows,
                );
                if (required(row, "bitcoin_network") !== identity.network)
                  throw new SpacesTaprootIntentRefused("authority");
                if (row.assignment_status === "tombstoned")
                  throw new SpacesTaprootIntentRefused("conflict");
                const state = required(row, "state");
                if (state === "prepared") return { kind: "prepared" as const };
                if (state === "ambiguous") return { kind: "ambiguous" as const };
                if (state === "active")
                  return {
                    kind: "active" as const,
                    providerId: required(row, "candidate_privy_wallet_id"),
                  };
                const result = reconcileEmbeddedTaprootWallets(
                  wallets(row.baseline_wallets),
                  inventory,
                );
                if (result.kind === "ambiguous") {
                  await query(
                    tx,
                    "taproot-intent.status.ambiguous",
                    `UPDATE spaces_taproot_creation_intents SET state='ambiguous' WHERE assignment_id=$1`,
                    [identity.assignmentId],
                  );
                  return result;
                }
                if (result.kind === "pending") return result;
                return {
                  kind: "candidate" as const,
                  wallet: result.wallet,
                  challengeDigestHex: taprootRecipientChallengeDigest(
                    identity.assignmentId,
                    result.wallet.providerId,
                    result.wallet.outputScriptHex,
                    required(row, "challenge_nonce_hex"),
                  ),
                };
              }),
            catch: (error) => error,
          });
        }),
      ),
    confirm: (
      identity: TaprootIntentIdentity,
      inventory: readonly EmbeddedTaprootWallet[],
      providerId: string,
      signatureHex: string,
    ) =>
      provide(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* Effect.tryPromise({
            try: () =>
              transact(db, async (tx) => {
                const row = one(
                  (
                    await query(tx, "taproot-intent.confirm.read", intentSql, [
                      identity.assignmentId,
                      identity.accountId,
                      identity.personaId,
                    ])
                  ).rows,
                );
                if (required(row, "bitcoin_network") !== identity.network)
                  throw new SpacesTaprootIntentRefused("authority");
                if (row.assignment_status === "tombstoned")
                  throw new SpacesTaprootIntentRefused("conflict");
                if (row.state === "active") {
                  if (
                    row.candidate_privy_wallet_id !== providerId ||
                    row.confirm_signature_hex !== signatureHex
                  )
                    throw new SpacesTaprootIntentRefused("conflict");
                  return {
                    assignmentId: identity.assignmentId,
                    address: required(row, "address"),
                    outputScriptHex: required(row, "output_script_hex"),
                    replay: true,
                  };
                }
                if (row.state !== "create_started" || row.assignment_status !== "pending")
                  throw new SpacesTaprootIntentRefused("conflict");
                const result = reconcileEmbeddedTaprootWallets(
                  wallets(row.baseline_wallets),
                  inventory,
                );
                if (result.kind === "ambiguous") {
                  await query(
                    tx,
                    "taproot-intent.confirm.ambiguous",
                    `UPDATE spaces_taproot_creation_intents SET state='ambiguous' WHERE assignment_id=$1`,
                    [identity.assignmentId],
                  );
                  throw new SpacesTaprootIntentRefused("conflict");
                }
                if (result.kind !== "candidate" || result.wallet.providerId !== providerId)
                  throw new SpacesTaprootIntentRefused("conflict");
                const digest = taprootRecipientChallengeDigest(
                  identity.assignmentId,
                  providerId,
                  result.wallet.outputScriptHex,
                  required(row, "challenge_nonce_hex"),
                );
                if (
                  !taprootRecipientSignatureValid(
                    digest,
                    result.wallet.outputScriptHex,
                    signatureHex,
                  )
                )
                  throw new SpacesTaprootIntentRefused("invalid");
                await query(
                  tx,
                  "taproot-intent.confirm.assignment",
                  `UPDATE persona_wallet_assignments SET status='active',privy_wallet_id=$2,hd_wallet_index=$3,address=$4,output_script_hex=$5,assigned_at=clock_timestamp(),updated_at=clock_timestamp() WHERE assignment_id=$1 AND status='pending'`,
                  [
                    identity.assignmentId,
                    providerId,
                    result.wallet.index,
                    result.wallet.address,
                    result.wallet.outputScriptHex,
                  ],
                );
                await query(
                  tx,
                  "taproot-intent.confirm.intent",
                  `UPDATE spaces_taproot_creation_intents SET state='active',candidate_privy_wallet_id=$2,confirm_signature_hex=$3,confirmed_at=clock_timestamp() WHERE assignment_id=$1`,
                  [identity.assignmentId, providerId, signatureHex],
                );
                return {
                  assignmentId: identity.assignmentId,
                  address: result.wallet.address,
                  outputScriptHex: result.wallet.outputScriptHex,
                  replay: false,
                };
              }),
            catch: (error) => error,
          });
          if ("ambiguous" in result)
            return yield* Effect.fail(new SpacesTaprootIntentRefused("conflict"));
          return result;
        }),
      ),
  };
}
