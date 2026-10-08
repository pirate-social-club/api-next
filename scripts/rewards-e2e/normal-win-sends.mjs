import { fixtureAccounts } from "./browser-accounts.mjs";
import { observePaidCredit, submitPaidCredit } from "./browser-winner-send.mjs";
import { assertNothingOwed, readShutdownInventory, runLeaseQuery } from "./database-evidence.mjs";
import { claimParticipantCredit } from "./participant-claims.mjs";
import { singleParticipantCredit } from "./participant-policy.mjs";
import { waitForEvidence } from "./run-evidence.mjs";
import {
  assertIsolatedServingSource,
  disableIsolatedRewards,
  readIsolatedRewardsFlags,
} from "./runtime-flags.mjs";
import { completeWinnerSends } from "./win-sends-recovery.mjs";

/** Finish server obligations first, then use the same capped onward flow as recovery. */
export async function completeNormalWin({
  run,
  legId,
  host,
  allocated,
  driver,
  db,
  lease,
  check,
  record,
  claim = claimParticipantCredit,
  wait = waitForEvidence,
  finish = completeWinnerSends,
}) {
  for (const role of ["study", "karaoke"])
    await claim(host.pages[role], role, allocated, run, check);
  await wait(
    "paid credits and sponsor refund before passive finality",
    run.deadline,
    () => run.inventory(),
    (inventory) => {
      try {
        assertNothingOwed(inventory);
        return inventory.refunds.length === 1 && inventory.refunds[0].amount_atomic === "990000";
      } catch {
        return false;
      }
    },
    check,
  );
  await check();
  const current = (
    await db.read("SELECT paused,revision::text FROM reward_operations_control WHERE singleton")
  )[0];
  await db.control(true, current.revision, `Isolated ${run.runId} server settlement complete`);
  const release = await lease.release();
  if (lease.state().lost !== null || release.released !== true)
    throw Error("Original run lease release not verified");
  const result = await finish({
    pinned: { runId: run.runId, legId, leaseQuery: runLeaseQuery },
    db,
    flags: {
      read: () => readIsolatedRewardsFlags(),
      disableAll: () => disableIsolatedRewards(run.apiSource),
    },
    readShutdownInventory: () => readShutdownInventory(db),
    readLegCredits: async () => (await run.inventory()).credits,
    readLegSends: () =>
      db.read(
        `SELECT send.send_id,send.credit_id,send.status FROM reward_winner_sends send
      JOIN megapot_allocations allocation USING(credit_id) JOIN megapot_allocation_batches batch USING(allocation_batch_id)
      WHERE batch.pool_leg_id=$1`,
        [legId],
      ),
    // The enclosing scenario retains custody of its browser host.
    openHost: async () => ({ pages: host.pages, close: async () => {} }),
    sendFor: (live, credit, { deadline }, signingCheck) => {
      const role = credit.account_id === fixtureAccounts.study.accountId ? "study" : "karaoke";
      return submitPaidCredit(
        live.pages[role],
        role,
        singleParticipantCredit([credit], role),
        { ...run, deadline },
        driver,
        signingCheck,
      );
    },
    observeFor: (live, credit, submission) => {
      const role = credit.account_id === fixtureAccounts.study.accountId ? "study" : "karaoke";
      return observePaidCredit(live.pages[role], credit, submission);
    },
    checkServing: () => assertIsolatedServingSource(run.apiSource),
    // The outer runner owns the complete win/loss command's lock.
    clearLock: () => {},
    record,
  });
  if (!result.passed) throw Error(`Onward completion failed: ${result.errors.join(", ")}`);
  return result;
}

export function passiveSettlementClock(db, expectedBrake) {
  const deadline = Date.now() + 5 * 60000;
  const check = async () => {
    if (Date.now() >= deadline) throw Error("Settlement evidence deadline expired");
    const control = (
      await db.read("SELECT paused,revision::text FROM reward_operations_control WHERE singleton")
    )[0];
    const lease = (await db.read(runLeaseQuery))[0];
    if (!control.paused || control.revision !== expectedBrake.revision || lease?.live !== false)
      throw Error("Passive settlement requires the same paused brake and no live lease");
  };
  return { deadline, check };
}
