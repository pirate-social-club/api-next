import { Schema } from "effect";
import { verifyKaraokeReconciliation } from "../packages/platform-cf/src/karaoke-reconciliation.ts";
import {
  ReconciliationManifest,
  ReconciliationScope,
} from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import {
  decodeReconciliation,
  type ReconciliationReceipt,
  ReconciliationReceiptSchema,
} from "../packages/platform-cf/src/karaoke-reconciliation-schema.ts";
import { KARAOKE_RESET_OBJECT_IDS } from "../packages/platform-cf/src/karaoke-reset-installation.ts";
import type { readKaraokeMaintenanceJournal } from "./karaoke-maintenance-journal.ts";
import type { KaraokeAdapterTrust } from "./karaoke-reconciliation-adapter.ts";

const Envelope = Schema.Struct({ scope: ReconciliationScope, data: Schema.Unknown });

export type KaraokeJournalReading = ReturnType<typeof readKaraokeMaintenanceJournal>;

/** Composes the journal's signed artifacts into the reconciliation manifest the
 * real verifier consumes. Receipt facts decide retired marker state; this
 * helper never invents a marker, release or fence fact. */
export function readKaraokePassReceipt(
  journal: KaraokeJournalReading,
  receiptId: string,
): { scope: typeof ReconciliationScope.Type; receipt: ReconciliationReceipt } {
  const envelope = decodeReconciliation(Envelope, JSON.parse(journal.readArtifact(receiptId)));
  return {
    scope: envelope.scope,
    receipt: decodeReconciliation(ReconciliationReceiptSchema, envelope.data),
  };
}

export async function verifyKaraokeJournalState(input: {
  readonly journal: KaraokeJournalReading;
  readonly trust: KaraokeAdapterTrust;
  readonly nowUtc: string;
}) {
  const { journal, trust } = input;
  const releasedEntry = journal.entries.find(({ entry }) => entry.event.kind === "released");
  const releasedAt = releasedEntry?.entry.observedAt ?? null;
  const entries = new Map<string, { id: string; scope: typeof ReconciliationScope.Type }>();
  for (const { entry } of journal.entries) {
    if (entry.event.kind !== "pass") continue;
    for (const id of entry.event.evidenceIds) {
      const envelope = decodeReconciliation(Envelope, JSON.parse(journal.readArtifact(id)));
      entries.set(id, { id, scope: envelope.scope });
    }
  }
  const latest: Record<string, ReconciliationReceipt> = {};
  const targets: {
    objectId: (typeof KARAOKE_RESET_OBJECT_IDS)[number];
    markerState: "active" | "retired";
    alarm: null;
    sockets: number;
    keyNotReused: boolean;
    receiptIds: string[];
  }[] = [];
  for (const objectId of KARAOKE_RESET_OBJECT_IDS) {
    const receiptIds = journal.history[objectId];
    const retained = trust.expectedHistory[objectId];
    if (
      receiptIds === undefined ||
      retained === undefined ||
      retained.some((id, index) => receiptIds[index] !== id)
    )
      throw new Error("karaoke_milestone_history_denied");
    const last = receiptIds.at(-1);
    if (last === undefined) throw new Error("karaoke_milestone_receipt_missing");
    const { scope, receipt } = readKaraokePassReceipt(journal, last);
    latest[objectId] = receipt;
    targets.push({
      objectId,
      markerState:
        receipt.phase === "retirement" || receipt.phase === "follow-up"
          ? ("retired" as const)
          : ("active" as const),
      alarm: null,
      sockets: 0,
      keyNotReused: true,
      receiptIds,
    });
    if (scope.target.objectId !== objectId) throw new Error("karaoke_milestone_scope_denied");
  }
  const result = await verifyKaraokeReconciliation(
    {
      readCurrentAuthenticatedManifest: async () =>
        decodeReconciliation(ReconciliationManifest, {
          version: "staging-karaoke-reconciliation-manifest-v1",
          epoch: trust.epoch,
          bucket: trust.bucket,
          residualDispositionId: trust.residualDispositionId,
          currentFenceEpoch: releasedAt === null ? trust.epoch : null,
          releasedAt,
          targets,
          entries: [...entries.values()],
        }),
      readArtifact: async (id) => journal.readArtifact(id),
    },
    input.nowUtc,
  );
  return { result, latest, releasedAt, executionAuthorized: false as const };
}
