import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  buildNormalRewardsJobsArtifact,
  buildRewardsHttpArtifact,
} from "./isolated-http-build.mjs";

const require = createRequire(import.meta.url);
const wranglerRoot = dirname(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require(
  require.resolve("miniflare", { paths: [wranglerRoot] }),
);
const marker = "SIMULATED_REWARDS_CLAIM_VERIFICATION";
const roleDigest = createHash("sha256").update("local_build_verification_only").digest("hex");

// This command packages and runs only local artifacts. It never uploads or funds them.
for (const mode of ["staging", "production", "jobs"]) {
  const artifact =
    mode === "jobs" ? await buildNormalRewardsJobsArtifact() : await buildRewardsHttpArtifact(mode);
  if (
    artifact.source.includes(marker) ||
    artifact.inputPaths.some((path) => path.includes("reward-claim-stub"))
  ) {
    throw new Error(`Simulated verification leaked into the normal ${mode} artifact`);
  }
}

const directory = await mkdtemp(join(tmpdir(), "rewards-worker-build-"));
const artifact = await buildRewardsHttpArtifact("isolated", roleDigest);
await writeFile(join(directory, "index.js"), artifact.source);
await writeFile(
  join(directory, "wrangler.json"),
  JSON.stringify({
    name: "rewards-e2e-local-build-check",
    main: "index.js",
    // Match the existing stack; changing compatibility behavior is a separate release.
    compatibility_date: "2026-08-01",
    compatibility_flags: ["nodejs_compat"],
  }),
);
const packaged = join(directory, "packaged");
const command = Bun.spawn(
  [
    process.execPath,
    resolve(wranglerRoot, "bin/wrangler.js"),
    "deploy",
    "--dry-run",
    "--config",
    join(directory, "wrangler.json"),
    "--outdir",
    packaged,
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if ((await command.exited) !== 0) throw new Error("Isolated Worker packaging refused");

for (const scenario of [
  { environment: "staging", host: "api-megapot-e2e-staging.pirate.sc" },
  { environment: "production", host: "api-megapot-e2e-staging.pirate.sc" },
  { environment: "development", host: "api-next-staging.pirate.sc" },
  { environment: "development", host: "api-megapot-e2e-staging.pirate.sc" },
]) {
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      modulesRoot: packaged,
      scriptPath: join(packaged, "index.js"),
      compatibilityDate: "2026-08-01",
      compatibilityFlags: ["nodejs_compat"],
      bindings: {
        API_NEXT_ENV: scenario.environment,
        CONTROL_PLANE: { connectionString: "postgres://wrong_role:local_only@localhost/unused" },
      },
    }),
  );
  try {
    const response = await runtime.dispatchFetch(`https://${scenario.host}/rewards/claim`);
    if (
      response.status !== 503 ||
      (await response.text()) !== "Isolated Rewards resource identity mismatch"
    ) {
      throw new Error(
        `Runtime resource boundary failed for ${scenario.environment}/${scenario.host}`,
      );
    }
  } finally {
    await runtime.dispose();
  }
}
console.log(
  JSON.stringify({
    result: "pass",
    scope: "local artifact exclusion, packaging and runtime refusals",
    funded_run: false,
    simulated_verification: marker,
    artifact_directory: directory,
  }),
);
