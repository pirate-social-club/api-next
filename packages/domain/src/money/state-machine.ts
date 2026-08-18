// Generic money-flow state-machine shape (api-next 000 §11). Every flow that
// moves value implements this: one pure reducer with an explicit allowed-
// transition table and invariant assertions, driven identically by the
// request path and the cron reconciler. The story settlement step machine
// (../story/) is the worked example.

export type TransitionRejection = {
  readonly _tag: "transition_rejected";
  readonly rejected: string;
};

export type Reducer<S extends object, E extends object> = (
  state: S,
  event: E,
) => S | TransitionRejection;

export type AllowedTransitionTable<State extends string> = Readonly<
  Record<State, readonly State[]>
>;

export type MoneyFlowMachineDefinition<S extends object, E extends object, State extends string> = {
  readonly stateOf: (state: S) => State;
  readonly allowedTransitions: AllowedTransitionTable<State>;
  readonly assertInvariants: (state: S) => void;
  readonly reduce: Reducer<S, E>;
};

export interface MoneyFlowMachine<S extends object, E extends object, State extends string> {
  readonly stateOf: (state: S) => State;
  readonly allowedTransitions: AllowedTransitionTable<State>;
  readonly assertInvariants: (state: S) => void;
  readonly transition: (state: S, event: E) => S | TransitionRejection;
}

export function rejectTransition(rejected: string): TransitionRejection {
  return { _tag: "transition_rejected", rejected };
}

export function isTransitionRejection(value: unknown): value is TransitionRejection {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    value._tag === "transition_rejected" &&
    "rejected" in value &&
    typeof value.rejected === "string"
  );
}

/**
 * Captures a reducer without exposing it. Every exported machine can only be
 * driven through the invariant- and matrix-checked transition closure.
 */
export function defineMoneyFlowMachine<S extends object, E extends object, State extends string>(
  definition: MoneyFlowMachineDefinition<S, E, State>,
): MoneyFlowMachine<S, E, State> {
  return {
    stateOf: definition.stateOf,
    allowedTransitions: definition.allowedTransitions,
    assertInvariants: definition.assertInvariants,
    transition: (state, event) => {
      definition.assertInvariants(state);
      const next = definition.reduce(state, event);
      if (isTransitionRejection(next)) return next;
      const from = definition.stateOf(state);
      const to = definition.stateOf(next);
      if (!definition.allowedTransitions[from].includes(to)) {
        return rejectTransition(`illegal_state_transition:${from}:${to}`);
      }
      definition.assertInvariants(next);
      return next;
    },
  };
}

/**
 * The non-throwing domain entry point. Persisted-state invariant failures still
 * throw because they are defects; expected event and matrix rejections remain
 * values for the application interpreter to handle.
 */
export function transitionMachineEvent<S extends object, E extends object, State extends string>(
  machine: MoneyFlowMachine<S, E, State>,
  state: S,
  event: E,
): S | TransitionRejection {
  return machine.transition(state, event);
}

/**
 * Compatibility adapter for domain machines whose existing API throws. New
 * money flows should expose the typed result from `transitionMachineEvent`.
 */
export function applyMachineEvent<S extends object, E extends object, State extends string>(
  machine: MoneyFlowMachine<S, E, State>,
  state: S,
  event: E,
): S {
  const next = transitionMachineEvent(machine, state, event);
  if (isTransitionRejection(next)) {
    if (next.rejected.startsWith("illegal_state_transition:")) throw new Error(next.rejected);
    throw new Error(`state_transition_rejected:${next.rejected}`);
  }
  return next;
}
