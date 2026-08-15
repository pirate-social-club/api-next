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

export type Reducer<S extends object, E extends JournalEvent> = (
  state: S,
  event: E,
) => S | TransitionRejection;

export function applyEvent<S extends object, E extends JournalEvent>(
  reducer: Reducer<S, E>,
  state: S,
  event: E,
): S {
  const next = reducer(state, event);
  if ("rejected" in next) throw new Error(`state_transition_rejected:${next.rejected}`);
  return next;
}
