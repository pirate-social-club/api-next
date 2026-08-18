import { describe, expect, test } from "bun:test";
import {
  defineMoneyFlowMachine,
  isTransitionRejection,
  rejectTransition,
  transitionMachineEvent,
} from "./state-machine";

type StateName = "idle" | "ready" | "done";
type Snapshot = { readonly state: StateName; readonly valid: boolean };
type Event =
  | { readonly type: "ready" }
  | { readonly type: "done" }
  | { readonly type: "reject" }
  | { readonly type: "break_postcondition" };

const machine = defineMoneyFlowMachine<Snapshot, Event, StateName>({
  stateOf: (snapshot) => snapshot.state,
  allowedTransitions: {
    idle: ["ready"],
    ready: ["done"],
    done: [],
  },
  assertInvariants: (snapshot) => {
    if (!snapshot.valid) throw new Error("snapshot_invalid");
  },
  reduce: (snapshot, event) => {
    if (event.type === "reject") return rejectTransition("expected_rejection");
    if (event.type === "break_postcondition") return { state: "ready", valid: false };
    if (event.type === "ready") return { ...snapshot, state: "ready" };
    return { ...snapshot, state: "done" };
  },
});
const IDLE: Snapshot = { state: "idle", valid: true };
const INVALID_IDLE: Snapshot = { state: "idle", valid: false };
// @ts-expect-error Defined machines expose only the checked transition closure.
void machine.reduce;

describe("money-flow state-machine boundary", () => {
  test("returns expected reducer and matrix failures as typed values", () => {
    const rejected = transitionMachineEvent(machine, IDLE, {
      type: "reject",
    });
    expect(rejected).toEqual({
      _tag: "transition_rejected",
      rejected: "expected_rejection",
    });

    const illegal = transitionMachineEvent(machine, IDLE, {
      type: "done",
    });
    expect(illegal).toEqual({
      _tag: "transition_rejected",
      rejected: "illegal_state_transition:idle:done",
    });
    expect(isTransitionRejection(illegal)).toBe(true);
    expect(isTransitionRejection(null)).toBe(false);
    expect(isTransitionRejection("transition_rejected")).toBe(false);
    expect(isTransitionRejection({ _tag: "transition_rejected" })).toBe(false);
  });

  test("asserts invariants before and after every accepted reduction", () => {
    expect(() => transitionMachineEvent(machine, INVALID_IDLE, { type: "ready" })).toThrow(
      "snapshot_invalid",
    );
    expect(() =>
      transitionMachineEvent(machine, IDLE, {
        type: "break_postcondition",
      }),
    ).toThrow("snapshot_invalid");
  });
});
