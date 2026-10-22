import type { Client } from "pg";
import {
  otherParticipantAccount,
  participantAccount,
} from "./shared-song-megapot-participation.pg-fixture.ts";

const hash = "a".repeat(64),
  block = `0x${"b".repeat(64)}`,
  tx = `0x${"d".repeat(64)}`;

/** Synthetic confirmed-history rows for projection lineage tests only. The
 * caller owns a rollback-only replica bootstrap transaction. No producer,
 * signer, chain, settlement, Claim command or monetary admission runs here. */
export async function seedParticipantWinHistory(admin: Client) {
  await admin.query(
    `INSERT INTO personas(persona_id,account_id) VALUES
    ('test-reader-persona',$1),('test-other-persona',$2)`,
    [participantAccount, otherParticipantAccount],
  );
  await admin.query(`UPDATE megapot_drawing_observations SET drawing_time=statement_timestamp()-interval '1 hour',
    gross_prize_pool_atomic=1000000000,global_tickets_bought=12345,
    expires_at=statement_timestamp()-interval '1 second',observed_at=statement_timestamp()-interval '2 minutes',
    block_timestamp=statement_timestamp()-interval '3 minutes' WHERE observation_id='test-observation'`);
  await admin.query(`INSERT INTO megapot_drawing_observations(observation_id,attestation_id,chain_id,drawing_id,
    ticket_price_atomic,drawing_time,ball_max,bonusball_max,drawing_locked,referral_fee_wei,referral_win_share_wei,
    block_number,block_hash,block_timestamp,confirmations,observed_at,expires_at,raw_state_hash)
    SELECT 'test-next-observation',attestation_id,chain_id,201,ticket_price_atomic,statement_timestamp()+interval '1 day',
    ball_max,bonusball_max,false,referral_fee_wei,referral_win_share_wei,block_number+1,block_hash,statement_timestamp(),
    confirmations,statement_timestamp(),statement_timestamp()+interval '1 hour',raw_state_hash
    FROM megapot_drawing_observations WHERE observation_id='test-observation'`);
  await admin.query(`UPDATE megapot_pool_drawings SET status='credited',entry_cutoff_at=(SELECT drawing_time-interval '5 minutes'
    FROM megapot_drawing_observations WHERE observation_id='test-observation'),
    reserved_ticket_cost_atomic=1000000,actual_ticket_cost_atomic=1000000,gross_winnings_atomic=1000000,
    net_winnings_atomic=900000,frozen_share_count=2,fallback_beneficiary=false,snapshot_id='test-snapshot',
    commitment_effect_id='test-commitment',purchase_effect_id='test-purchase',claim_effect_id='test-custody-claim',
    allocation_batch_id='test-batch',created_at=statement_timestamp()-interval '2 hours',
    cutoff_frozen_at=statement_timestamp()-interval '65 minutes',terminal_at=statement_timestamp()-interval '30 minutes',
    updated_at=statement_timestamp() WHERE pool_leg_id='test-leg' AND drawing_id=200`);
  await admin.query(`INSERT INTO megapot_pool_drawings(pool_leg_id,drawing_id,observation_id,status,entry_cutoff_at,ticket_price_ceiling_atomic)
    SELECT 'test-leg',201,observation_id,'entry_open',drawing_time-interval '5 minutes',2000000
    FROM megapot_drawing_observations WHERE observation_id='test-next-observation'`);
  await admin.query(
    `INSERT INTO megapot_pool_beneficiary_snapshots(snapshot_id,pool_leg_id,drawing_id,domain,
    terms_hash,algorithm_version,fallback,leaf_count,snapshot_hash,published_artifact,frozen_at)
    SELECT 'test-snapshot','test-leg',200,'pirate.megapot-pool-beneficiary-snapshot.v2',leg_terms_hash,
    'equal_v1',false,2,$1,'{}',statement_timestamp()-interval '65 minutes' FROM song_reward_offer_legs WHERE leg_id='test-leg'`,
    [block],
  );
  await admin.query(
    `INSERT INTO megapot_pool_snapshot_private_leaves(snapshot_id,ordinal,account_id,persona_id,order_key,leaf_commitment)
    VALUES('test-snapshot',0,$1,'test-reader-persona',$3,$3),('test-snapshot',1,$2,'test-other-persona',$4,$4)`,
    [participantAccount, otherParticipantAccount, `0x${"1".repeat(64)}`, `0x${"2".repeat(64)}`],
  );
  await admin.query(
    `INSERT INTO megapot_pool_commitment_effects(commitment_effect_id,snapshot_id,payload_hash,
    signing_key_id,signature,state,prepared_at,published_at,public_reference)
    VALUES('test-commitment','test-snapshot',$1,'test-key','test-signature','published',statement_timestamp(),
    statement_timestamp(),'https://example.invalid/test-commitment')`,
    [hash],
  );
  await admin.query(
    `INSERT INTO megapot_ticket_inventory(attestation_id,ticket_id,purchase_effect_id,pool_leg_id,
    drawing_id,custody_address,owner_observation_block_number,owner_observation_block_hash,minted_transaction_hash,
    minted_log_index,status,claimed_transaction_hash,acquired_at,terminal_at)
    VALUES('megapot-base-sepolia-v2',123,'test-purchase','test-leg',200,$1,100,$2,$3,0,'claimed',$4,
    statement_timestamp()-interval '1 hour',statement_timestamp()-interval '30 minutes')`,
    [`0x${"4".repeat(40)}`, block, `0x${"e".repeat(64)}`, tx],
  );
  await admin.query(
    `INSERT INTO reward_chain_effects(effect_id,effect_kind,state,version,chain_id,signer_address,
    target_address,settled_amount_atomic,nonce,calldata,calldata_hash,signed_transaction,signed_transaction_hash,
    transaction_hash,receipt_status,receipt_block_number,receipt_block_hash,receipt_hash,confirmations,
    created_at,prepared_at,broadcast_at,confirmed_at,updated_at)
    VALUES('test-custody-claim','winnings_claim','confirmed',5,84532,$1,$2,900000,10,'0x00',$3,'0x01',$4,
    $4,'success',200,$5,$3,3,statement_timestamp(),statement_timestamp(),statement_timestamp(),statement_timestamp(),statement_timestamp())`,
    [`0x${"4".repeat(40)}`, `0x${"2".repeat(40)}`, hash, tx, block],
  );
  await admin.query(
    `INSERT INTO megapot_claim_effects(claim_effect_id,attestation_id,ticket_id,pool_leg_id,drawing_id,
    sweep_id,expected_gross_winnings_atomic,expected_net_winnings_atomic,expected_referral_accrual_atomic,
    custody_balance_before_atomic,referral_balance_before_atomic,preflight_block_number,preflight_block_hash,
    received_atomic,referral_accrual_atomic,claim_log_index,burn_log_index,referral_log_index,transfer_log_index)
    VALUES('test-custody-claim','megapot-base-sepolia-v2',123,'test-leg',200,'test-sweep',1000000,900000,100000,
    10000000,0,199,$1,900000,100000,0,1,2,3)`,
    [block],
  );
  await admin.query(
    `INSERT INTO megapot_claim_receipt_evidence(claim_effect_id,attestation_id,ticket_id,
    transaction_hash,claim_log_index,burn_log_index,referral_log_index,transfer_log_index,gross_winnings_atomic,
    referral_accrual_atomic,net_winnings_atomic,custody_balance_before_atomic,custody_balance_after_atomic,
    referral_balance_before_atomic,referral_balance_after_atomic,block_number,block_hash,receipt_hash,confirmations,confirmed_at)
    VALUES('test-custody-claim','megapot-base-sepolia-v2',123,$1,0,1,2,3,1000000,100000,900000,10000000,10900000,
    0,100000,200,$2,$3,3,statement_timestamp())`,
    [tx, block, hash],
  );
  await admin.query(
    `INSERT INTO megapot_allocation_batches(allocation_batch_id,pool_leg_id,drawing_id,snapshot_id,
    claim_effect_id,algorithm_version,net_winnings_atomic,allocation_count,allocation_hash,state,credited_at)
    VALUES('test-batch','test-leg',200,'test-snapshot','test-custody-claim','equal_v1',900000,2,$1,'credited',clock_timestamp())`,
    [hash],
  );
  for (const [ordinal, account, persona, credit] of [
    [0, participantAccount, "test-reader-persona", "test-credit"],
    [1, otherParticipantAccount, "test-other-persona", "test-other-credit"],
  ] as const) {
    await admin.query(
      `INSERT INTO reward_ledger_credits(credit_id,account_id,payout_persona_id,chain_id,
      token_address,amount_atomic,source_kind,source_reference,state)
      VALUES($1,$2,$3,84532,$4,450000,'megapot_allocation',$5,'credited')`,
      [credit, account, persona, `0x${"1".repeat(40)}`, `test-batch:${ordinal}`],
    );
    await admin.query(
      `INSERT INTO megapot_allocations(allocation_batch_id,ordinal,account_id,persona_id,
      amount_atomic,allocation_kind,credit_id) VALUES('test-batch',$1,$2,$3,450000,'participant',$4)`,
      [ordinal, account, persona, credit],
    );
  }
}
