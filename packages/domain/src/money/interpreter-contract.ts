import type {
  AmbiguousFailure,
  FailureFence,
  LegacyFailure,
  ReclaimableFailure,
} from "./failure-fence";

/**
 * M3's application interpreter owns persistence and I/O. This file fixes the
 * domain contract that both the request path and reconciler must call; it is
 * deliberately not a journal implementation.
 */
declare const serverDerivedIdempotencyKeyBrand: unique symbol;

/** A journal key that can only enter the domain through server-owned derivation. */
export type ServerDerivedIdempotencyKey = string & {
  readonly [serverDerivedIdempotencyKeyBrand]: "ServerDerivedIdempotencyKey";
};

export type MoneyFlowJournalStatus =
  // Flow-specific pre-effect state; §7's ten durable effect states follow.
  | "planned"
  | "dormant_unobserved"
  | "nonce_reserved"
  | "prepared"
  | "broadcast_pending"
  | "confirming"
  | "confirmed"
  | "reverted"
  | "replaced"
  | "reclaimable_failed"
  | "reconciliation_required"
  | "terminal_failed";

type NonFailureJournalStatus = Exclude<
  MoneyFlowJournalStatus,
  "reclaimable_failed" | "reconciliation_required" | "terminal_failed"
>;

type JournalEntryBase<S> = {
  readonly idempotencyKey: ServerDerivedIdempotencyKey;
  readonly version: number;
  readonly state: S;
};

export type TerminalFailureResolution = {
  readonly _tag: "terminal";
  readonly disposition: "terminal_failed";
  readonly noValueMoved: true;
  readonly mayRebroadcast: false;
  readonly mayRetry: false;
  readonly priorFence: FailureFence;
  readonly evidenceRef: string;
};

export type MoneyFlowJournalEntry<S> = JournalEntryBase<S> &
  (
    | { readonly status: NonFailureJournalStatus; readonly failure?: never }
    | { readonly status: "reclaimable_failed"; readonly failure: ReclaimableFailure }
    | {
        readonly status: "reconciliation_required";
        readonly failure: AmbiguousFailure | LegacyFailure;
      }
    | { readonly status: "terminal_failed"; readonly failure: TerminalFailureResolution }
  );

export type BeginJournalCommand<S> = {
  readonly operation: "begin";
  readonly idempotencyKey: ServerDerivedIdempotencyKey;
  readonly initialState: S;
};

export type MoneyFlowEvent = { readonly type: string };

/**
 * `E` is the concrete reducer's closed event union. Any event capable of
 * producing a failure state carries its typed fence inside that union; the
 * interpreter never invents a failure status beside the reducer.
 */
export type TransitionJournalCommand<E extends MoneyFlowEvent> = {
  readonly operation: "transition";
  readonly idempotencyKey: ServerDerivedIdempotencyKey;
  readonly expectedVersion: number;
  readonly event: E;
};

export type JournalBeginOutcome<S> = {
  readonly _tag: "journal_begin";
  readonly idempotencyKey: ServerDerivedIdempotencyKey;
  readonly entry: MoneyFlowJournalEntry<S>;
  readonly replayed: boolean;
};

export type JournalTransitionOutcome<S> = {
  readonly _tag: "journal_transition";
  readonly idempotencyKey: ServerDerivedIdempotencyKey;
  readonly entry: MoneyFlowJournalEntry<S>;
  readonly replayed: boolean;
};

/**
 * The application layer supplies this interpreter over a durable journal.
 * Every operation is keyed by the same server-derived idempotency key.
 * `transition` is the only update path and must drive the domain reducer for
 * both requests and reconciliation. Failed entries retain the typed fence so
 * an ambiguous or legacy effect can never become an ordinary retry. Repeated
 * commands return `replayed: true` rather than creating another journal effect.
 */
export interface MoneyFlowInterpreter<S, E extends MoneyFlowEvent> {
  readonly begin: (command: BeginJournalCommand<S>) => JournalBeginOutcome<S>;
  readonly transition: (command: TransitionJournalCommand<E>) => JournalTransitionOutcome<S>;
}
