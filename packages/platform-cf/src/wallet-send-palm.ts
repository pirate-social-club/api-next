import type { ControlPlaneTransaction } from "@pirate/application";
import { Effect } from "effect";

type Executor = Pick<ControlPlaneTransaction, "execute">;
type Evidence = Readonly<{
  subject_key_id: string;
  evidence_receipt_id: string;
  evidence_count: string;
}>;

export class WalletSendVerificationRequired extends Error {
  constructor(readonly personaId: string) {
    super("Palm verification required for Send");
    this.name = "WalletSendVerificationRequired";
  }
}

const loadEvidence = Effect.fn("wallet-send.loadPalmEvidence")(function* (
  executor: Executor,
  accountId: string,
) {
  // The same authoritative stored Very evidence boundary used by Claim.
  const result = yield* executor.execute<Evidence>({
    label: "wallet-send.palm.read",
    text: `SELECT subject_key_id, evidence_receipt_id, evidence_count::text
             FROM reward_account_very_evidence_v1($1, NULL)`,
    values: [accountId],
    readonly: true,
  });
  const row = result.rows[0];
  return result.rows.length === 1 && row?.evidence_count === "1" ? row : null;
});

export const hasCurrentWalletSendPalm = Effect.fn("wallet-send.hasCurrentPalm")(function* (
  executor: Executor,
  accountId: string,
) {
  return (yield* loadEvidence(executor, accountId)) !== null;
});

export const requireCurrentWalletSendPalm = Effect.fn("wallet-send.requireCurrentPalm")(function* (
  transaction: ControlPlaneTransaction,
  accountId: string,
  personaId: string,
) {
  const evidence = yield* loadEvidence(transaction, accountId);
  if (evidence === null) return yield* Effect.fail(new WalletSendVerificationRequired(personaId));
  // Recovery locks the subject before changing its active account binding.
  yield* transaction.execute({
    label: "wallet-send.palm.lock-subject",
    text: "SELECT subject_key_id FROM subject_keys WHERE subject_key_id=$1 FOR UPDATE",
    values: [evidence.subject_key_id],
    readonly: false,
  });
  yield* transaction.execute({
    label: "wallet-send.palm.lock-binding",
    text: `SELECT subject_key_id FROM active_subject_key_bindings
            WHERE subject_key_id=$1 AND user_id=$2 FOR UPDATE`,
    values: [evidence.subject_key_id, accountId],
    readonly: false,
  });
  // FOR UPDATE also conflicts with the FK key-share lock acquired by a
  // concurrent revalidation insert. Recheck after waiting for either lock.
  yield* transaction.execute({
    label: "wallet-send.palm.lock-assertions",
    text: "SELECT lock_wallet_send_palm_assertions_v1($1,$2)",
    values: [accountId, evidence.evidence_receipt_id],
    readonly: false,
  });
  const current = yield* loadEvidence(transaction, accountId);
  if (
    current === null ||
    current.subject_key_id !== evidence.subject_key_id ||
    current.evidence_receipt_id !== evidence.evidence_receipt_id
  ) {
    return yield* Effect.fail(new WalletSendVerificationRequired(personaId));
  }
});
