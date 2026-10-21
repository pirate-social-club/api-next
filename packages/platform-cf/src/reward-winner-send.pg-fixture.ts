import type { Client } from "pg";

export type WinnerSendWalletFixture = Readonly<{
  account: string;
  persona: string;
  address: string;
  state: "sent" | "credited";
  claimed: boolean;
  paidOut: boolean;
  credits?: readonly string[];
}>;

/** Only historical Claim/payout prerequisites bypass their unrelated producer
 * triggers. Send rows and current Palm evidence use their production guards. */
export async function seedWinnerSendPrerequisites(
  admin: Client,
  wallets: readonly WinnerSendWalletFixture[],
  config: Readonly<{
    chainId: number;
    tokenAddress: string;
    custodyAddress: string;
    paidAtomic: bigint;
  }>,
) {
  const {
    chainId: CHAIN_ID,
    tokenAddress: USDC,
    custodyAddress: CUSTODY,
    paidAtomic: PAID,
  } = config;
  const blockHash = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
  await admin.query("SET session_replication_role = replica");
  try {
    await admin.query("INSERT INTO users (user_id) SELECT unnest($1::text[])", [
      [...new Set(wallets.map((row) => row.account))],
    ]);
    await admin.query(
      `INSERT INTO reward_asset_whitelist (
         chain_id, token_address, decimals, symbol, asset_kind, environment, status,
         policy_version, activated_at, plain_erc20_verified_at
       ) VALUES ($1,$2,6,'USDC','settlement_usdc','staging','active',
         'base-sepolia-usdc-v1',statement_timestamp(),statement_timestamp())`,
      [CHAIN_ID, USDC],
    );
    let payoutIndex = 0;
    for (const [index, row] of wallets.entries()) {
      const assignment = `assignment-${row.persona}`;
      await admin.query("INSERT INTO personas (persona_id, account_id) VALUES ($1,$2)", [
        row.persona,
        row.account,
      ]);
      await admin.query(
        `INSERT INTO persona_wallet_assignments (
           assignment_id, persona_id, account_id, chain_account_kind, hd_wallet_index,
           address, status, reservation_idempotency_key, assigned_at, created_at, updated_at
         ) VALUES ($1,$2,$3,'evm',$5,$4,'active',$1,now(),now(),now())`,
        [assignment, row.persona, row.account, row.address, index],
      );
      for (const credit of row.credits ?? [`credit-${row.persona}`]) {
        payoutIndex += 1;
        await admin.query(
          `INSERT INTO reward_ledger_credits (
           credit_id, account_id, payout_persona_id, chain_id, token_address, amount_atomic,
           source_kind, source_reference, state, paid_atomic, settled_at
         ) VALUES ($1,$2,$3,$4,$5,$7,'megapot_allocation',$1,$6,
                   CASE WHEN $6='sent' THEN $7::numeric ELSE 0 END,
                   CASE WHEN $6='sent' THEN clock_timestamp() END)`,
          [credit, row.account, row.persona, CHAIN_ID, USDC, row.state, PAID.toString()],
        );
        if (row.claimed) {
          await admin.query(
            `INSERT INTO megapot_participant_claims (
             credit_id, account_id, pool_leg_id, drawing_id, status, subject_key_id,
             evidence_receipt_id, accepted_at
           ) VALUES ($1,$2,'leg-1',1,'accepted',$3,'receipt',clock_timestamp())`,
            [credit, row.account, `subject-${row.persona}`],
          );
        }
        if (row.paidOut) {
          const effectId = `payout-${credit}`;
          const transactionHash = blockHash(BigInt(10_000 + payoutIndex));
          await admin.query(
            `INSERT INTO reward_chain_effects (
             effect_id, effect_kind, state, version, chain_id, signer_address, target_address,
             settled_amount_atomic, nonce, calldata, calldata_hash, signed_transaction,
             signed_transaction_hash, transaction_hash, receipt_status, receipt_block_number,
             receipt_block_hash, receipt_hash, confirmations, prepared_at, broadcast_at,
             confirmed_at, created_at, updated_at
           ) VALUES ($1,'reward_payout','confirmed',5,$2,$3,$4,$9,$5,'0x00',$6,'0x01',
                     $7,$7,'success',10,$8,$6,3,now(),now(),now(),now(),now())`,
            [
              effectId,
              CHAIN_ID,
              CUSTODY,
              USDC,
              payoutIndex,
              "ab".repeat(32),
              transactionHash,
              blockHash(10n),
              PAID.toString(),
            ],
          );
          await admin.query(
            `INSERT INTO reward_payout_effects (
             payout_effect_id, attestation_id, credit_id, account_id, payout_persona_id,
             destination_address, amount_atomic, wallet_assignment_id,
             solvency_observation_id, custody_balance_before_atomic
           ) VALUES ($1,'attestation-1',$2,$3,$4,$5,$7,$6,'observation',$7)`,
            [effectId, credit, row.account, row.persona, row.address, assignment, PAID.toString()],
          );
          await admin.query(
            `INSERT INTO reward_erc20_transfer_receipt_evidence (
             effect_id, transfer_purpose, attestation_id, token_address, sender_address,
             recipient_address, amount_atomic, transaction_hash, transfer_log_index,
             custody_balance_after_atomic, block_number, block_hash, receipt_hash,
             confirmations, confirmed_at
           ) VALUES ($1,'reward_payout','attestation-1',$2,$3,$4,$8,$5,0,0,10,$6,$7,3,now())`,
            [
              effectId,
              USDC,
              CUSTODY,
              row.address,
              transactionHash,
              blockHash(10n),
              "ab".repeat(32),
              PAID.toString(),
            ],
          );
        }
      }
    }
  } finally {
    await admin.query("SET session_replication_role = origin");
  }
}
