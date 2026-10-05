import { assertNothingOwed, assertShutdownInventory } from "./database-evidence.mjs";

const settledTickets = ["claimed", "no_win"];

/** Bounded so a stuck offer cannot hold the isolated stack open indefinitely. */
export function recoveryDeadline(now, drawingTimeSeconds) {
  const afterDrawing = drawingTimeSeconds * 1000 + 10 * 60000;
  return Math.min(now + 30 * 60000, Math.max(now + 5 * 60000, afterDrawing));
}

/**
 * Settles what a failed run already admitted before the stack is shut down.
 * An unfunded or shareless leg refunds after expiry; a purchased ticket is
 * settled on the fixture and then refunded or credited; an unpaid credit is
 * claimed and paid. Each step is attempted once: a refused or uncertain step
 * is recorded and never replayed. The brake is never resumed here, and the
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
  const stop = (reason, inventory) => ({ settled: false, reason, actions, inventory });
  let inventory;
  while (now() < deadline) {
    const control = await readControl();
    if (control?.paused !== false || control.revision !== expectedRevision)
      return stop("Brake is paused or changed; settlement cannot continue", inventory);
    inventory = await readInventory();
    let legSettled = false;
    try {
      assertNothingOwed(inventory);
      legSettled = true;
    } catch {}
    if (legSettled) {
      try {
        assertShutdownInventory(await readShutdownInventory());
        return { settled: true, reason: null, actions, inventory };
      } catch {}
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
