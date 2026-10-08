import { AsyncLocalStorage } from "node:async_hooks";

type WaitUntil = (work: Promise<unknown>) => void;
const storage = new AsyncLocalStorage<WaitUntil>();

/**
 * Request-scoped access to a Worker's `waitUntil`, so work that is already durable can
 * continue after the response instead of waiting for a queue consumer.
 */
export const workerBackground = {
  run<A>(waitUntil: WaitUntil, use: () => A): A {
    return storage.run(waitUntil, use);
  },
  /** Starts the work beyond the response. Outside a request it starts nothing and says so. */
  defer(work: () => Promise<unknown>): boolean {
    const waitUntil = storage.getStore();
    if (waitUntil === undefined) return false;
    waitUntil(work());
    return true;
  },
};
