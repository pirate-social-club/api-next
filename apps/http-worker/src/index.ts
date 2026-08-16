/**
 * @pirate/http-worker — route table from contracts + HTTP adapter only.
 *
 * Lane A owns this app (api-next 001 §3). Routes are thin from day one:
 * generated from the contracts package, no product handlers in this slice.
 */
import { createHttpWorker } from "./transport.ts";

export { createHttpWorker, withEndpointResult } from "./transport.ts";

export const app = createHttpWorker();
export default app;
