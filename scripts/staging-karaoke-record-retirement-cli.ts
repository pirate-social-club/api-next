import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reconciliationDigest } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import { reconciliationMillis } from "../packages/platform-cf/src/karaoke-reconciliation-schema.ts";
import { readKaraokeMaintenanceJournal } from "./karaoke-maintenance-journal.ts";
import { collectKaraokeEvidence } from "./karaoke-reconciliation-cli.ts";
import { prepareKaraokeRecording } from "./staging-karaoke-recording-context.ts";

/** Explicit authenticated all-retired recording. The child's signed journal
 * entry, not its exit status, establishes the milestone. */
export async function runKaraokeRetirementRecordingCli(configPath: string, assertionPath: string) {
  const { config, live, challenge, started } = await prepareKaraokeRecording(
    configPath,
    assertionPath,
  );
  if (live.config.expectedJournalHead === null || live.config.baselineIds.length !== 6)
    throw new Error("collector_journal_not_initialized");
  const prior = readKaraokeMaintenanceJournal(live.journalTrust, new Date().toISOString());
  if (prior.state !== "reset") throw new Error("karaoke_retirement_origin_state_denied");
  await collectKaraokeEvidence(config, challenge, assertionPath, "record-karaoke-retirement");
  const journal = readKaraokeMaintenanceJournal(
    { ...live.journalTrust, expectedHead: prior.head },
    new Date().toISOString(),
  );
  const added = journal.entries.slice(prior.head.sequence + 1);
  const challengeId = reconciliationDigest(
    JSON.stringify({ kind: "retirement-challenge", challenge }),
  );
  if (
    journal.state !== "retired" ||
    added.length !== 1 ||
    added[0]?.entry.event.kind !== "all-retired" ||
    !added[0].entry.event.evidenceIds.includes(challengeId) ||
    reconciliationMillis(added[0].entry.observedAt) < started ||
    Date.now() - started > 60_000
  )
    throw new Error("karaoke_retirement_attestation_denied");
  return { journalHead: journal.head, executionAuthorized: false as const };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (
    args.length !== 5 ||
    args[0] !== "--config" ||
    args[2] !== "--assertion-file" ||
    args[4] !== "--record-retirement"
  ) {
    console.error(
      "Usage: bun scripts/staging-karaoke-record-retirement-cli.ts --config <private-file> --assertion-file <private-file> --record-retirement",
    );
    process.exitCode = 1;
  } else {
    try {
      console.log(
        JSON.stringify(await runKaraokeRetirementRecordingCli(args[1] ?? "", args[3] ?? "")),
      );
    } catch {
      console.error("karaoke_retirement_recording_denied");
      process.exitCode = 1;
    }
  }
}
