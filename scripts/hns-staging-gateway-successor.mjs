import { open, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { openContinuityDatabase, readContinuityState } from "./hns-continuity/database.mjs";
import { readCookieCensus } from "./hns-staging-gateway/census.mjs";
import {
  applyCookieProfileSuccessor,
  prepareCookieProfileSuccessor,
  readbackCookieProfileSuccessor,
} from "./hns-staging-gateway/cookie.mjs";
import { COOKIE_PLAN_SCHEMA } from "./hns-staging-gateway/cookie-plan.ts";
import { prepareGatewayEntries } from "./hns-staging-gateway/entries.mjs";
import { digest, fail, reference } from "./hns-staging-gateway/identity.mjs";
import { executeGatewayEntries } from "./hns-staging-gateway/transaction.mjs";

const roots = ["8s28", "a18n"];

function manifestPair(previous, next) {
  const before = JSON.parse(previous),
    after = JSON.parse(next);
  fail(previous.length <= 65536 && next.length <= 65536, "Manifest size invalid");
  fail(
    JSON.stringify(before) === previous && JSON.stringify(after) === next,
    "Manifest is not canonical",
  );
  fail(
    before.schema === "pirate-hns-community-app-handle-gateway-staging-public-v1" &&
      before.mode === "staging-public-tls" &&
      before.public_tls_listener === "94.103.168.209:443" &&
      before.solid_origin === "https://hns-community-ingress-staging.pirate.sc",
    "Not the staging gateway",
  );
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
  fail(
    changed.length === 1 &&
      changed[0] === "solid_ingress_composition_reference" &&
      /^solid-hns-ingress-sha256:[0-9a-f]{64}$/u.test(after.solid_ingress_composition_reference),
    "Only the Solid ingress fingerprint may change",
  );
  return { before, after };
}

/** A frozen, short execution window keeps every emitted document byte reviewable.
 * Existing DNS health is inherited, not described as newly observed DNS proof. */
export async function prepareStagingGatewaySuccessor({
  states,
  previousManifest,
  nextManifest,
  readiness,
  sourceCommit,
  executeBy,
}) {
  manifestPair(previousManifest, nextManifest);
  fail(/^[0-9a-f]{40}$/u.test(sourceCommit), "Source commit invalid");
  fail(
    JSON.stringify(states.map((state) => state.dns.canonical_root)) === JSON.stringify(roots),
    "Review both staging roots in order",
  );
  const { rotation, entries } = await prepareGatewayEntries({
    states,
    previousManifest,
    nextManifest,
    readiness,
    sourceCommit,
    executeBy,
  });
  return {
    schema: "pirate-staging-gateway-fingerprint-successor-v1",
    source_commit: sourceCommit,
    execute_by: executeBy,
    previous_manifest: previousManifest,
    next_manifest: nextManifest,
    readiness: rotation,
    entries,
  };
}

async function requireRootSet(client, gateway) {
  const result = await client.query(
    `SELECT c.canonical_root FROM hns_dns_zone_activation_current c
    JOIN hns_dns_zone_activation_revisions r ON r.dns_zone_activation_id=c.dns_zone_activation_id
    AND r.dns_zone_activation_generation=c.current_generation WHERE r.gateway_deployment_reference=$1 ORDER BY c.canonical_root`,
    [gateway],
  );
  fail(
    JSON.stringify(result.rows.map((row) => row.canonical_root)) === JSON.stringify(roots),
    "Gateway root set changed",
  );
}

/** Both roots commit or roll back together. No retry follows an uncertain COMMIT. */
export async function applyStagingGatewaySuccessor({
  client,
  plan,
  confirmedSha256,
  mode = "preflight",
}) {
  fail(
    ["preflight", "rehearse", "commit"].includes(mode) && digest(plan) === confirmedSha256,
    "Unreviewed plan or mode",
  );
  fail(
    plan.schema === "pirate-staging-gateway-fingerprint-successor-v1",
    "Wrong fingerprint plan schema",
  );
  const rebuilt = await prepareStagingGatewaySuccessor({
    states: plan.entries.map((entry) => entry.predecessor),
    previousManifest: plan.previous_manifest,
    nextManifest: plan.next_manifest,
    readiness: plan.readiness,
    sourceCommit: plan.source_commit,
    executeBy: plan.execute_by,
  });
  fail(digest(rebuilt) === confirmedSha256, "Plan does not reproduce exactly");
  return executeGatewayEntries({
    client,
    plan,
    confirmedSha256,
    mode,
    beforeEntries: () => requireRootSet(client, reference(plan.previous_manifest)),
    afterEntries: async () => {
      if (mode !== "preflight") await requireRootSet(client, reference(plan.next_manifest));
    },
  });
}

async function readJson(path) {
  fail(isAbsolute(path), "Use absolute evidence paths");
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(8 * 1024 * 1024 + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    fail(bytesRead > 0 && bytesRead < buffer.length, "Evidence size invalid");
    return JSON.parse(buffer.subarray(0, bytesRead).toString());
  } finally {
    await file.close();
  }
}

export async function main(args = Bun.argv.slice(2)) {
  const [mode, inputPath, confirmedSha256] = args;
  fail(
    ["prepare", "prepare-cookie-profile", "preflight", "rehearse", "commit", "readback"].includes(
      mode,
    ) && args.length === (mode.startsWith("prepare") ? 2 : 3),
    "Usage: prepare|prepare-cookie-profile /absolute/input.json | preflight|rehearse|commit|readback /absolute/plan.json SHA256",
  );
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd });
  const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd });
  const tracked = Bun.spawnSync(
    ["git", "cat-file", "-e", "HEAD:scripts/hns-staging-gateway-successor.mjs"],
    { cwd },
  );
  fail(
    head.exitCode === 0 &&
      tracked.exitCode === 0 &&
      status.exitCode === 0 &&
      status.stdout.length === 0,
    "Use clean reviewed source",
  );
  const source = head.stdout.toString().trim();
  const input = await readJson(inputPath);
  const client = openContinuityDatabase(process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL);
  await client.connect();
  try {
    if (!mode.startsWith("prepare")) {
      fail(input.source_commit === source, "Plan source differs from checkout");
      if (input.schema === COOKIE_PLAN_SCHEMA)
        return await (mode === "readback"
          ? readbackCookieProfileSuccessor
          : applyCookieProfileSuccessor)({ client, plan: input, confirmedSha256, mode });
      return await applyStagingGatewaySuccessor({ client, plan: input, confirmedSha256, mode });
    }
    if (mode === "prepare-cookie-profile")
      fail(
        JSON.stringify(Object.keys(input).sort()) ===
          JSON.stringify([
            "executeBy",
            "nextManifest",
            "outputPath",
            "previousManifest",
            "readiness",
          ]),
        "Unknown cookie preparation field",
      );
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    let states, census;
    try {
      await client.query("SET LOCAL search_path TO api_next, public");
      await client.query("SET LOCAL statement_timeout TO '10s'");
      states = [];
      if (mode === "prepare-cookie-profile") {
        states.push(await readContinuityState(client, "8s28"));
        census = await readCookieCensus(client);
      } else {
        await requireRootSet(client, reference(input.previousManifest));
        for (const root of roots) states.push(await readContinuityState(client, root));
      }
    } finally {
      await client.query("ROLLBACK");
    }
    const prepare =
      mode === "prepare-cookie-profile"
        ? prepareCookieProfileSuccessor
        : prepareStagingGatewaySuccessor;
    const plan = await prepare({ ...input, states, census, sourceCommit: source });
    fail(isAbsolute(input.outputPath), "Plan output path must be absolute");
    await writeFile(input.outputPath, JSON.stringify(plan), { flag: "wx", mode: 0o600 });
    return { mode, plan_sha256: digest(plan), execute_by: plan.execute_by };
  } finally {
    await client.end();
  }
}

if (import.meta.main)
  await main()
    .then((receipt) => console.log(JSON.stringify(receipt)))
    .catch(() => {
      console.error(
        "Staging gateway successor refused. Reconcile current generations before retrying any attempted commit. Credential-bearing errors are suppressed.",
      );
      process.exitCode = 1;
    });
