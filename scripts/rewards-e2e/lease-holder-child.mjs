/**
 * A stand-in for a runner that is about to be lost. It acquires a run lease,
 * resumes the brake and keeps renewing until it is killed. The rehearsal kills it
 * without warning; it has no shutdown path on purpose.
 */
import { readFileSync } from "node:fs";
import { isolatedDatabase } from "./database-evidence.mjs";
import { holdRunLease } from "./run-lease.mjs";

const [identityPath, runId] = process.argv.slice(2);
const say = (event) => console.log(JSON.stringify(event));
const db = isolatedDatabase(
  JSON.parse(readFileSync(identityPath, "utf8")),
  process.env.REWARDS_RUNNER_ADMIN_URL,
  process.env.REWARDS_RUNNER_RUNTIME_URL,
);
const held = await holdRunLease({ lease: db.lease, runId, onEvent: say });
const control = (
  await db.read("SELECT paused,revision::text FROM reward_operations_control WHERE singleton")
)[0];
if (control?.paused !== true) throw Error("Holder expects a paused brake");
const resumed = await db.control(false, control.revision, `Isolated lease rehearsal ${runId}`);
say({ kind: "resumed", revision: resumed.control.revision, lease: held.state() });
// Stay alive, renewing, until killed.
setInterval(() => {}, 60_000);
