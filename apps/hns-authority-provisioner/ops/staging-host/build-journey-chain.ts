import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "../../../..");
const entry = join(import.meta.dir, "journey-chain.ts");

/**
 * The installed runner talks only to the isolated staging host's regtest node
 * (install-fixture-containers.sh: loopback 24037/24039, fixture key). These are
 * compiled in: the shared test fixture's defaults (14037/14039) and any
 * HSD_REGTEST_* environment on the host are not honoured by the bundle.
 */
const STAGING_HOST_REGTEST = {
  HSD_REGTEST_NODE_URL: "http://127.0.0.1:24037/",
  HSD_REGTEST_WALLET_URL: "http://127.0.0.1:24039/",
  HSD_REGTEST_API_KEY: "controlled-progression",
  HNS_REGTEST_TEST_REQUIRED: "0",
} as const;
const defines = Object.entries(STAGING_HOST_REGTEST).flatMap(([name, value]) => [
  "--define",
  `process.env.${name}=${JSON.stringify(value)}`,
]);

async function run(command: string[], cwd: string) {
  const process = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

export async function buildJourneyChain(output: string) {
  if (!isAbsolute(output) || !output.endsWith("/journey-chain.js"))
    throw new Error("journey_bundle_output_invalid");
  let parent: Awaited<ReturnType<typeof lstat>>;
  try {
    parent = await lstat(dirname(output));
  } catch {
    throw new Error("journey_bundle_parent_missing");
  }
  if (!parent.isDirectory() || parent.isSymbolicLink())
    throw new Error("journey_bundle_parent_invalid");
  try {
    await lstat(output);
    throw new Error("journey_bundle_output_exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const head = await run(["git", "rev-parse", "HEAD"], repository);
  const status = await run(["git", "status", "--porcelain", "--untracked-files=all"], repository);
  if (
    head.exitCode !== 0 ||
    !/^[0-9a-f]{40}\n$/u.test(head.stdout) ||
    status.exitCode !== 0 ||
    status.stdout.length !== 0
  )
    throw new Error("journey_bundle_source_not_clean");
  const built = await run(
    ["bun", "build", entry, "--target=bun", ...defines, "--outfile", output],
    repository,
  );
  if (built.exitCode !== 0) throw new Error("journey_bundle_build_failed");
  const text = await readFile(output, "utf8");
  if (
    Object.keys(STAGING_HOST_REGTEST).some((name) => text.includes(name)) ||
    !text.includes(STAGING_HOST_REGTEST.HSD_REGTEST_NODE_URL) ||
    !text.includes(STAGING_HOST_REGTEST.HSD_REGTEST_WALLET_URL) ||
    text.includes("127.0.0.1:14037") ||
    text.includes("127.0.0.1:14039")
  )
    throw new Error("journey_bundle_endpoints_not_pinned");
  // Invalid syntax is rejected before chain preflight. Running from the
  // output directory proves the bundle resolves without the source tree.
  const probe = await run(["bun", output, "invalid-command"], dirname(output));
  if (
    probe.exitCode !== 1 ||
    probe.stdout !== "" ||
    probe.stderr.trim() !== '{"outcome":"journey_chain_refused","code":"command_invalid"}'
  )
    throw new Error("journey_bundle_self_containment_failed");
  const sha256 = createHash("sha256")
    .update(await readFile(output))
    .digest("hex");
  return { source_sha: head.stdout.trim(), bundle_path: output, bundle_sha256: sha256 };
}

if (import.meta.main) {
  const [option, output] = Bun.argv.slice(2);
  if (option !== "--output" || output === undefined || Bun.argv.length !== 4)
    throw new Error("usage: bun build-journey-chain.ts --output /absolute/path/journey-chain.js");
  console.log(JSON.stringify(await buildJourneyChain(output)));
}
