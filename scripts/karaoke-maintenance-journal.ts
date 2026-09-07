import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { Schema } from "effect";
import { reconciliationDigest } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import {
  ReconciliationDigest as Digest,
  decodeReconciliation,
  reconciliationMillis,
  ReconciliationTime as Time,
} from "../packages/platform-cf/src/karaoke-reconciliation-schema.ts";
import { KARAOKE_RESET_OBJECT_IDS } from "../packages/platform-cf/src/karaoke-reset-installation.ts";
import { openKaraokePrivateArtifacts } from "./karaoke-private-artifacts.ts";
import { openKaraokePrivateWriter } from "./karaoke-private-writer.ts";

const Evidence = Schema.Array(Digest).check(Schema.isMinLength(1), Schema.isMaxLength(64));
const Event = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("begin"), evidenceIds: Evidence }),
  Schema.Struct({ kind: Schema.Literal("fence-observed"), evidenceIds: Evidence }),
  Schema.Struct({ kind: Schema.Literal("fence-broken"), evidenceIds: Evidence }),
  Schema.Struct({ kind: Schema.Literal("reset-verified"), evidenceIds: Evidence }),
  Schema.Struct({ kind: Schema.Literal("all-retired"), evidenceIds: Evidence }),
  Schema.Struct({ kind: Schema.Literal("released"), evidenceIds: Evidence }),
  Schema.Struct({
    kind: Schema.Literal("pass"),
    objectId: Schema.Literals(KARAOKE_RESET_OBJECT_IDS),
    receiptId: Digest,
    evidenceIds: Evidence,
  }),
]);
const Entry = Schema.Struct({
  version: Schema.Literal("staging-karaoke-journal-entry-v1"),
  epoch: Digest,
  collectorSourceDigest: Digest,
  sequence: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8191 })),
  previousId: Schema.NullOr(Digest),
  observedAt: Time,
  event: Event,
});
const Head = Schema.Struct({
  version: Schema.Literal("staging-karaoke-journal-head-v1"),
  epoch: Digest,
  collectorSourceDigest: Digest,
  sequence: Entry.fields.sequence,
  entryId: Digest,
});
const Signed = Schema.Struct({
  payload: Schema.String.check(Schema.isMaxLength(262_000)),
  signature: Schema.String.check(Schema.isPattern(/^[a-f0-9]{128}$/u)),
});
export interface KaraokeJournalTrust {
  readonly directory: string;
  readonly publicKeyPem: string;
  readonly collectorSourceDigest: string;
  readonly epoch: string;
  /** Independently retained head, outside the directory. null is valid only before first use. */
  readonly expectedHead: { readonly entryId: string; readonly sequence: number } | null;
}

function signedBytes(payload: unknown, privateKeyPem: string) {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("karaoke_journal_key_denied");
  const bytes = JSON.stringify(payload);
  return JSON.stringify({
    payload: bytes,
    signature: sign(null, Buffer.from(bytes), key).toString("hex"),
  });
}
function verifiedPayload(bytes: string, publicKeyPem: string) {
  const signed = decodeReconciliation(Signed, JSON.parse(bytes));
  const key = createPublicKey(publicKeyPem);
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !verify(null, Buffer.from(signed.payload), key, Buffer.from(signed.signature, "hex"))
  )
    throw new Error("karaoke_journal_signature_denied");
  return JSON.parse(signed.payload) as unknown;
}

function validateJournalOrder(entries: readonly { id: string; entry: typeof Entry.Type }[]) {
  let state: "unestablished" | "held" | "reset" | "retired" | "released" | "broken" =
    "unestablished";
  let previousTime = -1;
  const history: Record<string, string[]> = Object.fromEntries(
    KARAOKE_RESET_OBJECT_IDS.map((objectId) => [objectId, []]),
  );
  for (const { entry } of entries) {
    const time = reconciliationMillis(entry.observedAt);
    const event = entry.event;
    if (
      time < previousTime ||
      (entry.sequence === 0) !== (event.kind === "begin") ||
      state === "broken"
    )
      throw new Error("karaoke_journal_order_denied");
    previousTime = time;
    if (event.kind === "fence-observed") {
      if (state === "released") throw new Error("karaoke_journal_release_monotonic");
      if (state === "unestablished") state = "held";
    } else if (event.kind === "reset-verified") {
      if (state !== "held") throw new Error("karaoke_journal_reset_denied");
      state = "reset";
    } else if (event.kind === "all-retired") {
      if (state !== "reset" && state !== "retired")
        throw new Error("karaoke_journal_retirement_denied");
      state = "retired";
    } else if (event.kind === "released") {
      if (state !== "retired") throw new Error("karaoke_journal_release_denied");
      state = "released";
    } else if (event.kind === "fence-broken") state = "broken";
    else if (event.kind === "pass") {
      if (state === "unestablished") throw new Error("karaoke_journal_pass_denied");
      const receipts = history[event.objectId];
      if (receipts === undefined || receipts.includes(event.receiptId))
        throw new Error("karaoke_journal_receipt_denied");
      receipts.push(event.receiptId);
    }
  }
  return { state, history };
}

/** Cryptographic history verification, not a claim that referenced provider evidence is true. */
export function readKaraokeMaintenanceJournal(trust: KaraokeJournalTrust, nowUtc: string) {
  const store = openKaraokePrivateArtifacts(trust.directory);
  try {
    const head = decodeReconciliation(
      Head,
      verifiedPayload(store.read("manifest.signed.json", 262_144), trust.publicKeyPem),
    );
    if (head.epoch !== trust.epoch || head.collectorSourceDigest !== trust.collectorSourceDigest)
      throw new Error("karaoke_journal_scope_denied");
    const entries: { id: string; entry: typeof Entry.Type }[] = [];
    let totalBytes = 0;
    const retained = new Map<string, string>();
    const readArtifact = (id: string) => {
      const cached = retained.get(id);
      if (cached !== undefined) return cached;
      const bytes = store.read(`${id}.json`, 262_144);
      totalBytes += Buffer.byteLength(bytes);
      if (totalBytes > 67_108_864 || reconciliationDigest(bytes) !== id)
        throw new Error("karaoke_journal_artifact_denied");
      retained.set(id, bytes);
      return bytes;
    };
    let id: string | null = head.entryId;
    for (let sequence = head.sequence; sequence >= 0; sequence--) {
      if (id === null) throw new Error("karaoke_journal_truncated");
      const bytes = readArtifact(id);
      if (reconciliationDigest(bytes) !== id) throw new Error("karaoke_journal_digest_denied");
      const entry = decodeReconciliation(Entry, verifiedPayload(bytes, trust.publicKeyPem));
      if (
        entry.sequence !== sequence ||
        entry.epoch !== trust.epoch ||
        entry.collectorSourceDigest !== trust.collectorSourceDigest ||
        reconciliationMillis(entry.observedAt) > reconciliationMillis(nowUtc)
      )
        throw new Error("karaoke_journal_entry_denied");
      for (const reference of entry.event.evidenceIds) {
        if (reconciliationDigest(readArtifact(reference)) !== reference)
          throw new Error("karaoke_journal_evidence_denied");
      }
      if (entry.event.kind === "pass" && !entry.event.evidenceIds.includes(entry.event.receiptId))
        throw new Error("karaoke_journal_receipt_denied");
      entries.push({ id, entry });
      id = entry.previousId;
    }
    if (id !== null) throw new Error("karaoke_journal_prefix_denied");
    entries.reverse();
    if (
      trust.expectedHead !== null &&
      !entries.some(
        (value) =>
          value.id === trust.expectedHead?.entryId &&
          value.entry.sequence === trust.expectedHead.sequence,
      )
    )
      throw new Error("karaoke_journal_rollback_denied");
    const { state, history } = validateJournalOrder(entries);
    return {
      head,
      entries,
      state,
      history,
      readArtifact(id: string) {
        const bytes = retained.get(id);
        if (bytes === undefined) throw new Error("karaoke_journal_reference_denied");
        return bytes;
      },
      executionAuthorized: false as const,
    };
  } finally {
    store.close();
  }
}

/** Only concrete runner observers call this; there is no submitted-event CLI. */
export function appendKaraokeMaintenanceEvent(input: {
  readonly trust: KaraokeJournalTrust;
  readonly privateKeyPem: string;
  readonly observedAt: string;
  readonly event: typeof Event.Type;
  readonly artifacts: readonly string[];
}) {
  const writer = openKaraokePrivateWriter(input.trust.directory);
  let unlock: (() => void) | undefined;
  try {
    unlock = writer.lock();
    const previous =
      writer.isNewJournal() && input.trust.expectedHead === null && input.event.kind === "begin"
        ? null
        : readKaraokeMaintenanceJournal(input.trust, input.observedAt);
    if (previous?.state === "broken") throw new Error("karaoke_journal_broken");
    const event = decodeReconciliation(Event, input.event);
    const supplied = new Set(input.artifacts.map((bytes) => writer.putArtifact(bytes)));
    if (event.evidenceIds.some((id) => !supplied.has(id)))
      throw new Error("karaoke_journal_evidence_missing");
    const entry = decodeReconciliation(Entry, {
      version: "staging-karaoke-journal-entry-v1",
      epoch: input.trust.epoch,
      collectorSourceDigest: input.trust.collectorSourceDigest,
      sequence: previous === null ? 0 : previous.head.sequence + 1,
      previousId: previous?.head.entryId ?? null,
      observedAt: input.observedAt,
      event,
    });
    validateJournalOrder([...(previous?.entries ?? []), { id: "", entry }]);
    const bytes = signedBytes(entry, input.privateKeyPem);
    // Verify key agreement before advancing the journal head.
    verifiedPayload(bytes, input.trust.publicKeyPem);
    const entryId = writer.putArtifact(bytes);
    const head = {
      version: "staging-karaoke-journal-head-v1",
      epoch: entry.epoch,
      collectorSourceDigest: entry.collectorSourceDigest,
      sequence: entry.sequence,
      entryId,
    };
    writer.replaceManifest(signedBytes(head, input.privateKeyPem));
    return readKaraokeMaintenanceJournal(
      { ...input.trust, expectedHead: { entryId, sequence: entry.sequence } },
      input.observedAt,
    );
  } finally {
    try {
      unlock?.();
    } finally {
      writer.close();
    }
  }
}
