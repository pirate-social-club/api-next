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
  successor?: boolean;
}) {
  const { start, postId } = await seedProspectiveSongFundingFixture(input.admin, input.successor);
  const h = "a".repeat(64),
    jobs = makeDirectPostgresControlPlaneLayer(input.jobs),
    http = makeDirectPostgresControlPlaneLayer(input.http);
  const authority = makeControlPlaneRewardRunAuthority(jobs);
  const headTimestamp = BigInt(Math.floor(Date.now() / 1000));
  const producer = makeControlPlaneSharedSongContextProducer({
    runtime: jobs,
    now: () => new Date().toISOString(),
    rpcFor: (deployment) => ({
      deployment,
      attestDeploymentAt: async () => {},
      readHead: async () => ({
        blockNumber: 20n,
        blockHash: `0x${h}`,
        blockTimestamp: headTimestamp,
      }),
      readBlock: async (blockNumber) => ({
        blockNumber,
        blockHash: `0x${h}`,
        blockTimestamp: headTimestamp,
      }),
      readTransactionCount: async () => 7n,
      readPendingNonce: async () => 7n,
      readNativeBalance: async () => 1000000000000000000n,
      readCurrentDrawingId: async () => (input.successor ? 100n : 101n),
      readDrawingRecurrence: async () => ({ durationSeconds: 1800n, ticketPrice: 10000n }),
      readDrawing: async (id) => ({
        prizePool: 0n,
        ticketPrice: input.successor ? 10000n : 1000000n,
        edgePerTicket: 0n,
        referralWinShare: 0n,
        referralFee: 0n,
        globalTicketsBought: 0n,
        lpEarnings: 0n,
        drawingTime:
          BigInt(Math.floor(start / 1000)) + (input.successor ? 1800n : (id - 100n) * 3600n),
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
    funding_amount_atomic: context.limits.maximum_atomic,
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
  // Exercise the exact website boundary: create -> private projection -> claim
  // under the dedicated HTTP role, before the Jobs principal acceptance proof.
  const ownScope = { ...scope, contributionId: receipt.contribution_id };
  const current = async () =>
    Schema.decodeUnknownSync(Schema.Struct({ accountId: C.IdV2, current: C.CurrentStateV2 }))(
      await Effect.runPromise(reads.current(ownScope, "b")),
    ).current;
  const immutableBeforeRead = await snapshot();
  const available = await current();
  expect(available.allowed_actions).toContain("claim_funding_submission");
  expect(available.allowed_actions).not.toContain("prepare_nonce_cancellation");
  expect(available.pause_reason).toBeNull();
  expect(await snapshot()).toEqual(immutableBeforeRead);
  expect(await Effect.runPromise(reads.current(ownScope, "foreign"))).toBeNull();
  expect(
    await Effect.runPromise(reads.current({ ...ownScope, postId: "foreign" }, "b")),
  ).toBeNull();
  const disabledReads = makeControlPlaneSongContributionReadPorts(http, auth, {
    rewardsEnabled: false,
  });
  const disabled = Schema.decodeUnknownSync(
    Schema.Struct({ accountId: C.IdV2, current: C.CurrentStateV2 }),
  )(await Effect.runPromise(disabledReads.current(ownScope, "b"))).current;
  expect(disabled.allowed_actions).not.toContain("claim_funding_submission");
  expect(disabled.pause_reason).toBe("paused");
  expect(disabled.command_receipt).toEqual(receipt);
  expect(disabled.allowed_actions).toContain("recover_original");
  const role = decodeURIComponent(new URL(input.http).username);
  const identity = JSON.stringify({ ...ownScope, accountId: "b" });
  // Fixture-only transactions change one guard at a time. SET LOCAL ROLE makes
  // the read use the same narrow privileges, and rollback restores each fixture.
  for (const sql of [
    "SELECT set_reward_operations_paused_v1(revision,true,'fixture pause') FROM reward_operations_control WHERE singleton",
    "SELECT set_config('pirate.reward_run_lease_requirement_change','deployment',true); UPDATE reward_operations_run_lease SET required=true,run_id='expired-fixture',acquired_at=clock_timestamp()-interval '1 hour',expires_at=clock_timestamp()-interval '1 second',absolute_deadline=clock_timestamp()+interval '1 hour' WHERE singleton",
    "UPDATE reward_funding_profiles_v2 SET accepted=false",
    "UPDATE megapot_deployment_attestations SET status='retired',retired_at=clock_timestamp()",
    "UPDATE persona_wallet_assignments SET status='tombstoned',tombstoned_at=clock_timestamp() WHERE account_id='b'",
    "SELECT set_reward_operations_paused_v1(revision,true,'fixture past pause') FROM reward_operations_control WHERE singleton; SELECT set_reward_operations_paused_v1(revision,false,'fixture unpause') FROM reward_operations_control WHERE singleton",
    "UPDATE song_megapot_contributions_v2 SET state=jsonb_set(state,'{effectiveDeadline}',to_jsonb(to_char(clock_timestamp()-interval '1 second','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))) WHERE account_id='b'",
  ]) {
    await input.admin.query("BEGIN");
    try {
      // These isolated negative fixtures represent immutable rows that were
      // admitted with unavailable policy or expired authority, not runtime edits.
      const fixtureOnly =
        sql.startsWith("UPDATE reward_funding_profiles") ||
        sql.startsWith("UPDATE persona_wallet_assignments") ||
        sql.startsWith("UPDATE song_megapot_contributions");
      if (fixtureOnly) await input.admin.query("SET LOCAL session_replication_role=replica");
      await input.admin.query(sql);
      if (fixtureOnly) await input.admin.query("SET LOCAL session_replication_role=origin");
      await input.admin.query(`SET LOCAL ROLE "${role.replaceAll('"', '""')}"`);
      const projected = (
        await input.admin.query(
          "SELECT read_owned_song_contribution_current_v2($1::jsonb) packet",
          [identity],
        )
      ).rows[0].packet.current;
      expect(projected.allowed_actions).not.toContain("claim_funding_submission");
      expect(projected.command_receipt).toEqual(receipt);
    } finally {
      await input.admin.query("ROLLBACK");
    }
  }
  const claim: C.SubmissionClaimRequestV2 = {
    idempotency_key: "purpose_original_claim_0001",
    expected_state_revision: available.revision,
    instruction_hash: receipt.instruction.instruction_hash,
    purpose: "funding_transfer" as const,
    client_instance_id: "purpose_client_0001",
    submission_attempt_id: "purpose_attempt_0001",
  };
  const claimed = await Effect.runPromise(
    service.execute("ClaimSongMegapotContributionSubmissionV2", ownScope, claim),
  );
  expect(claimed).toMatchObject({
    receipt: { purpose: "funding_transfer" },
    delivery: { kind: "fresh_grant" },
  });
  expect((await current()).allowed_actions).not.toContain("claim_funding_submission");
  expect(
    await Effect.runPromise(
      service.execute("ClaimSongMegapotContributionSubmissionV2", ownScope, claim),
    ),
  ).toMatchObject({ delivery: { kind: "recovery_only" } });
  await expect(
    Effect.runPromise(
      service.execute("ClaimSongMegapotContributionSubmissionV2", ownScope, {
        ...claim,
        idempotency_key: "purpose_original_claim_0002",
        expected_state_revision: (await current()).revision,
      }),
    ),
  ).rejects.toMatchObject({ code: "submission_already_claimed" });
  await input.admin.query("BEGIN");
  try {
    await input.admin.query(
      "SELECT set_reward_operations_paused_v1(revision,true,'claimed pause') FROM reward_operations_control WHERE singleton",
    );
    await input.admin.query(
      "SELECT set_reward_operations_paused_v1(revision,false,'claimed unpause') FROM reward_operations_control WHERE singleton",
    );
    await input.admin.query(`SET LOCAL ROLE "${role.replaceAll('"', '""')}"`);
    const invalidated = (
      await input.admin.query("SELECT read_owned_song_contribution_current_v2($1::jsonb) packet", [
        identity,
      ])
    ).rows[0].packet.current;
    expect(invalidated.pause_reason).toBe("instruction_expired");
    expect(invalidated.state).toBe("expired_reconciling");
    expect(invalidated.submissions).toHaveLength(1);
    expect(invalidated.submissions[0].state).toBe("claimed");
    expect(invalidated.command_receipt).toEqual(receipt);
  } finally {
    await input.admin.query("ROLLBACK");
  }
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
  ).toEqual([{ funded_atomic: receipt.instruction.amount_atomic, status: "active" }]);
  return { receipt, context, start, postId };
}
