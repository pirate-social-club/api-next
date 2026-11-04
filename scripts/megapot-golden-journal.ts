import { createHash } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { Schema } from "effect";
import type { MultiGoldenInput } from "./megapot-golden-multi-input.ts";

const Journal = Schema.Struct({
  input_digest: Schema.String,
  funding_transaction_hash: Schema.NullOr(Schema.String),
  leg_id: Schema.NullOr(Schema.String),
  funding_effect_id: Schema.NullOr(Schema.String),
  drawing_id: Schema.NullOr(Schema.String),
  pending_activity: Schema.NullOr(Schema.String),
  completed_activities: Schema.Array(Schema.String),
  study_submissions: Schema.Int,
  karaoke_attempts: Schema.Int,
  attempts: Schema.Array(
    Schema.Struct({
      participant_key: Schema.String,
      session_id: Schema.String,
      attempt_id: Schema.String,
    }),
  ),
});
export type GoldenJournal = typeof Journal.Type;
export type GoldenJournalPort = {
  state: GoldenJournal;
  save: (state: GoldenJournal) => Promise<void>;
};

/** Single-writer append-only journal. A torn last line fails closed; never guesses a retry. */
export async function withGoldenJournal<A>(
  path: string,
  input: MultiGoldenInput,
  run: (journal: GoldenJournalPort) => Promise<A>,
): Promise<A> {
  const digest = createHash("sha256")
    .update(JSON.stringify({ ...input, funding_transaction_hash: null }))
    .digest("hex");
  const fundingHash =
    input.app_funded_pool?.transaction_hash ?? input.funding_transaction_hash ?? null;
  const lockPath = `${path}.lock`;
  const lock = await open(lockPath, "wx", 0o600);
  try {
    // Diagnostic evidence only: age/PID never authorizes automatic lock removal.
    await lock.writeFile(
      JSON.stringify({ host: hostname(), pid: process.pid, acquired_at: new Date().toISOString() }),
    );
    await lock.sync();
    let state: GoldenJournal = {
      input_digest: digest,
      funding_transaction_hash: fundingHash,
      leg_id: null,
      funding_effect_id: null,
      drawing_id: null,
      pending_activity: null,
      completed_activities: [],
      study_submissions: 0,
      karaoke_attempts: 0,
      attempts: [],
    };
    try {
      const lines = (await readFile(path, "utf8")).trim().split("\n");
      state = Schema.decodeUnknownSync(Journal, { onExcessProperty: "error" })(
        JSON.parse(lines.at(-1) ?? ""),
      );
      if (state.input_digest !== digest) throw new Error("Journal plan mismatch.");
      if (state.funding_transaction_hash !== null && state.funding_transaction_hash !== fundingHash)
        throw new Error("Journal funding transaction mismatch.");
      state = { ...state, funding_transaction_hash: fundingHash };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const file = await open(path, "a", 0o600);
    try {
      const journal: GoldenJournalPort = {
        state,
        save: async (next) => {
          await file.write(`${JSON.stringify(next)}\n`);
          await file.sync();
          journal.state = next;
        },
      };
      await journal.save(state);
      return await run(journal);
    } finally {
      await file.close();
    }
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
