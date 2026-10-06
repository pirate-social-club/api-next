import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { loadPostgresMigrations } from "../postgres-migrations.ts";
import { cloudflareApi } from "./cloudflare-api.mjs";
import { verifyCommitmentReader } from "./commitment-reader.mjs";
import {
  assertRunLeaseReady,
  assertShutdownInventory,
  isolatedDatabase,
  readShutdownInventory,
  runLeaseQuery,
} from "./database-evidence.mjs";
import { fixtureChain, readFixturePrize, readManagedFloat } from "./fixture-chain.mjs";
import { runScenario } from "./run-scenario.mjs";
import { inspectIsolatedWorker } from "./runtime-flags.mjs";
import { assertPairBudget } from "./spending-ledger.mjs";

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
// The whole pair and its recovery headroom must fit before anything is funded.
// A read-only preparation reports a refusal; an execution stops on it.
let budget;
try {
  const chain = fixtureChain();
  budget = await assertPairBudget(resolve(evidenceRoot, "spending-ledger"), {
    authoritySha256,
    fixturePrizeAtomic: await readFixturePrize(chain),
    managedFloatWei: await readManagedFloat(chain),
  });
} catch (error) {
  if (process.argv.includes("--execute")) throw error;
  budget = { refused: error instanceof Error ? error.message : "Pair budget unavailable" };
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
  order: ["win", "loss"],
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
    for (const outcome of ["win", "loss"])
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
