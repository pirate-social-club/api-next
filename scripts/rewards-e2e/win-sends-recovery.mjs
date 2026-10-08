import { holdRunLease } from "./run-lease.mjs";

/** The isolated stack's gas top-up wallet: the address of the approved gas key. */
export const isolatedGasWallet = "0x85ea2bce79f4cf8489457577ce75f98c47c90c6a";
export const gasWalletQuery =
  "SELECT signer_address FROM reward_gas_topup_wallets WHERE chain_id=84532 AND status='active'";

/**
 * A winner cannot send on without a gas top-up decision, and the HTTP Worker
 * refuses every top-up request while no gas wallet is registered. Checked
 * before anything is funded, so a run cannot pay winners it cannot let send.
 */
export function assertGasWalletRegistered(rows) {
  if (rows.length !== 1 || rows[0].signer_address !== isolatedGasWallet)
    throw Error("Isolated gas top-up wallet is not registered");
  return { gasWallet: isolatedGasWallet };
}

const leaseTiming = Object.freeze({ ttlSeconds: 180, renewEveryMs: 40_000, maxSeconds: 900 });
const shutdownCategoriesThatMayBeOpen = new Set(["unresolved_winner_sends"]);

/**
 * Finishes the onward sends of a forced win that stopped after both winners
 * were paid, and closes the run out. It is bounded settlement recovery: it
 * holds its own run lease of at most 900 seconds, resumes the brake only under
 * that lease, and pauses before it releases. It never funds, buys, claims or
 * pays; it only lets each paid winner send their own prize on, through the same
 * app commands and wallet as the run, under the run's own idempotency keys so a
 * send already reserved is continued rather than duplicated. Every chain action
 * goes through the run's single-use markers in a fresh directory.
 *
 * It starts only when the stack is paused with no live lease, both flags are
 * on, the gas wallet is registered, and nothing is open anywhere except winner
 * sends of the pinned leg's two paid credits. Flags go off, and the lock is
 * cleared, only when every category reads zero afterwards.
 */
export async function completeWinnerSends({
  pinned,
  db,
  flags,
  readShutdownInventory,
  readLegCredits,
  readLegSends,
  openHost,
  sendFor,
  clearLock,
  record,
  timing = leaseTiming,
  leaseClock = {},
  now = Date.now,
  sleep = (ms) => Bun.sleep(ms),
  waitMs = 12 * 60_000,
}) {
  /** @type {{ runId: string, legId: string, errors: string[], sends: unknown[], passed?: boolean, confirmed?: unknown, brake?: unknown, lease?: unknown, shutdown?: Record<string, string>, flags?: unknown }} */
  const result = { runId: pinned.runId, legId: pinned.legId, errors: [], sends: [] };
  const control = async () =>
    (
      await db.read("SELECT paused,revision::text FROM reward_operations_control WHERE singleton")
    )[0];
  const bothOn = (read) => read?.http === "true" && read?.jobs === "true";
  const bothOff = (read) => read?.http === "false" && read?.jobs === "false";

  // Preconditions, all read-only.
  const before = await control();
  if (before?.paused !== true) throw Error("Recovery requires a paused brake");
  const lease = (await db.read(pinned.leaseQuery))[0];
  if (lease?.required !== true || lease.live !== false)
    throw Error("Recovery requires a required lease with none live");
  if (!bothOn(await flags.read())) throw Error("Recovery requires both flags on");
  assertGasWalletRegistered(await db.read(gasWalletQuery));
  const inventory = await readShutdownInventory();
  for (const [category, count] of Object.entries(inventory))
    if (count !== "0" && !shutdownCategoriesThatMayBeOpen.has(category))
      throw Error(`Recovery refused: ${category} is open`);
  const credits = await readLegCredits();
  if (
    credits.length !== 2 ||
    credits.some((credit) => credit.state !== "sent" || credit.paid_atomic !== credit.amount_atomic)
  )
    throw Error("Recovery requires both winners paid");
  const creditIds = new Set(credits.map((credit) => credit.credit_id));
  const openSends = (await readLegSends()).filter((send) => send.status !== "confirmed");
  if (Number(inventory.unresolved_winner_sends) !== openSends.length)
    throw Error("An open winner send is outside the pinned leg");
  if (openSends.some((send) => !creditIds.has(send.credit_id)))
    throw Error("An open winner send is not for a pinned credit");
  record({ stage: "preconditions", before, inventory, openSends });

  let held;
  let host;
  let resumed;
  try {
    held = await holdRunLease({
      lease: db.lease,
      runId: `${pinned.runId}-sends-${now()}`,
      timing,
      ...leaseClock,
      onEvent: (event) => record({ lease: event }),
    });
    resumed = await db.control(false, before.revision, `Isolated ${pinned.runId} onward sends`);
    record({ stage: "resumed", revision: resumed.control.revision });
    const deadline = now() + waitMs;
    const check = async () => {
      held.assertHeld();
      if (now() >= deadline) throw Error("Onward send recovery deadline expired");
      const current = await control();
      if (current.paused || current.revision !== resumed.control.revision)
        throw Error("Brake changed during recovery");
    };
    host = await openHost(check);
    for (const credit of credits) {
      const sends = await readLegSends();
      if (sends.some((send) => send.credit_id === credit.credit_id && send.status === "confirmed"))
        continue;
      result.sends.push(await sendFor(host, credit, { deadline }, check));
    }
    for (;;) {
      await check();
      const sends = await readLegSends();
      if (sends.length === 2 && sends.every((send) => send.status === "confirmed")) {
        result.confirmed = sends;
        break;
      }
      await sleep(5_000);
    }
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : "failed");
  } finally {
    try {
      await host?.close();
    } catch {
      result.errors.push("browser closeout failed");
    }
    // Pause, then release. Nothing below resumes.
    try {
      const current = await control();
      if (!current.paused)
        await db.control(true, current.revision, `Isolated ${pinned.runId} onward sends closeout`);
      result.brake = await control();
      if (result.brake?.paused !== true) result.errors.push("brake pause not verified");
    } catch {
      result.errors.push("brake pause refused");
    }
    if (held) {
      const state = held.state();
      const release = await held.release();
      result.lease = { ...state, ...release };
      if (state.lost !== null) result.errors.push(`run lease lost: ${state.lost}`);
      else if (release.released !== true) result.errors.push("run lease release refused");
    }
  }
  // Flags go off only when nothing is owed anywhere, believed from a fresh read.
  try {
    result.shutdown = await readShutdownInventory();
    const open = Object.entries(result.shutdown).filter(([, count]) => count !== "0");
    if (open.length > 0) throw Error(open.map(([category]) => category).join(", "));
    // A send that failed before its row existed is not counted anywhere, so
    // zero is not enough: the flags stay on until both sends are confirmed,
    // and a retry of this recovery still finds them on.
    if (result.confirmed === undefined) throw Error("onward sends not confirmed");
    let read = null;
    for (let attempt = 0; attempt < 2 && !bothOff(read); attempt++) {
      await flags.disableAll().catch(() => {});
      read = await flags.read().catch(() => null);
    }
    result.flags = read;
    if (!bothOff(read)) result.errors.push("flags not read back off");
  } catch (error) {
    result.errors.push(
      `obligations remain; flags left on: ${error instanceof Error ? error.message : "unreadable"}`,
    );
  }
  result.passed = result.errors.length === 0 && result.confirmed !== undefined;
  if (result.passed) clearLock();
  return result;
}
