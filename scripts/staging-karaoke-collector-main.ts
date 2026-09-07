import { runStagingKaraokeCollector } from "./staging-karaoke-collector-runtime.ts";
import { recordStagingKaraokeFence } from "./staging-karaoke-record-fence.ts";

// Build with import.meta.main=false for imported diagnostic CLI modules. The
// verified stdin entrypoint uses this exact argument protocol instead.
if (
  ["collect-karaoke-reconciliation", "record-karaoke-fence"].includes(process.argv.at(-3) ?? "") &&
  process.argv.at(-2) === "--run-directory"
) {
  try {
    const configPath = process.env.KARAOKE_LIVE_COLLECTOR_CONFIG;
    const assertionPath = process.env.KARAOKE_COLLECTOR_ACCESS_ASSERTION_FILE;
    const sourceDigest = process.env.KARAOKE_COLLECTOR_SOURCE_DIGEST;
    const challengeJson = process.env.KARAOKE_COLLECTOR_CHALLENGE;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    const runDirectory = process.argv.at(-1);
    if (
      !configPath ||
      !assertionPath ||
      !sourceDigest ||
      !challengeJson ||
      !apiToken ||
      !runDirectory
    )
      throw new Error("collector_configuration_missing");
    const execute =
      process.argv.at(-3) === "record-karaoke-fence"
        ? recordStagingKaraokeFence
        : runStagingKaraokeCollector;
    await execute({
      configPath,
      assertionPath,
      sourceDigest,
      challengeJson,
      apiToken,
      runDirectory,
    });
  } catch {
    console.error("staging_karaoke_collection_denied");
    process.exitCode = 1;
  }
} else {
  console.error("staging_karaoke_collector_invocation_denied");
  process.exitCode = 1;
}
