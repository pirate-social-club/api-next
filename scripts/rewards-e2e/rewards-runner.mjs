import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { loadPostgresMigrations } from "../postgres-migrations.ts";
import { fixtureAccounts } from "./browser-accounts.mjs";
import { prepareFixtureBrowsers } from "./browser-host.mjs";
import { buildBrowserWalletDriver } from "./browser-wallet-build.mjs";
import { sendPaidCredit } from "./browser-winner-send.mjs";
import { cloudflareApi } from "./cloudflare-api.mjs";
import { verifyCommitmentReader } from "./commitment-reader.mjs";
import {
  assertRunLeaseReady,
  assertShutdownInventory,
  isolatedDatabase,
  readRunInventory,
  readShutdownInventory,
  runLeaseQuery,
} from "./database-evidence.mjs";
import { fixtureChain, readFixturePrize, readManagedFloat } from "./fixture-chain.mjs";
import { readFixtureMicrophone } from "./fixture-microphone.mjs";
import { rehearseRunLease } from "./lease-rehearsal.mjs";
import { singleParticipantCredit } from "./participant-policy.mjs";
import { runScenario } from "./run-scenario.mjs";
import {
  disableIsolatedRewards,
  inspectIsolatedWorker,
  readIsolatedRewardsFlags,
  setIsolatedRewardsFlag,
} from "./runtime-flags.mjs";
import { assertLossBudget, assertPairBudget } from "./spending-ledger.mjs";
import {
  assertGasWalletRegistered,
  completeWinnerSends,
  gasWalletQuery,
} from "./win-sends-recovery.mjs";

/** Enter both existing approved stores without writing credentials to disk or stdout. */
if (!process.env.REWARDS_RUNNER_CREDENTIALS_LOADED) {
  const args = process.argv.slice(2);
  const preserve =
    process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL && process.env.CONTROL_PLANE_POSTGRES_RUNTIME_URL;
  const child = spawnSync(
    "infisical",
    [
      "run",
      "--env",
      "staging",
      "--path",
      preserve ? "/services/api-next/operator" : "/services/rewards-e2e-runner",
      "--silent",
      "--",
      "bun",
      import.meta.filename,
      ...args,
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        ...(preserve
          ? {
              REWARDS_RUNNER_ADMIN_URL: process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL,
              REWARDS_RUNNER_RUNTIME_URL: process.env.CONTROL_PLANE_POSTGRES_RUNTIME_URL,
              REWARDS_RUNNER_CREDENTIALS_LOADED: "true",
            }
          : {}),
      },
    },
  );
  process.exit(child.status ?? 1);
}

const root = resolve(import.meta.dir, "../..");
const evidenceRoot = process.env.REWARDS_E2E_EVIDENCE_ROOT;
if (!evidenceRoot || !isAbsolute(evidenceRoot))
  throw Error("Absolute durable REWARDS_E2E_EVIDENCE_ROOT required");
const authorityBytes = readFileSync(resolve(evidenceRoot, "owner-authorization.json"));
const authority = JSON.parse(authorityBytes);
const authoritySha256 = createHash("sha256").update(authorityBytes).digest("hex");
if (
  authoritySha256 !== "77aea94b229efeb0920d0270f8cf25e508607d836f2d6f8d33da87e6f5dfb003" ||
  authority.scope.chainId !== 84532 ||
  authority.scope.sharedStaging !== false ||
  authority.scope.mainnet !== false
)
  throw Error("Recorded isolated authority differs");
const identity = JSON.parse(readFileSync(resolve(evidenceRoot, "database-identity.json"), "utf8"));
const apiSource = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], {
  cwd: root,
  encoding: "utf8",
}).trim();
if (dirty) throw Error("Runner source must be committed before preparation");
const db = isolatedDatabase(
  identity,
  process.env.REWARDS_RUNNER_ADMIN_URL,
  process.env.REWARDS_RUNNER_RUNTIME_URL,
);
const expectedMigrations = await loadPostgresMigrations();
const ledger = await db.read("SELECT version,checksum FROM schema_migrations ORDER BY version");
if (
  ledger.length !== expectedMigrations.length ||
  ledger.some(
    (row, index) =>
      row.version !== expectedMigrations[index].version ||
      row.checksum !== expectedMigrations[index].checksum,
  )
)
  throw Error("Isolated database source ledger differs");
if (process.argv.includes("--complete-win-sends")) {
  // Bounded settlement recovery for a forced win that stopped after both
  // winners were paid. The Workers still serve this release with rewards on,
  // which is why it runs before the dark-Worker checks of a fresh preparation.
  const runDirectory = process.argv[process.argv.indexOf("--complete-win-sends") + 1];
  const lock = resolve(evidenceRoot, "runner-active.json");
  const held = JSON.parse(readFileSync(lock, "utf8"));
  if (!runDirectory || resolve(runDirectory) !== held.directory)
    throw Error("Recovery must name the run directory that holds the lock");
  // The Workers keep serving the locked run's source. A newer runner may drive
  // them only if nothing but the runner itself changed since that source.
  if (!/^[0-9a-f]{40}$/.test(held.apiSource ?? "")) throw Error("Locked run source unreadable");
  const changed = execFileSync("git", ["diff", "--name-only", held.apiSource, apiSource], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  if (changed.some((path) => !path.startsWith("scripts/rewards-e2e/")))
    throw Error("Recovery runner differs from the locked run beyond the runner scripts");
  for (const kind of ["http", "jobs"]) {
    const version = await inspectIsolatedWorker(kind);
    if (!version.annotations?.["workers/message"]?.startsWith(`git:${held.apiSource}`))
      throw Error("Isolated Workers must serve the locked run's source");
  }
  const winDirectory = resolve(held.directory, "win");
  const runId = JSON.parse(
    readFileSync(resolve(winDirectory, "run-lease-acquired.json"), "utf8"),
  ).runId;
  const legId = JSON.parse(readFileSync(resolve(winDirectory, "offer-created.json"), "utf8")).leg
    .leg_id;
  if (!/^win-[0-9]+$/.test(runId ?? "") || !/^reward_leg_[0-9a-f]{32}$/.test(legId ?? ""))
    throw Error("Locked win identity unreadable");
  readFixtureMicrophone("karaoke", process.env.REWARDS_E2E_KARAOKE_WAV);
  const directory = resolve(
    winDirectory,
    `onward-sends-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  mkdirSync(directory, { mode: 0o700 });
  const record = (entry) =>
    appendFileSync(
      resolve(directory, "recovery.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
    );
  const driver = await buildBrowserWalletDriver(process.env.REWARDS_E2E_SOLID_ROOT);
  const chain = fixtureChain();
  const result = await completeWinnerSends({
    pinned: { runId, legId, leaseQuery: runLeaseQuery },
    db,
    flags: {
      read: () => readIsolatedRewardsFlags(),
      disableAll: () => disableIsolatedRewards(apiSource),
    },
    readShutdownInventory: () => readShutdownInventory(db),
    readLegCredits: async () => (await readRunInventory(db, legId)).credits,
    readLegSends: () =>
      db.read(
        "SELECT send.send_id, send.credit_id, send.status FROM reward_winner_sends send JOIN megapot_allocations allocation USING(credit_id) JOIN megapot_allocation_batches batch USING(allocation_batch_id) WHERE batch.pool_leg_id=$1",
        [legId],
      ),
    openHost: async (check) => {
      const silence = resolve(directory, "silence.wav");
      execFileSync("ffmpeg", [
        "-nostdin",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000:cl=mono",
        "-t",
        "1",
        silence,
      ]);
      return prepareFixtureBrowsers(
        directory,
        { study: silence, sponsor: silence, karaoke: process.env.REWARDS_E2E_KARAOKE_WAV },
        check,
      );
    },
    // The run's own identity, so the app returns the send it already reserved.
    sendFor: (host, credit, { deadline }, check) => {
      const role = credit.account_id === fixtureAccounts.study.accountId ? "study" : "karaoke";
      return sendPaidCredit(
        host.pages[role],
        role,
        singleParticipantCredit([credit], role),
        {
          directory,
          runId,
          deadline,
          chain,
          ledgerDirectory: resolve(evidenceRoot, "spending-ledger"),
          authoritySha256,
        },
        driver,
        check,
      );
    },
    clearLock: () => unlinkSync(lock),
    record,
  });
  writeFileSync(resolve(directory, "recovery.json"), `${JSON.stringify(result, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(JSON.stringify({ stage: "win-sends-recovery", passed: result.passed, directory }));
  if (!result.passed) console.log(JSON.stringify(result.errors));
  process.exit(result.passed ? 0 : 1);
}
const [http, jobs] = await Promise.all([
  inspectIsolatedWorker("http"),
  inspectIsolatedWorker("jobs"),
]);
for (const version of [http, jobs]) {
  if (
    !version.annotations?.["workers/message"]?.startsWith(`git:${apiSource}`) ||
    version.resources.bindings.find((b) => b.name === "MEGAPOT_REWARDS_ENABLED")?.text !== "false"
  )
    throw Error("Both dark Workers must serve the pinned runner release");
}
const commitmentReader = await verifyCommitmentReader(jobs);
const control = (
  await db.read("SELECT paused,revision::text FROM reward_operations_control WHERE singleton")
)[0];
if (control?.paused !== true) throw Error("Preparation requires paused isolated brake");
assertShutdownInventory(await readShutdownInventory(db));
// A run must not pay winners who could then not send on.
assertGasWalletRegistered(await db.read(gasWalletQuery));
// Without a required lease a lost runner would leave the brake running.
const runLease = assertRunLeaseReady(await db.read(runLeaseQuery));
for (const [variable, address] of [
  ["MEGAPOT_E2E_CUSTODY_PRIVATE_KEY", "0x544881290138fe0e66c1ec7d1a1f141395246f20"],
  ["MEGAPOT_E2E_GAS_TOPUP_PRIVATE_KEY", "0x85ea2bce79f4cf8489457577ce75f98c47c90c6a"],
]) {
  if (privateKeyToAccount(process.env[variable]).address.toLowerCase() !== address)
    throw Error("Managed isolated signer differs");
}
const solidSource = "8baa1948f767cbf8b2876c8cce2ad14255688250";
const webBase = "/workers/scripts/pirate-web-solid-megapot-e2e-staging";
const webDeployment = (await cloudflareApi(`${webBase}/deployments`)).deployments?.[0]?.versions;
const reviewedWebVersion = "b3c57958-b3f3-46f0-8af6-e1cbd96add6b";
if (
  webDeployment?.length !== 1 ||
  webDeployment[0].percentage !== 100 ||
  webDeployment[0].version_id !== reviewedWebVersion ||
  (await cloudflareApi(`${webBase}/versions`)).items?.[0]?.id !== reviewedWebVersion
)
  throw Error("Serving Solid artifact differs from the reviewed release");
const webVersion = await cloudflareApi(`${webBase}/versions/${reviewedWebVersion}`);
if (
  webVersion.resources.bindings.find((b) => b.name === "API_NEXT_ORIGIN")?.text !==
  "https://api-megapot-e2e-staging.pirate.sc"
)
  throw Error("Serving Solid API origin differs");
// A forced loss on its own, after a win has already run and closed out clean.
const lossOnly = process.argv.includes("--loss-only");
const order = lossOnly ? ["loss"] : ["win", "loss"];
// The whole run and its recovery headroom must fit before anything is funded.
// A read-only preparation reports a refusal; an execution stops on it.
let budget;
try {
  const chain = fixtureChain();
  budget = await (lossOnly ? assertLossBudget : assertPairBudget)(
    resolve(evidenceRoot, "spending-ledger"),
    {
      authoritySha256,
      fixturePrizeAtomic: await readFixturePrize(chain),
      managedFloatWei: await readManagedFloat(chain),
    },
  );
} catch (error) {
  if (process.argv.includes("--execute")) throw error;
  budget = { refused: error instanceof Error ? error.message : "Pair budget unavailable" };
}
// Checked here, before any lock is taken or anything is funded.
let karaokeRecording;
try {
  karaokeRecording = readFixtureMicrophone("karaoke", process.env.REWARDS_E2E_KARAOKE_WAV);
} catch (error) {
  if (process.argv.includes("--execute")) throw error;
  karaokeRecording = { refused: error instanceof Error ? error.message : "refused" };
}
const plan = {
  apiSource,
  solidSource,
  webVersion: reviewedWebVersion,
  httpVersion: http.id,
  jobsVersion: jobs.id,
  commitmentReader,
  authoritySha256,
  branch: identity.branchId,
  simulatedClaimVerification: true,
  order,
  karaokeRecording: karaokeRecording.refused
    ? karaokeRecording
    : { sha256: karaokeRecording.sha256, bytes: karaokeRecording.bytes },
  budget,
  runLease,
};
console.log(
  JSON.stringify({
    stage: "preparation-readback",
    ...plan,
    execute: process.argv.includes("--execute"),
  }),
);
if (process.argv.includes("--rehearse-lease")) {
  // Unfunded: no offer is created and no funds move. It turns the jobs flag on
  // and resumes the brake under a lease, so it takes the same lock as a funded run.
  const directory = resolve(
    evidenceRoot,
    `lease-rehearsal-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  mkdirSync(directory, { mode: 0o700 });
  const lock = resolve(evidenceRoot, "runner-active.json");
  writeFileSync(
    lock,
    JSON.stringify({ directory, apiSource, startedAt: new Date().toISOString() }) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  const identityPath = resolve(evidenceRoot, "database-identity.json");
  const result = await rehearseRunLease({
    db,
    runIdPrefix: `rehearsal-${Date.now()}`,
    flags: {
      read: () => readIsolatedRewardsFlags(),
      enableJobs: () => setIsolatedRewardsFlag("jobs", "true", apiSource),
      disableAll: () => disableIsolatedRewards(apiSource),
    },
    readShutdownInventory: () => readShutdownInventory(db),
    assertShutdownInventory,
    record: (entry) =>
      appendFileSync(resolve(directory, "rehearsal.jsonl"), `${JSON.stringify(entry)}\n`),
    // A separate process that holds a lease and resumes the brake, then is
    // killed without warning, as a lost workstation would leave it.
    spawnHolder: (runId) =>
      new Promise((accept, reject) => {
        const child = spawn(
          "bun",
          [resolve(import.meta.dir, "lease-holder-child.mjs"), identityPath, runId],
          { stdio: ["ignore", "pipe", "inherit"], env: process.env },
        );
        const exited = new Promise((done) => child.once("exit", done));
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(Error("Lease holder did not resume in time"));
        }, 60_000);
        let seen = "";
        child.stdout.on("data", (chunk) => {
          seen += chunk;
          if (!seen.includes('"kind":"resumed"')) return;
          clearTimeout(timeout);
          accept({
            kill: async () => {
              child.kill("SIGKILL");
              await exited;
            },
          });
        });
        child.once("exit", () => {
          clearTimeout(timeout);
          reject(Error("Lease holder exited before resuming"));
        });
      }),
  });
  writeFileSync(
    resolve(directory, "rehearsal.json"),
    JSON.stringify({ ...plan, ...result }, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  // The lock is cleared only when the rehearsal passed and left the stack clean.
  if (result.passed) unlinkSync(lock);
  console.log(JSON.stringify({ stage: "lease-rehearsal", passed: result.passed, directory }));
  console.log(
    JSON.stringify(
      result.findings.filter((finding) => !finding.ok),
      null,
      1,
    ),
  );
  process.exit(result.passed ? 0 : 1);
}
if (process.argv.includes("--execute")) {
  const directory = resolve(evidenceRoot, `run-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(directory, { mode: 0o700 });
  const lock = resolve(evidenceRoot, "runner-active.json");
  writeFileSync(
    lock,
    JSON.stringify({ directory, apiSource, startedAt: new Date().toISOString() }) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  // A completed invocation has its own durable lock disposition. An interrupted one requires recovery.
  const results = [];
  try {
    for (const outcome of order)
      results.push(
        await runScenario({
          root,
          db,
          identity,
          evidenceRoot,
          directory,
          authoritySha256,
          apiSource,
          solidSource,
          outcome,
        }),
      );
    writeFileSync(
      resolve(directory, "acceptance.json"),
      JSON.stringify({ ...plan, passed: true, results }, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    unlinkSync(lock);
    console.log(JSON.stringify({ stage: "acceptance", passed: true, directory, results }));
  } catch (error) {
    console.error(
      JSON.stringify({
        stage: "runner-stopped",
        passed: false,
        directory,
        reason: error instanceof Error ? error.message : "Unknown runner refusal",
        neverReplay: true,
      }),
    );
    process.exitCode = 1;
  }
}
