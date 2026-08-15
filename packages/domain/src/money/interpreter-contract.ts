import type { FailureFence } from "./failure-fence";

/**
 * M3's application interpreter owns persistence and I/O. This file fixes the
 * domain contract that both the request path and reconciler must call; it is
 * deliberately not a journal implementation.
 */
export type MoneyFlowJournalStatus = "begun" | "confirmed" | "failed";

export type MoneyFlowJournalEntry<S> = {
  readonly idempotencyKey: string;
  readonly version: number;
  readonly state: S;
  readonly status: MoneyFlowJournalStatus;
};

export type BeginJournalCommand<S> = {
  readonly operation: "begin";
  readonly idempotencyKey: string;
  readonly initialState: S;
};

export type ConfirmJournalCommand<E extends object> = {
  readonly operation: "confirm";
  readonly idempotencyKey: string;
  readonly expectedVersion: number;
  readonly event: E;
};

export type FailJournalCommand = {
  readonly operation: "fail";
  readonly idempotencyKey: string;
  readonly expectedVersion: number;
  readonly failure: FailureFence;
};

export type JournalBeginOutcome<S> = {
  readonly _tag: "journal_begin";
  readonly idempotencyKey: string;
  readonly entry: MoneyFlowJournalEntry<S>;
  readonly replayed: boolean;
};

export type JournalConfirmOutcome<S> = {
  readonly _tag: "journal_confirm";
  readonly idempotencyKey: string;
  readonly entry: MoneyFlowJournalEntry<S>;
  readonly replayed: boolean;
};

export type JournalFailOutcome<S> = {
  readonly _tag: "journal_fail";
  readonly idempotencyKey: string;
  readonly entry: MoneyFlowJournalEntry<S>;
  readonly failure: FailureFence;
  readonly replayed: boolean;
};

/**
 * The application layer supplies this interpreter over a durable journal.
 * Every operation is keyed by the same server-derived idempotency key.
 * `confirm` is the only success transition, while `fail` must retain the
 * typed fence so reconciliation can never rebroadcast an ambiguous or legacy
 * effect. Repeated commands return `replayed: true` rather than creating a
 * second journal effect.
 */
export interface MoneyFlowInterpreter<S, E extends object> {
  readonly begin: (command: BeginJournalCommand<S>) => JournalBeginOutcome<S>;
  readonly confirm: (command: ConfirmJournalCommand<E>) => JournalConfirmOutcome<S>;
  readonly fail: (command: FailJournalCommand) => JournalFailOutcome<S>;
}
