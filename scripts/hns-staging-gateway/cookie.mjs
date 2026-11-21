import { readContinuityState } from "../hns-continuity/database.mjs";
import {
  cookieCensusIdentity,
  lockCookieCensus,
  readCookieCensus,
  requireCookieCensus,
  requireUnchangedCookieCensus,
} from "./census.mjs";
import {
  COOKIE_PLAN_SCHEMA,
  decodeCookiePlan,
  NEXT_GATEWAY,
  requireCookieManifestPair,
} from "./cookie-plan.ts";
import { prepareGatewayEntries } from "./entries.mjs";
import { digest, fail, stateIdentity } from "./identity.mjs";
import { requireExactCookieSuccessor } from "./successor-state.mjs";
import { executeGatewayEntries } from "./transaction.mjs";

export async function prepareCookieProfileSuccessor({
  states,
  census,
  previousManifest,
  nextManifest,
  readiness,
  sourceCommit,
  executeBy,
}) {
  requireCookieManifestPair(previousManifest, nextManifest);
  fail(
    states.length === 1 && states[0].dns.canonical_root === "8s28",
    "Cookie profile selects only 8s28",
  );
  const checked = requireCookieCensus(census, states[0]);
  const observed = Date.parse(checked.database_time);
  fail(
    Date.parse(checked.roots.find((tenant) => tenant.root === "8s28").recovery.expires_at) >
      Date.parse(executeBy) + 5000,
    "Recovered namespace cannot cover the execution window",
  );
  fail(
    Number.isFinite(observed) &&
      states.every(
        (state) =>
          Date.parse(state.database_time) <= observed &&
          observed - Date.parse(state.database_time) <= 60000,
      ),
    "Census and predecessor clocks disagree",
  );
  fail(
    Date.parse(readiness.observed_at) <= observed &&
      new Date(states[0].inventory.published_at).getTime() <= observed,
    "Cookie observation is in the future",
  );
  const { rotation, entries } = await prepareGatewayEntries({
    states: states.map((state) => ({ ...state, database_time: checked.database_time })),
    previousManifest,
    nextManifest,
    readiness,
    sourceCommit,
    executeBy,
  });
  // Preserve the exact read predecessor, including its own observation clock.
  // Only the document window above uses the later, complete census clock.
  entries[0].predecessor.database_time = states[0].database_time;
  return decodeCookiePlan({
    schema: COOKIE_PLAN_SCHEMA,
    source_commit: sourceCommit,
    execute_by: executeBy,
    previous_manifest: previousManifest,
    next_manifest: nextManifest,
    readiness: rotation,
    census: checked,
    census_sha256: cookieCensusIdentity(checked),
    entries,
  });
}

async function reviewedCookiePlan(raw, confirmedSha256) {
  const plan = decodeCookiePlan(raw);
  fail(digest(raw) === confirmedSha256, "Unreviewed cookie plan");
  const rebuilt = await prepareCookieProfileSuccessor({
    states: plan.entries.map((entry) => entry.predecessor),
    census: plan.census,
    previousManifest: plan.previous_manifest,
    nextManifest: plan.next_manifest,
    readiness: plan.readiness,
    sourceCommit: plan.source_commit,
    executeBy: plan.execute_by,
  });
  fail(digest(rebuilt) === confirmedSha256, "Cookie plan does not reproduce exactly");
  return plan;
}

export async function applyCookieProfileSuccessor({
  client,
  plan: raw,
  confirmedSha256,
  mode = "preflight",
}) {
  fail(["preflight", "rehearse", "commit"].includes(mode), "Unreviewed cookie mode");
  const plan = await reviewedCookiePlan(raw, confirmedSha256);
  return executeGatewayEntries({
    client,
    plan,
    confirmedSha256,
    mode,
    beforeEntries: async () => {
      if (mode !== "preflight") await lockCookieCensus(client);
      const current = await readCookieCensus(
        client,
        plan.census.roots.map((tenant) => tenant.root),
      );
      requireCookieCensus(current);
      fail(
        cookieCensusIdentity(current) === plan.census_sha256,
        "Cookie predecessor census changed; prepare again",
      );
    },
    afterEntries: async () => {
      const after = await readCookieCensus(
        client,
        plan.census.roots.map((tenant) => tenant.root),
      );
      requireUnchangedCookieCensus(plan.census, after, mode !== "preflight");
      requireCookieCensus(after, undefined, mode === "preflight" ? undefined : NEXT_GATEWAY);
      const state = await readContinuityState(client, "8s28");
      if (mode !== "preflight") await requireExactCookieSuccessor(plan, after, state);
      fail(
        Date.parse(state.database_time) <= Date.parse(plan.execute_by),
        "Cookie execution window elapsed",
      );
    },
  });
}

/** A lost acknowledgement never selects retry or transport rollback. This
 * reports only an exact committed/not-committed state at the read snapshot;
 * any changed authority is unknown and requires a fresh reviewed successor. */
export async function readbackCookieProfileSuccessor({ client, plan: raw, confirmedSha256 }) {
  const plan = await reviewedCookiePlan(raw, confirmedSha256);
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query("SET LOCAL search_path TO api_next, public");
    await client.query("SET LOCAL statement_timeout TO '20s'");
    const census = await readCookieCensus(
      client,
      plan.census.roots.map((tenant) => tenant.root),
    );
    const current = await readContinuityState(client, "8s28");
    const entry = plan.entries[0];
    let outcome = "unknown";
    if (
      cookieCensusIdentity(census) === plan.census_sha256 &&
      stateIdentity(current) === entry.predecessor_sha256
    )
      outcome = "not_committed";
    else {
      try {
        requireUnchangedCookieCensus(plan.census, census, true);
        requireCookieCensus(census, undefined, NEXT_GATEWAY);
        await requireExactCookieSuccessor(plan, census, current);
        outcome = "committed";
      } catch {
        outcome = "unknown";
      }
    }
    return {
      mode: "readback",
      plan_sha256: confirmedSha256,
      outcome,
      automatic_retry: false,
      observed_at: census.database_time,
    };
  } finally {
    await client.query("ROLLBACK");
  }
}
