import {
  runStagingKaraokeCleanupPass,
  runStagingKaraokeCollector,
  runStagingKaraokeObservationPass,
  runStagingKaraokeRetirementRecording,
} from "./staging-karaoke-collector-runtime.ts";
import { recordStagingKaraokeFence } from "./staging-karaoke-record-fence.ts";
import { runStagingKaraokeRelease } from "./staging-karaoke-release-runtime.ts";

// Build with import.meta.main=false for imported diagnostic CLI modules. The
// verified stdin entrypoint uses this exact argument protocol instead.
if (
  [
    "collect-karaoke-reconciliation",
    "record-karaoke-fence",
    "record-karaoke-pass",
    "record-karaoke-cleanup",
    "record-karaoke-retirement",
    "record-karaoke-release",
  ].includes(process.argv.at(-3) ?? "") &&
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
    const input = {
      configPath,
      assertionPath,
      sourceDigest,
      challengeJson,
      apiToken,
      runDirectory,
    };
    if (process.argv.at(-3) === "record-karaoke-pass")
      await runStagingKaraokeObservationPass(input, process.env.KARAOKE_COLLECTOR_PASS_PHASE);
    else if (process.argv.at(-3) === "record-karaoke-cleanup")
      await runStagingKaraokeCleanupPass(input);
    else if (process.argv.at(-3) === "record-karaoke-retirement")
      await runStagingKaraokeRetirementRecording(input);
    else if (process.argv.at(-3) === "record-karaoke-release")
      await runStagingKaraokeRelease(input);
    else await execute(input);
  } catch {
    console.error("staging_karaoke_collection_denied");
    process.exitCode = 1;
  }
} else {
  console.error("staging_karaoke_collector_invocation_denied");
  process.exitCode = 1;
}
