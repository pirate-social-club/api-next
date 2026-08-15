// Generic money-flow state-machine shape (api-next 000 §11). Every flow that
// moves value implements this: one pure reducer with an explicit allowed-
// transition table and invariant assertions, driven identically by the
// request path and the cron reconciler. The story settlement step machine
// (../story/) is the worked example.

export type JournalEvent<F extends string = string> = {
  readonly type: F;
  readonly at: number;
};

export type TransitionRejection = { readonly rejected: string };

export type Reducer<S extends object, E extends object> = (
  state: S,
  event: E,
) => S | TransitionRejection;

export type AllowedTransitionTable<State extends string> = Readonly<
  Record<State, readonly State[]>
>;

export interface MoneyFlowMachine<S extends object, E extends object, State extends string> {
  readonly stateOf: (state: S) => State;
  readonly allowedTransitions: AllowedTransitionTable<State>;
  readonly assertInvariants: (state: S) => void;
  readonly reduce: Reducer<S, E>;
}

export function applyMachineEvent<S extends object, E extends object, State extends string>(
  machine: MoneyFlowMachine<S, E, State>,
  state: S,
  event: E,
): S {
  machine.assertInvariants(state);
  const next = machine.reduce(state, event);
  if ("rejected" in next) throw new Error(`state_transition_rejected:${next.rejected}`);
  const from = machine.stateOf(state);
  const to = machine.stateOf(next);
  if (!machine.allowedTransitions[from].includes(to)) {
    throw new Error(`illegal_state_transition:${from}:${to}`);
  }
  machine.assertInvariants(next);
  return next;
}

export function applyEvent<S extends object, E extends JournalEvent>(
  reducer: Reducer<S, E>,
  state: S,
  event: E,
): S {
  const next = reducer(state, event);
  if ("rejected" in next) throw new Error(`state_transition_rejected:${next.rejected}`);
  return next;
}
