export function makeRetryingPromiseCache<Input, Output>(
  create: (input: Input) => Promise<Output>,
): (input: Input) => Promise<Output> {
  let cached: Promise<Output> | undefined;

  return (input) => {
    if (cached !== undefined) return cached;
    const pending = Promise.resolve().then(() => create(input));
    const guarded = pending.catch((error) => {
      if (cached === guarded) cached = undefined;
      throw error;
    });
    cached = guarded;
    return guarded;
  };
}
