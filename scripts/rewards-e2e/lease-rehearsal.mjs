import { holdRunLease, leaseTiming } from "./run-lease.mjs";

const controlQuery =
  "SELECT paused,revision::text,reason FROM reward_operations_control WHERE singleton";
const leaseQuery = `SELECT run_id, fence::text,
  (run_id IS NOT NULL AND clock_timestamp() < expires_at
    AND clock_timestamp() < absolute_deadline) AS live
  FROM api_next.reward_operations_run_lease WHERE singleton`;
const authorityQuery = "SELECT api_next.require_reward_run_authority_v1()";

/**
 * An unfunded rehearsal of the run lease on the isolated stack. It creates no
 * offer and moves no funds. It shows, against the deployed Workers and the real
 * database, that the runtime role cannot hold or resume anything, that acquiring
 * a lease grants nothing while paused, and that a held lease stays live past its
 * time to live because it was renewed.
 *
 * A runner killed without warning is then proven in two separate phases. First,
 * with the jobs flag off so that nothing can pause the brake, the database is
 * shown refusing authority on lease expiry alone while the brake row still reads
 * running. Only then is the jobs flag turned on and the jobs Worker shown
 * pausing the brake. A refusal seen after a pause proves nothing about expiry,
 * so the two are never read from one observation.
 *
 * It ends paused, with nothing owed and both flags read back off, or says why not.
 *
 * It cannot rehearse an uncertain send: that needs a chain effect, which needs a
 * funded offer. That behaviour is covered by fault injection in the coordinator
 * and database tests.
 */
export async function rehearseRunLease({
  db,
  runIdPrefix,
  flags,
  readShutdownInventory,
  assertShutdownInventory,
  spawnHolder,
  record,
  timing = leaseTiming,
  now = Date.now,
  sleep = (ms) => Bun.sleep(ms),
  leaseClock = {},
}) {
  const findings = [];
  const expect = (name, ok, detail) => {
    findings.push({ name, ok: ok === true, ...(detail === undefined ? {} : { detail }) });
    record({ at: new Date(now()).toISOString(), name, ok: ok === true, detail });
  };
  const control = async () => (await db.read(controlQuery))[0];
  const lease = async () => (await db.read(leaseQuery))[0];
  const authority = () => db.asRuntime(authorityQuery);
  const bothOff = (read) => read?.http === "false" && read?.jobs === "false";
  const waitFor = async (limitMs, probe) => {
    const startedAt = now();
    for (;;) {
      const value = await probe();
      if (value) return { value, afterMs: now() - startedAt };
      if (now() - startedAt >= limitMs) return { value: null, afterMs: now() - startedAt };
      await sleep(5_000);
    }
  };
  let held;
  let holder;
  try {
    const initial = await control();
    if (initial?.paused !== true) throw Error("Rehearsal requires a paused brake");
    assertShutdownInventory(await readShutdownInventory());
    if (!bothOff(await flags.read())) throw Error("Rehearsal requires both flags off");

    // The runtime role may not hold a lease, change one or resume the brake.
    for (const [name, text] of [
      [
        "runtime cannot acquire",
        "SELECT api_next.acquire_reward_run_lease_v1('rehearsal-x',60,600)",
      ],
      ["runtime cannot renew", "SELECT api_next.renew_reward_run_lease_v1('rehearsal-x',1,60)"],
      ["runtime cannot release", "SELECT api_next.release_reward_run_lease_v1('rehearsal-x',1)"],
      [
        "runtime cannot resume",
        "SELECT api_next.set_reward_operations_paused_v1(revision,FALSE,'rehearsal') FROM api_next.reward_operations_control",
      ],
    ]) {
      const code = await db.asRuntime(text);
      expect(name, code === "42501", code);
    }
    expect("brake still paused after refused attempts", (await control()).paused === true);

    // Acquired while paused: no authority until the operator resumes.
    held = await holdRunLease({
      lease: db.lease,
      runId: `${runIdPrefix}-held`,
      timing,
      ...leaseClock,
      onEvent: (event) => record({ lease: "held", ...event }),
    });
    const acquired = await lease();
    expect("a lease acquired while paused is live", acquired.live === true);
    expect("acquisition alone grants no authority", (await authority()) === "PR001");
    const before = await control();
    const resumed = await db.control(false, before.revision, `Isolated lease rehearsal held`);
    expect("authority is granted once resumed under a live lease", (await authority()) === null);

    // Held past its time to live. Only renewal can do that, and the database's
    // own fence, which advances on every renewal, is the evidence that it did.
    await sleep(timing.ttlSeconds * 1000 + 15_000);
    held.assertHeld();
    const kept = await lease();
    expect("a held lease is still live past its time to live", kept.live === true);
    expect(
      "the heartbeat renewed the lease",
      held.state().renewals >= 1 && BigInt(kept.fence) > BigInt(acquired.fence),
      { renewals: held.state().renewals, fenceAtAcquire: acquired.fence, fenceNow: kept.fence },
    );
    expect("authority is still granted past the time to live", (await authority()) === null);

    // An orderly end: pause, then release. Authority goes with the pause.
    const paused = await db.control(
      true,
      resumed.control.revision,
      "Isolated lease rehearsal held",
    );
    const release = await held.release();
    expect("release after pause is accepted", release.released === true);
    expect("a released lease is not live", (await lease()).live === false);
    expect("no authority after an orderly end", (await authority()) === "PR001");
    held = undefined;

    // Phase one. A runner lost without warning, with nothing able to pause the
    // brake: the jobs flag is off, so the jobs Worker runs no rewards cycle.
    expect("flags are off, so nothing can pause the brake", bothOff(await flags.read()));
    holder = await spawnHolder(`${runIdPrefix}-lost`);
    const running = await control();
    expect(
      "the lost runner had resumed the brake under its own lease",
      running.paused === false && (await lease()).run_id === `${runIdPrefix}-lost`,
      { revision: running.revision, after: paused.control.revision },
    );
    expect("authority is granted while the runner lives", (await authority()) === null);
    const killedAt = now();
    await holder.kill();
    record({ at: new Date(killedAt).toISOString(), name: "holder killed" });

    const expired = await waitFor(timing.ttlSeconds * 1000 + 30_000, async () =>
      (await lease()).live === false ? true : null,
    );
    expect("the lost lease ran out", expired.value === true, { afterMs: expired.afterMs });
    // One observation, bracketed by two reads of the brake. It counts only if
    // the brake was running, unchanged, on both sides of the refusal.
    const brakeBefore = await control();
    const refusal = await authority();
    const brakeAfter = await control();
    const flagsAtRefusal = await flags.read();
    expect(
      "authority is refused on lease expiry alone, with the brake still running",
      refusal === "PR001" &&
        brakeBefore.paused === false &&
        brakeAfter.paused === false &&
        brakeBefore.revision === running.revision &&
        brakeAfter.revision === running.revision &&
        bothOff(flagsAtRefusal),
      {
        refusal,
        brakePausedBefore: brakeBefore.paused,
        brakePausedAfter: brakeAfter.paused,
        revisionBefore: brakeBefore.revision,
        revisionAfter: brakeAfter.revision,
        flags: flagsAtRefusal,
      },
    );

    // Phase two. Now let the jobs Worker, which can only pause, make the brake
    // row agree. This is the only flag the rehearsal turns on.
    await flags.enableJobs();
    const pausedByJobs = await waitFor(180_000, async () => {
      const current = await control();
      return current.paused === true ? current : null;
    });
    expect(
      "the jobs Worker paused the brake after expiry",
      pausedByJobs.value?.reason === "reward_run_lease_expired",
      { afterMs: pausedByJobs.afterMs, reason: pausedByJobs.value?.reason },
    );
    expect("no authority after the automatic pause", (await authority()) === "PR001");
  } catch (error) {
    expect(
      "rehearsal completed its steps",
      false,
      error instanceof Error ? error.message : "failed",
    );
  } finally {
    // Leave the stack paused whatever happened. Nothing here resumes.
    try {
      await holder?.kill();
      const current = await control();
      if (current.paused !== true) {
        await db.control(true, current.revision, "Isolated lease rehearsal closeout");
        expect("closeout had to pause the brake itself", false);
      }
      if (held) await held.release();
      expect("brake paused at closeout", (await control()).paused === true);
    } catch (error) {
      expect("closeout pause", false, error instanceof Error ? error.message : "failed");
    }
    try {
      assertShutdownInventory(await readShutdownInventory());
      expect("nothing owed at closeout", true);
      // Whatever was or was not attempted, and whatever any earlier answer
      // said: turn both off, then believe only a fresh read. A flag change
      // whose answer was lost is settled by that read, and asked once more
      // only if the read still shows a flag on.
      let read = null;
      for (let attempt = 0; attempt < 2 && !bothOff(read); attempt++) {
        await flags.disableAll().catch(() => {});
        read = await flags.read().catch(() => null);
      }
      expect("both flags read back off at closeout", bothOff(read), read);
    } catch (error) {
      expect(
        "closeout inventory and flags",
        false,
        error instanceof Error ? error.message : "failed",
      );
    }
  }
  return { passed: findings.every((finding) => finding.ok), findings };
}
