import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { verifyKaraokeReconciliation } from "../packages/platform-cf/src/karaoke-reconciliation.ts";
import {
  ReconciliationScope,
  reconciliationDigest,
} from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import {
  decodeReconciliation,
  ReconciliationReceiptSchema,
  ReconciliationTime,
  reconciliationMillis,
} from "../packages/platform-cf/src/karaoke-reconciliation-schema.ts";
import { KARAOKE_RESET_OBJECT_IDS } from "../packages/platform-cf/src/karaoke-reset-installation.ts";
import {
  type KaraokeJournalTrust,
  readKaraokeMaintenanceJournal,
} from "./karaoke-maintenance-journal.ts";
import type {
  KaraokeAdapterTrust,
  KaraokeCollectorChallenge,
} from "./karaoke-reconciliation-adapter.ts";
import { collectKaraokeEvidence } from "./karaoke-reconciliation-cli.ts";
import type { KaraokePassPhase } from "./staging-karaoke-observation-pass.ts";
import { prepareKaraokeRecording } from "./staging-karaoke-recording-context.ts";

const Envelope = Schema.Struct({ scope: ReconciliationScope, data: Schema.Unknown });

/** The operational release time is the authenticated release evidence inside
 * the released entry, never that entry's recording timestamp. */
function journalReleaseEvidenceTime(
  journal: ReturnType<typeof readKaraokeMaintenanceJournal>,
): string | null {
  const released = journal.entries.find(({ entry }) => entry.event.kind === "released");
  if (released?.entry.event.kind !== "released") return null;
  for (const id of released.entry.event.evidenceIds) {
    const artifact = JSON.parse(journal.readArtifact(id)) as {
      kind?: string;
      release?: { releasedAt?: unknown };
    };
    if (artifact.kind === "release-evidence") {
      const releasedAt = artifact.release?.releasedAt;
      if (typeof releasedAt !== "string") throw new Error("karaoke_pass_release_evidence_denied");
      decodeReconciliation(ReconciliationTime, releasedAt);
      return releasedAt;
    }
  }
  throw new Error("karaoke_pass_release_evidence_denied");
}
/** Explicit authenticated read-only provider pass. Only signed challenge-bound
 * journal artifacts establish the result; stdout and exit status cannot do so. */
export async function runKaraokePassRecordingCli(
  configPath: string,
  assertionPath: string,
  phase: KaraokePassPhase,
) {
  const { config, live, challenge, started } = await prepareKaraokeRecording(
    configPath,
    assertionPath,
  );
  if (live.config.expectedJournalHead === null || live.config.baselineIds.length !== 6)
    throw new Error("collector_journal_not_initialized");
  const prior = readKaraokeMaintenanceJournal(live.journalTrust, new Date().toISOString());
  if (prior.state !== "held") throw new Error("karaoke_pass_fence_not_held");
  await collectKaraokeEvidence(config, challenge, assertionPath, "record-karaoke-pass", phase);
  return verifyRecordedKaraokePass({
    config,
    journalTrust: live.journalTrust,
    priorHead: prior.head,
    challenge,
    phase,
    started,
    nowUtc: new Date().toISOString(),
  });
}

/** The parent re-verifies the signed child result against its own challenge and
 * retained head. Supplying a successful process result is never sufficient. */
export async function verifyRecordedKaraokePass(input: {
  readonly config: KaraokeAdapterTrust;
  readonly journalTrust: KaraokeJournalTrust;
  readonly priorHead: { readonly entryId: string; readonly sequence: number };
  readonly challenge: KaraokeCollectorChallenge;
  readonly phase: KaraokePassPhase;
  readonly started: number;
  readonly nowUtc: string;
}) {
  const { config, journalTrust, priorHead, challenge, phase, started, nowUtc } = input;
  const journal = readKaraokeMaintenanceJournal(
    { ...journalTrust, expectedHead: priorHead },
    nowUtc,
  );
  const added = journal.entries.slice(priorHead.sequence + 1);
  if (
    journal.state !== "held" ||
    added.length !== KARAOKE_RESET_OBJECT_IDS.length ||
    added.some(
      ({ entry }) =>
        entry.event.kind !== "pass" || reconciliationMillis(entry.observedAt) < started,
    ) ||
    reconciliationMillis(nowUtc) < started ||
    reconciliationMillis(nowUtc) - started > 60_000
  )
    throw new Error("karaoke_pass_attestation_denied");
  const observed = new Set<string>();
  for (const { entry } of added) {
    if (entry.event.kind !== "pass") throw new Error("karaoke_pass_attestation_denied");
    observed.add(entry.event.objectId);
    const envelope = decodeReconciliation(
      Envelope,
      JSON.parse(journal.readArtifact(entry.event.receiptId)),
    );
    const receipt = decodeReconciliation(ReconciliationReceiptSchema, envelope.data);
    const challengeId = reconciliationDigest(
      JSON.stringify({ scope: envelope.scope, data: { kind: "pass-challenge", challenge } }),
    );
    if (
      receipt.phase !== phase ||
      receipt.target.objectId !== entry.event.objectId ||
      !entry.event.evidenceIds.includes(challengeId)
    )
      throw new Error("karaoke_pass_challenge_denied");
  }
  if (observed.size !== KARAOKE_RESET_OBJECT_IDS.length)
    throw new Error("karaoke_pass_inventory_denied");
  const entries = new Map<string, { id: string; scope: typeof ReconciliationScope.Type }>();
  for (const { entry } of journal.entries)
    if (entry.event.kind === "pass")
      for (const id of entry.event.evidenceIds) {
        const envelope = decodeReconciliation(Envelope, JSON.parse(journal.readArtifact(id)));
        entries.set(id, { id, scope: envelope.scope });
      }
  const result = await verifyKaraokeReconciliation(
    {
      readCurrentAuthenticatedManifest: async () => ({
        version: "staging-karaoke-reconciliation-manifest-v1",
        epoch: config.epoch,
        bucket: config.bucket,
        residualDispositionId: config.residualDispositionId,
        currentFenceEpoch: journal.entries.some(({ entry }) => entry.event.kind === "released")
          ? null
          : config.epoch,
        releasedAt: journalReleaseEvidenceTime(journal),
        entries: [...entries.values()],
        targets: KARAOKE_RESET_OBJECT_IDS.map((objectId) => ({
          objectId,
          markerState: phase === "retirement" || phase === "follow-up" ? "retired" : "active",
          alarm: null,
          sockets: 0,
          keyNotReused: true,
          receiptIds: journal.history[objectId],
        })),
      }),
      readArtifact: async (id) => journal.readArtifact(id),
    },
    nowUtc,
  );
  return { ...result, journalHead: journal.head, executionAuthorized: false as const };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (
    args.length !== 6 ||
    args[0] !== "--config" ||
    args[2] !== "--assertion-file" ||
    args[4] !== "--phase" ||
    !["post-fence", "pre-reset", "retirement", "follow-up"].includes(args[5] ?? "")
  ) {
    console.error(
      "Usage: bun scripts/staging-karaoke-record-pass-cli.ts --config <private-file> --assertion-file <private-file> --phase post-fence|pre-reset|retirement|follow-up",
    );
    process.exitCode = 1;
  } else {
    try {
      console.log(
        JSON.stringify(
          await runKaraokePassRecordingCli(
            args[1] ?? "",
            args[3] ?? "",
            args[5] as KaraokePassPhase,
          ),
        ),
      );
    } catch {
      console.error("karaoke_pass_recording_denied");
      process.exitCode = 1;
    }
  }
}
