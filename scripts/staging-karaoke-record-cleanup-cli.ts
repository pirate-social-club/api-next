import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readKaraokeMaintenanceJournal } from "./karaoke-maintenance-journal.ts";
import { collectKaraokeEvidence } from "./karaoke-reconciliation-cli.ts";
import { verifyRecordedKaraokePass } from "./staging-karaoke-record-pass-cli.ts";
import { prepareKaraokeRecording } from "./staging-karaoke-recording-context.ts";

/** Explicit authenticated exact-key cleanup. Cleanup runs only in the
 * post-fence phase; the child's signed receipts, not its exit status, establish
 * what was actually aborted or deleted. */
export async function runKaraokeCleanupRecordingCli(configPath: string, assertionPath: string) {
  const { config, live, challenge, started } = await prepareKaraokeRecording(
    configPath,
    assertionPath,
  );
  if (live.config.expectedJournalHead === null || live.config.baselineIds.length !== 6)
    throw new Error("collector_journal_not_initialized");
  const prior = readKaraokeMaintenanceJournal(live.journalTrust, new Date().toISOString());
  if (prior.state !== "held") throw new Error("karaoke_cleanup_fence_not_held");
  await collectKaraokeEvidence(config, challenge, assertionPath, "record-karaoke-cleanup");
  return verifyRecordedKaraokePass({
    config,
    journalTrust: live.journalTrust,
    priorHead: prior.head,
    challenge,
    phase: "post-fence",
    started,
    nowUtc: new Date().toISOString(),
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (
    args.length !== 5 ||
    args[0] !== "--config" ||
    args[2] !== "--assertion-file" ||
    args[4] !== "--record-cleanup"
  ) {
    console.error(
      "Usage: bun scripts/staging-karaoke-record-cleanup-cli.ts --config <private-file> --assertion-file <private-file> --record-cleanup",
    );
    process.exitCode = 1;
  } else {
    try {
      console.log(
        JSON.stringify(await runKaraokeCleanupRecordingCli(args[1] ?? "", args[3] ?? "")),
      );
    } catch {
      console.error("karaoke_cleanup_recording_denied");
      process.exitCode = 1;
    }
  }
}
