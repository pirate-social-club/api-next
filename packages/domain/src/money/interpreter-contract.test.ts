import { describe, expect, test } from "bun:test";
import { deriveCommunityPurchaseOperationId } from "./community-purchase-funding";
import { AMBIGUOUS, LEGACY, RECLAIMABLE } from "./failure-fence";
import type {
  BeginJournalCommand,
  MoneyFlowJournalEntry,
  MoneyFlowJournalStatus,
  ServerDerivedIdempotencyKey,
  TerminalFailureResolution,
  TransitionJournalCommand,
} from "./interpreter-contract";

type State = { readonly step: MoneyFlowJournalStatus };
type Event = { readonly type: "observe" };

const KEY = deriveCommunityPurchaseOperationId({
  communityId: "community_1",
  quoteId: "quote_1",
  purchaseId: "purchase_1",
  policyVersion: 3,
});

// @ts-expect-error Client strings are not server-derived journal keys.
const CLIENT_NONCE_IS_NOT_A_KEY: ServerDerivedIdempotencyKey = "client_nonce";
void CLIENT_NONCE_IS_NOT_A_KEY;

const TERMINAL: TerminalFailureResolution = {
  _tag: "terminal",
  disposition: "terminal_failed",
  noValueMoved: true,
  mayRebroadcast: false,
  mayRetry: false,
  priorFence: AMBIGUOUS,
  evidenceRef: "receipt:reconciled-no-value",
};

// @ts-expect-error Reclaimable failures are not reconciliation-only.
const RECONCILIATION_WITH_RECLAIMABLE: MoneyFlowJournalEntry<State> = {
  idempotencyKey: KEY,
  version: 1,
  state: { step: "reconciliation_required" },
  status: "reconciliation_required",
  failure: RECLAIMABLE,
};
void RECONCILIATION_WITH_RECLAIMABLE;

// @ts-expect-error Ambiguous failures cannot enter the safe retry state.
const RECLAIMABLE_WITH_AMBIGUOUS: MoneyFlowJournalEntry<State> = {
  idempotencyKey: KEY,
  version: 1,
  state: { step: "reclaimable_failed" },
  status: "reclaimable_failed",
  failure: AMBIGUOUS,
};
void RECLAIMABLE_WITH_AMBIGUOUS;

// @ts-expect-error Active entries cannot carry failure metadata.
const ACTIVE_WITH_FAILURE: MoneyFlowJournalEntry<State> = {
  idempotencyKey: KEY,
  version: 1,
  state: { step: "confirming" },
  status: "confirming",
  failure: AMBIGUOUS,
};
void ACTIVE_WITH_FAILURE;

// @ts-expect-error A raw reclaimable fence is not terminal proof.
const TERMINAL_WITH_RECLAIMABLE: MoneyFlowJournalEntry<State> = {
  idempotencyKey: KEY,
  version: 1,
  state: { step: "terminal_failed" },
  status: "terminal_failed",
  failure: RECLAIMABLE,
};
void TERMINAL_WITH_RECLAIMABLE;

describe("money-flow interpreter contract", () => {
  test("keys begin and every transition by the same server-derived identity", () => {
    const begin: BeginJournalCommand<State> = {
      operation: "begin",
      idempotencyKey: KEY,
      initialState: { step: "planned" },
    };
    const transition: TransitionJournalCommand<Event> = {
      operation: "transition",
      idempotencyKey: begin.idempotencyKey,
      expectedVersion: 1,
      event: { type: "observe" },
    };
    expect(transition.idempotencyKey).toBe(begin.idempotencyKey);
  });

  test("represents the complete durable status vocabulary", () => {
    const statuses = [
      "planned",
      "nonce_reserved",
      "prepared",
      "broadcast_pending",
      "confirming",
      "confirmed",
      "reverted",
      "replaced",
      "reclaimable_failed",
      "reconciliation_required",
      "terminal_failed",
    ] as const satisfies readonly MoneyFlowJournalStatus[];
    expect(statuses).toEqual([
      "planned",
      "nonce_reserved",
      "prepared",
      "broadcast_pending",
      "confirming",
      "confirmed",
      "reverted",
      "replaced",
      "reclaimable_failed",
      "reconciliation_required",
      "terminal_failed",
    ]);
  });

  test("retains a coherent typed fence inside every failed journal entry", () => {
    const entries: MoneyFlowJournalEntry<State>[] = [
      {
        idempotencyKey: KEY,
        version: 2,
        state: { step: "reclaimable_failed" },
        status: "reclaimable_failed",
        failure: RECLAIMABLE,
      },
      {
        idempotencyKey: KEY,
        version: 3,
        state: { step: "reconciliation_required" },
        status: "reconciliation_required",
        failure: AMBIGUOUS,
      },
      {
        idempotencyKey: KEY,
        version: 4,
        state: { step: "reconciliation_required" },
        status: "reconciliation_required",
        failure: LEGACY,
      },
      {
        idempotencyKey: KEY,
        version: 5,
        state: { step: "terminal_failed" },
        status: "terminal_failed",
        failure: TERMINAL,
      },
    ];
    expect(entries.map((entry) => entry.failure?._tag)).toEqual([
      "reclaimable",
      "ambiguous",
      "legacy",
      "terminal",
    ]);
  });
});
