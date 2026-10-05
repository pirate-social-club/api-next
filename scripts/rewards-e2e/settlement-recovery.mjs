import { assertNothingOwed, assertShutdownInventory } from "./database-evidence.mjs";

const settledTickets = ["claimed", "no_win"];

/** Bounded so a stuck offer cannot hold the isolated stack open indefinitely. */
export function recoveryDeadline(now, drawingTimeSeconds) {
  // A run can fail before its drawing time exists; nothing can be owed then.
  if (!Number.isFinite(drawingTimeSeconds)) return now + 5 * 60000;
  const afterDrawing = drawingTimeSeconds * 1000 + 10 * 60000;
  return Math.min(now + 30 * 60000, Math.max(now + 5 * 60000, afterDrawing));
}

/**
 * Settles what a failed run already admitted before the stack is shut down.
 * An unfunded or shareless leg refunds after expiry; a purchased ticket is
 * settled on the fixture and then refunded or credited; an unpaid credit is
 * claimed and paid. Each step is attempted once here. A claim the run already
 * submitted is never repeated; the fixture settlement may be attempted again
 * because the contract refuses a second one. The brake is never resumed, and the
 * caller keeps the flags on whenever this returns unsettled.
 */
export async function recoverSettlement({
  deadline,
  roles,
  readControl,
  expectedRevision,
  readInventory,
  readShutdownInventory,
  advance,
  claim,
  now = Date.now,
  sleep = (ms) => Bun.sleep(ms),
}) {
  const actions = [];
  const attempted = new Set();
  let readFailures = 0;
  const once = async (id, action) => {
    if (attempted.has(id)) return;
    attempted.add(id);
    try {
      await action();
      actions.push({ id, outcome: "completed" });
    } catch (error) {
      actions.push({
        id,
        outcome: "refused-or-uncertain",
        reason: error instanceof Error ? error.message : "Unknown recovery refusal",
      });
    }
  };
  const stop = (reason, inventory) => ({
    settled: false,
    reason,
    actions,
    inventory,
    readFailures,
  });
  let inventory;
  while (now() < deadline) {
    let control;
    try {
      control = await readControl();
      inventory = await readInventory();
    } catch {
      // Reads are safe to repeat; one refused connection must not strand a refund.
      readFailures++;
      await sleep(3000);
      continue;
    }
    if (control?.paused !== false || control.revision !== expectedRevision)
      return stop("Brake is paused or changed; settlement cannot continue", inventory);
    // Without a captured leg only the whole stack's inventory can show settlement.
    let legSettled = inventory === null;
    if (inventory !== null)
      try {
        assertNothingOwed(inventory);
        legSettled = true;
      } catch {}
    if (legSettled) {
      try {
        assertShutdownInventory(await readShutdownInventory());
        return { settled: true, reason: null, actions, inventory, readFailures };
      } catch {}
    }
    if (inventory === null) {
      await sleep(3000);
      continue;
    }
    const purchase = inventory.purchases[0];
    if (
      inventory.purchases.length === 1 &&
      purchase.state === "confirmed" &&
      purchase.ticket_id !== null &&
      !settledTickets.includes(purchase.ticket_status)
    )
      await once("advance-purchased-drawing", () => advance(purchase));
    for (const role of roles) {
      if (attempted.has(`claim-${role.name}`)) continue;
      const credit = inventory.credits.find((row) => row.account_id === role.accountId);
      if (credit && credit.state !== "sent")
        await once(`claim-${role.name}`, () => claim(role.name, inventory));
    }
    await sleep(3000);
  }
  return stop("Settlement recovery deadline expired", inventory);
}
