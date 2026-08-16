import { describe, expect, test } from "bun:test";
import { AMBIGUOUS, LEGACY, RECLAIMABLE } from "./failure-fence";
import type {
  BeginJournalCommand,
  ConfirmJournalCommand,
  FailJournalCommand,
  JournalFailOutcome,
} from "./interpreter-contract";

type State = { readonly step: "begun" | "confirmed" | "failed" };
type Event = { readonly type: "confirm" };

const entry = {
  idempotencyKey: "purchase:quote_1",
  version: 1,
  state: { step: "failed" } as const,
  status: "failed" as const,
};

describe("money-flow interpreter contract", () => {
  test("keys begin, confirm, and fail commands by the same idempotency key", () => {
    const begin: BeginJournalCommand<State> = {
      operation: "begin",
      idempotencyKey: "purchase:quote_1",
      initialState: { step: "begun" },
    };
    const confirm: ConfirmJournalCommand<Event> = {
      operation: "confirm",
      idempotencyKey: begin.idempotencyKey,
      expectedVersion: 1,
      event: { type: "confirm" },
    };
    const fail: FailJournalCommand = {
      operation: "fail",
      idempotencyKey: begin.idempotencyKey,
      expectedVersion: 1,
      failure: RECLAIMABLE,
    };
    expect(confirm.idempotencyKey).toBe(begin.idempotencyKey);
    expect(fail.idempotencyKey).toBe(begin.idempotencyKey);
    expect(fail.failure.mayRebroadcast).toBe(true);
  });

  test("keeps all three failure fences typed at the journal boundary", () => {
    const outcomes: JournalFailOutcome<State>[] = [
      {
        _tag: "journal_fail",
        idempotencyKey: entry.idempotencyKey,
        entry,
        failure: RECLAIMABLE,
        replayed: false,
      },
      {
        _tag: "journal_fail",
        idempotencyKey: entry.idempotencyKey,
        entry,
        failure: AMBIGUOUS,
        replayed: false,
      },
      {
        _tag: "journal_fail",
        idempotencyKey: entry.idempotencyKey,
        entry,
        failure: LEGACY,
        replayed: true,
      },
    ];
    expect(outcomes.map((outcome) => outcome.failure._tag)).toEqual([
      "reclaimable",
      "ambiguous",
      "legacy",
    ]);
    expect(outcomes.slice(1).every((outcome) => !outcome.failure.mayRebroadcast)).toBe(true);
  });
});
