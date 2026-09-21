import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { Client } from "pg";
import {
  AUTHOR_ID,
  AUTHOR_PERSONA_ID,
  COMMUNITY_ID,
  POST_ID,
} from "../../../packages/platform-cf/src/activity-participation-composed.pg-fixture.ts";
import { seedActivitySong } from "../../../packages/platform-cf/src/activity-participation-composed-song.pg-fixture.ts";
import { insertActiveCommunityMembershipFixture } from "../../../packages/platform-cf/src/community-follow.pg-fixture.ts";
import type { MegapotTransactionReceipt } from "../../../packages/platform-cf/src/megapot-v2.ts";
import type { MegapotV2RpcClient } from "../../../packages/platform-cf/src/megapot-v2-rpc.ts";
import { makeDirectPostgresControlPlaneLayer } from "../../../packages/platform-cf/src/postgres.ts";
import { makeRewardFundingCoordinator } from "../../../packages/platform-cf/src/reward-funding-coordinator.ts";
import { makeControlPlaneRewardFundingStore } from "../../../packages/platform-cf/src/reward-funding-repository.ts";
import { makeControlPlaneRewardProjectionStore } from "../../../packages/platform-cf/src/reward-projection-repository.ts";
import { seedMegapotAuthority } from "../../../packages/platform-cf/src/rewards-composed-pool.pg-fixture.ts";
import { makeControlPlaneSongRewardOfferStore } from "../../../packages/platform-cf/src/song-reward-offer-repository.ts";
import { rehearsalInput } from "../../../scripts/megapot-golden-multi.fixture.ts";
import { makeSongRewardOfferHandlers } from "./rewards-song-offer-handlers.ts";
import { createHttpWorker } from "./transport.ts";

const address = (byte: string): `0x${string}` => `0x${byte.repeat(40)}`;
const hash = (byte: string): `0x${string}` => `0x${byte.repeat(64)}`;
export const fundingHash = hash("a");

/** Real HTTP/application/repositories; transport authentication/authorization and chain RPC are fixtures. */
export async function goldenRetryFixture(admin: Client, connection: string) {
  await admin.query("SET session_replication_role=replica");
  try {
    await seedActivitySong(admin);
    await admin.query(
      `INSERT INTO persona_wallet_assignments (
      assignment_id,persona_id,account_id,chain_account_kind,privy_wallet_id,hd_wallet_index,address,status,reservation_idempotency_key,assigned_at,created_at,updated_at
    ) VALUES ('retry-wallet',$1,$2,'evm','retry-wallet',0,$3,'active','retry-wallet',statement_timestamp(),statement_timestamp(),statement_timestamp())`,
      [AUTHOR_PERSONA_ID, AUTHOR_ID, address("5")],
    );
    await admin.query(
      `INSERT INTO song_owner_policy_revisions
      (community_id,post_id,audio_revision,owner_account_id,policy_revision,third_party_reward_legs,pool_leg,derivative_video,policy_hash)
      VALUES ($1,$2,1,$3,1,'allowed','allowed','allowed',song_owner_policy_hash_v1($1,$2,1,$3,1,'allowed','allowed','allowed'))`,
      [COMMUNITY_ID, POST_ID, AUTHOR_ID],
    );
    await admin.query(
      `INSERT INTO song_owner_policies
      (community_id,post_id,audio_revision,owner_account_id,current_policy_revision,current_policy_hash)
      VALUES ($1,$2,1,$3,1,song_owner_policy_hash_v1($1,$2,1,$3,1,'allowed','allowed','allowed'))`,
      [COMMUNITY_ID, POST_ID, AUTHOR_ID],
    );
  } finally {
    await admin.query("SET session_replication_role=origin");
  }
  await insertActiveCommunityMembershipFixture(admin, {
    communityId: COMMUNITY_ID,
    userId: AUTHOR_ID,
    membershipId: "retry-membership",
    joinedAt: new Date().toISOString(),
  });
  await seedMegapotAuthority(admin);
  await admin.query(
    `INSERT INTO megapot_drawing_observations (
    observation_id,attestation_id,chain_id,drawing_id,ticket_price_atomic,drawing_time,
    ball_max,bonusball_max,drawing_locked,referral_fee_wei,referral_win_share_wei,
    block_number,block_hash,block_timestamp,confirmations,observed_at,expires_at,raw_state_hash
  ) VALUES ('retry-observation','megapot-base-sepolia-v2',84532,41,100,clock_timestamp()+interval '1 hour',
    25,13,false,100000000000000000,100000000000000000,141,$1,clock_timestamp()-interval '2 minutes',
    3,clock_timestamp(),clock_timestamp()+interval '30 minutes',$2)`,
    [hash("4"), "4".repeat(64)],
  );
  const layer = makeDirectPostgresControlPlaneLayer(connection);
  const fundingStore = makeControlPlaneRewardFundingStore(layer);
  let receiptsRead = 0;
  const receipt: MegapotTransactionReceipt = {
    chainId: 84532,
    status: "success",
    transactionHash: fundingHash,
    from: address("5"),
    to: address("1"),
    blockHash: hash("b"),
    blockNumber: 200n,
    logs: [
      {
        address: address("1"),
        topics: [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          `0x${"0".repeat(24)}${"5".repeat(40)}`,
          `0x${"0".repeat(24)}${"4".repeat(40)}`,
        ],
        data: `0x${1000n.toString(16).padStart(64, "0")}`,
        logIndex: 3,
        transactionHash: fundingHash,
        blockHash: hash("b"),
        blockNumber: 200n,
      },
    ],
  };
  const rpc = {
    attestDeployment: async () => ({
      jackpotCodeHash: hash("7"),
      usdcCodeHash: hash("8"),
      ticketNftCodeHash: hash("9"),
    }),
    readReceipt: async () => {
      receiptsRead++;
      return receipt;
    },
    readBlock: async () => ({ blockNumber: 200n, blockHash: hash("b") }),
    readHead: async () => ({ blockNumber: 202n, blockHash: hash("c") }),
  } as unknown as MegapotV2RpcClient;
  const handlers = makeSongRewardOfferHandlers({
    rewardCatalogAuthority: { environment: "staging", attestationId: "megapot-base-sepolia-v2" },
    clock: { now: Effect.sync(Date.now) },
    ids: { next: Effect.sync(randomUUID) },
    store: makeControlPlaneSongRewardOfferStore(layer),
    fundingStore,
    funding: makeRewardFundingCoordinator({ store: fundingStore, rpc }),
    projections: makeControlPlaneRewardProjectionStore(layer),
    requiredConfirmations: 3,
    externalFallbackPolicy: null,
  });
  const worker = createHttpWorker({
    handlers,
    authenticate: () => ({ kind: "user", subject: AUTHOR_ID, walletAddress: address("5") }),
    authorize: () => {},
  });
  const base = rehearsalInput();
  if (!base.authorization) throw new Error("fixture authorization missing");
  const now = Date.now();
  const input = {
    ...base,
    community_id: COMMUNITY_ID,
    post_id: POST_ID,
    persona_id: AUTHOR_PERSONA_ID,
    funding_transaction_hash: fundingHash,
    starts_at: new Date(now - 60000).toISOString(),
    ends_at: new Date(now + 3600000).toISOString(),
    authorization: {
      ...base.authorization,
      execution_starts_at: new Date(now - 60000).toISOString(),
      qualification_deadline: new Date(now + 600000).toISOString(),
      reconciliation_deadline: new Date(now + 7200000).toISOString(),
    },
  };
  return { worker, input, receiptsRead: () => receiptsRead };
}
