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
 * a lease grants nothing while paused, that a held lease stays live past its
 * time to live, and that a runner killed without warning loses admission and
 * signing authority when the lease runs out, after which the jobs Worker pauses
 * the brake. It ends paused, with nothing owed and both flags off, or says why not.
 *
 * It cannot rehearse an uncertain send: that needs a chain effect, which needs a
 * funded offer. That behaviour is covered by the coordinator and database tests.
 */
export async function rehearseRunLease({
  db,
  runIdPrefix,
  enableFlags,
  disableFlags,
  readShutdownInventory,
  assertShutdownInventory,
  spawnHolder,
  record,
  timing = leaseTiming,
  now = Date.now,
  sleep = (ms) => Bun.sleep(ms),
}) {
  const findings = [];
  const expect = (name, ok, detail) => {
    findings.push({ name, ok: ok === true, ...(detail === undefined ? {} : { detail }) });
    record({ at: new Date(now()).toISOString(), name, ok: ok === true, detail });
  };
  const control = async () => (await db.read(controlQuery))[0];
  const lease = async () => (await db.read(leaseQuery))[0];
  const authority = () => db.asRuntime(authorityQuery);
  const waitFor = async (limitMs, probe) => {
    const startedAt = now();
    for (;;) {
      const value = await probe();
      if (value) return { value, afterMs: now() - startedAt };
      if (now() - startedAt >= limitMs) return { value: null, afterMs: now() - startedAt };
      await sleep(5_000);
    }
  };
  let flagsOn = false;
  let held;
  let holder;
  try {
    const initial = await control();
    if (initial?.paused !== true) throw Error("Rehearsal requires a paused brake");
    assertShutdownInventory(await readShutdownInventory());

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

    await enableFlags();
    flagsOn = true;

    // Acquired while paused: no authority until the operator resumes.
    held = await holdRunLease({
      lease: db.lease,
      runId: `${runIdPrefix}-held`,
      timing,
      onEvent: (event) => record({ lease: "held", ...event }),
    });
    expect("a lease acquired while paused is live", (await lease()).live === true);
    expect("acquisition alone grants no authority", (await authority()) === "PR001");
    const before = await control();
    const resumed = await db.control(false, before.revision, `Isolated lease rehearsal held`);
    expect("authority is granted once resumed under a live lease", (await authority()) === null);

    // Held past its time to live: the heartbeat, not the first grant, keeps it live.
    await sleep(timing.ttlSeconds * 1000 + 15_000);
    held.assertHeld();
    expect("a held lease is still live past its time to live", (await lease()).live === true, {
      renewals: held.state().renewals,
    });
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

    // A runner lost without warning. Nothing pauses, releases or tells anyone.
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

    // The database stops granting authority on its own once the lease runs out.
    const refused = await waitFor(timing.ttlSeconds * 1000 + 30_000, async () =>
      (await authority()) === "PR001" ? { brake: await control() } : null,
    );
    expect("authority is refused after the lease runs out", refused.value !== null, {
      afterMs: refused.afterMs,
      brakePausedWhenFirstRefused: refused.value?.brake.paused,
    });
    expect("the lost lease is not live", (await lease()).live === false);

    // Then the jobs Worker, which can only pause, makes the brake row agree.
    const pausedByJobs = await waitFor(150_000, async () => {
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
      if (flagsOn) {
        const disabled = await disableFlags();
        expect("flags off at closeout", disabled.flagsOff === true);
      }
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
