import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reconciliationDigest } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import { reconciliationMillis } from "../packages/platform-cf/src/karaoke-reconciliation-schema.ts";
import { readKaraokeMaintenanceJournal } from "./karaoke-maintenance-journal.ts";
import type {
  KaraokeAdapterTrust,
  KaraokeCollectorChallenge,
} from "./karaoke-reconciliation-adapter.ts";
import { collectKaraokeEvidence } from "./karaoke-reconciliation-cli.ts";
import {
  type KaraokeJournalReading,
  verifyKaraokeJournalState,
} from "./staging-karaoke-journal-manifest.ts";
import { prepareKaraokeRecording } from "./staging-karaoke-recording-context.ts";
import { loadKaraokeReleaseConfiguration } from "./staging-karaoke-release-config.ts";

/** Consumes only a signature-verified journal reading. Successful exit, stdout,
 * caller booleans and an old release entry cannot satisfy this attestation. */
export async function verifyKaraokeReleaseAttestation(input: {
  readonly prior: KaraokeJournalReading;
  readonly journal: KaraokeJournalReading;
  readonly trust: KaraokeAdapterTrust;
  readonly challenge: KaraokeCollectorChallenge;
  readonly planDigest: string;
  readonly started: number;
  readonly now: number;
}) {
  const added = input.journal.entries.slice(input.prior.head.sequence + 1);
  const event = added[0]?.entry.event;
  const challengeId = reconciliationDigest(
    JSON.stringify({ kind: "release-challenge", challenge: input.challenge }),
  );
  const planId = reconciliationDigest(
    JSON.stringify({ kind: "release-plan", planDigest: input.planDigest }),
  );
  if (
    input.prior.state !== "retired" ||
    input.journal.state !== "released" ||
    added.length !== 1 ||
    event?.kind !== "released" ||
    !event.evidenceIds.includes(challengeId) ||
    !event.evidenceIds.includes(planId) ||
    reconciliationMillis(added[0]?.entry.observedAt ?? "") < input.started ||
    input.now < input.started ||
    input.now - input.started > 60_000
  )
    throw new Error("karaoke_release_attestation_denied");
  const verified = await verifyKaraokeJournalState({
    journal: input.journal,
    trust: input.trust,
    nowUtc: new Date(input.now).toISOString(),
  });
  if (verified.releasedAt === null || Date.parse(verified.releasedAt) > input.now)
    throw new Error("karaoke_release_attestation_denied");
  return {
    journalHead: input.journal.head,
    releasedAt: verified.releasedAt,
    executionAuthorized: false as const,
  };
}

export async function runKaraokeReleaseCli(configPath: string, assertionPath: string) {
  const { config, live, challenge, started } = await prepareKaraokeRecording(
    configPath,
    assertionPath,
  );
  const release = loadKaraokeReleaseConfiguration(live);
  const prior = readKaraokeMaintenanceJournal(live.journalTrust, new Date().toISOString());
  if (prior.state !== "retired") throw new Error("karaoke_release_origin_state_denied");
  await collectKaraokeEvidence(config, challenge, assertionPath, "record-karaoke-release");
  const journal = readKaraokeMaintenanceJournal(
    { ...live.journalTrust, expectedHead: prior.head },
    new Date().toISOString(),
  );
  return verifyKaraokeReleaseAttestation({
    prior,
    journal,
    trust: config,
    challenge,
    planDigest: release.approvedPlanDigest,
    started,
    now: Date.now(),
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (
    args.length !== 5 ||
    args[0] !== "--config" ||
    args[2] !== "--assertion-file" ||
    args[4] !== "--release-fence"
  ) {
    console.error(
      "Usage: bun scripts/staging-karaoke-record-release-cli.ts --config <private-file> --assertion-file <private-file> --release-fence",
    );
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(await runKaraokeReleaseCli(args[1] ?? "", args[3] ?? "")));
    } catch {
      console.error("karaoke_release_recording_denied");
      process.exitCode = 1;
    }
  }
}
