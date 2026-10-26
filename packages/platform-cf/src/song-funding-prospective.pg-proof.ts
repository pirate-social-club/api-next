import { expect } from "bun:test";
import { ControlPlaneDb } from "@pirate/application";
import { Effect, Schema } from "effect";
import type { Client } from "pg";
import { makeSongMegapotContributions } from "../../application/src/rewards/song-megapot-contributions.ts";
import * as C from "../../contracts/src/rewards-song-contributions-v2.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneRewardRunAuthority } from "./reward-operations-control.ts";
import { makeControlPlaneSharedSongContextProducer } from "./shared-song-megapot-production.ts";
import { seedProspectiveSongFundingFixture } from "./song-funding-prospective.pg-fixture.ts";
import {
  makeControlPlaneSongContributionPorts,
  makeControlPlaneSongContributionReadPorts,
  persistRewardFundingPrincipalIn,
} from "./song-megapot-contribution-repository.ts";

export async function proveProspectiveSongFunding(input: {
  admin: Client;
  owner: Client;
  http: string;
  jobs: string;
}) {
  const { start, postId } = await seedProspectiveSongFundingFixture(input.admin);
  const h = "a".repeat(64),
    jobs = makeDirectPostgresControlPlaneLayer(input.jobs),
    http = makeDirectPostgresControlPlaneLayer(input.http);
  const authority = makeControlPlaneRewardRunAuthority(jobs);
  const producer = makeControlPlaneSharedSongContextProducer({
    runtime: jobs,
    now: () => new Date().toISOString(),
    rpcFor: (deployment) => ({
      deployment,
      attestDeploymentAt: async () => {},
      readHead: async () => ({
        blockNumber: 20n,
        blockHash: `0x${h}`,
        blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
      }),
      readBlock: async (blockNumber) => ({ blockNumber, blockHash: `0x${h}` }),
      readTransactionCount: async () => 7n,
      readPendingNonce: async () => 7n,
      readNativeBalance: async () => 1000000000000000000n,
      readCurrentDrawingId: async () => 101n,
      readDrawing: async (id) => ({
        prizePool: 0n,
        ticketPrice: 1000000n,
        edgePerTicket: 0n,
        referralWinShare: 0n,
        referralFee: 0n,
        globalTicketsBought: 0n,
        lpEarnings: 0n,
        drawingTime: BigInt(Math.floor(start / 1000)) + (id - 100n) * 3600n,
        winningTicket: 0n,
        ballMax: 1,
        bonusballMax: 1,
        payoutCalculator: `0x${"00".repeat(20)}`,
        jackpotLock: false,
      }),
    }),
  });
  // Both existing personas get their private context from the actual bounded
  // SQL claim/producer/persist path; only the second has no outstanding nonce.
  await Effect.runPromise(producer.run({ enabled: true, ensure: authority.ensure }));
  await Effect.runPromise(producer.run({ enabled: true, ensure: authority.ensure }));
  const scope = { communityId: "community", postId, contributionId: null },
    auth = { authorize: () => Effect.succeed({ accountId: "b" }) };
  const reads = makeControlPlaneSongContributionReadPorts(http, auth, { rewardsEnabled: true });
  const context = Schema.decodeUnknownSync(C.ContextReadyV2)(
    await Effect.runPromise(reads.context(scope, "b", "persona-b")),
  );
  if (context.quote.kind !== "prospective") throw Error("Prospective context required");
  const ref = context.context_ref;
  const request: C.ContributionRequestV2 = {
    version: 2,
    idempotency_key: "purpose_initial_pot_0001",
    persona_id: "persona-b",
    funding_amount_atomic: "2000000",
    expected_context_hash: context.context_hash,
    expected_lifecycle_revision: context.lifecycle_revision,
    context_version: ref.version,
    context_slot_id: ref.slot_id,
    context_slot_generation: ref.slot_generation,
    context_leg_snapshot_id: ref.leg_snapshot_id ?? "",
    context_schedule_witness_id: ref.schedule_witness_id,
    context_profile_id: ref.profile_id,
    context_profile_hash: ref.profile_hash,
    context_funding_policy_hash: ref.funding_policy_hash,
    context_wallet_assignment_id: ref.wallet_assignment_id,
    context_wallet_assignment_revision: ref.wallet_assignment_revision,
    context_lifecycle_revision: ref.lifecycle_revision,
    expected_terms_kind: "prospective",
    expected_terms_hash: context.quote.prospective_terms_hash,
  };
  const service = makeSongMegapotContributions(
    makeControlPlaneSongContributionPorts(http, auth, { rewardsEnabled: true }),
  );
  const snapshot = async () => {
    const state = [];
    for (const table of [
      "policy_versions",
      "reward_uniqueness_authorities",
      "song_reward_offers",
      "song_reward_offer_legs",
      "reward_song_slots_v2",
      "reward_wallet_nonce_leases",
      "song_megapot_contributions_v2",
      "reward_funding_account_counters_v2",
      "reward_funding_work_envelopes_v2",
      "reward_contribution_reservations_v2",
    ])
      state.push(
        (
          await input.owner.query(
            `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) data FROM ${table} t`,
          )
        ).rows[0].data,
      );
    return state;
  };
  const before = await snapshot();
  await input.owner.query(`CREATE FUNCTION purpose_initial_pot_refusal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.idempotency_key='purpose_initial_pot_refused' AND NEW.refusal_code IS NULL THEN RAISE EXCEPTION 'fixture initial pot refusal' USING ERRCODE='PCV05'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER purpose_initial_pot_refusal BEFORE INSERT ON song_megapot_contribution_commands_v2 FOR EACH ROW EXECUTE FUNCTION purpose_initial_pot_refusal()`);
  await expect(
    Effect.runPromise(
      service.execute("CreateSongMegapotContributionV2", scope, {
        ...request,
        idempotency_key: "purpose_initial_pot_refused",
      }),
    ),
  ).rejects.toMatchObject({
    code: "policy_unavailable",
    refusalReceipt: { allocation: "none", instruction_issued: false },
  });
  expect(await snapshot()).toEqual(before);
  const receipt = Schema.decodeUnknownSync(C.ContributionReceiptV2)(
    await Effect.runPromise(service.execute("CreateSongMegapotContributionV2", scope, request)),
  );
  const persisted =
    await input.owner.query(`SELECT offer.status offer_status,leg.status leg_status,policy.policy_version_id,slot.generation::text generation
    FROM reward_song_slots_v2 slot JOIN song_reward_offers offer ON offer.offer_id=slot.target->>'offer_id'
    JOIN song_reward_offer_legs leg ON leg.leg_id=slot.target->>'pool_leg_id'
    JOIN policy_versions policy ON policy.policy_version_id=offer.reward_policy_version_id WHERE slot.slot_id='prospective-slot'`);
  expect(persisted.rows).toEqual([
    {
      offer_status: "active",
      leg_status: "funding",
      policy_version_id: `shared-policy:${receipt.target.offer_id}`,
      generation: "1",
    },
  ]);
  const now = new Date().toISOString();
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      yield* db.withTransaction((tx) =>
        persistRewardFundingPrincipalIn(tx, {
          receiptId: "purpose-principal",
          contributionId: receipt.contribution_id,
          category: "pool_principal",
          evidence: {
            chain_id: 84532,
            transaction_hash: `0x${"56".repeat(32)}`,
            transfer_log_index: 0,
            sender_nonce: receipt.instruction.nonce,
            block_number: "21",
            block_hash: `0x${h}`,
            block_timestamp: receipt.created_at,
            first_observed_at: now,
            finalized_at: now,
            actual_amount_atomic: receipt.instruction.amount_atomic,
            attestation_id: "attestation",
          },
          senderAddress: receipt.instruction.from,
          recipientAddress: receipt.instruction.recipient_custody,
          tokenAddress: receipt.instruction.to_token,
          instructionHash: receipt.instruction.instruction_hash,
          attestationHash: receipt.instruction.attestation_hash,
          policyHash: h,
          checkpointBlock: "25",
          checkpointHash: `0x${h}`,
          observedConfirmedNonce: "8",
          exactInstruction: true,
        }),
      );
    }).pipe(Effect.provide(jobs)),
  );
  expect(
    (
      await input.owner.query(
        "SELECT funded_atomic::text,status FROM song_reward_offer_legs WHERE leg_id=$1",
        [receipt.target.pool_leg_id],
      )
    ).rows,
  ).toEqual([{ funded_atomic: "2000000", status: "active" }]);
}
