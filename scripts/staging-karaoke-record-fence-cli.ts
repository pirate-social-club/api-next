import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reconciliationDigest } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import {
  decodeReconciliation,
  reconciliationMillis,
} from "../packages/platform-cf/src/karaoke-reconciliation-schema.ts";
import { readKaraokeMaintenanceJournal } from "./karaoke-maintenance-journal.ts";
import { collectKaraokeEvidence } from "./karaoke-reconciliation-cli.ts";
import { KaraokeAuthorityBaseline } from "./staging-karaoke-collector-config.ts";
import { prepareKaraokeRecording } from "./staging-karaoke-recording-context.ts";
/** Explicit local recording, never reset execution. The child's signed result,
 * not its exit code or stdout, establishes what the default observer retained.
 */
export async function runKaraokeFenceRecordingCli(configPath: string, assertionPath: string) {
  const { config, live, challenge, started } = await prepareKaraokeRecording(
    configPath,
    assertionPath,
  );
  if (live.config.operatorConfigPath !== configPath || live.config.expectedJournalHead !== null)
    throw new Error("collector_initialization_scope_denied");
  await collectKaraokeEvidence(config, challenge, assertionPath, "record-karaoke-fence");
  const journal = readKaraokeMaintenanceJournal(live.journalTrust, new Date().toISOString());
  const begin = journal.entries[0]?.entry;
  const challengeId = reconciliationDigest(JSON.stringify({ kind: "fence-challenge", challenge }));
  if (
    journal.state !== "held" ||
    journal.head.sequence !== 1 ||
    begin?.event.kind !== "begin" ||
    !begin.event.evidenceIds.includes(challengeId) ||
    reconciliationMillis(begin.observedAt) < started ||
    Date.now() - started > 60_000
  )
    throw new Error("collector_recording_attestation_denied");
  const baselineIds = begin.event.evidenceIds.filter((id) => {
    const raw: unknown = JSON.parse(journal.readArtifact(id));
    if (
      raw === null ||
      typeof raw !== "object" ||
      !("version" in raw) ||
      raw.version !== "staging-karaoke-authority-baseline-v1"
    )
      return false;
    decodeReconciliation(KaraokeAuthorityBaseline, raw);
    return true;
  });
  if (baselineIds.length !== 6) throw new Error("collector_recording_baseline_denied");
  return {
    journalHead: journal.head,
    baselineIds,
    resetAdmission: "blocked",
    executionAuthorized: false,
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (
    args.length !== 5 ||
    args[0] !== "--config" ||
    args[2] !== "--assertion-file" ||
    args[4] !== "--record-fence"
  ) {
    console.error(
      "Usage: bun scripts/staging-karaoke-record-fence-cli.ts --config <private-file> --assertion-file <private-file> --record-fence",
    );
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(await runKaraokeFenceRecordingCli(args[1] ?? "", args[3] ?? "")));
    } catch {
      console.error("karaoke_fence_recording_denied");
      process.exitCode = 1;
    }
  }
}
