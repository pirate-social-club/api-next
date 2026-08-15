/**
 * @pirate/http-worker — route table from contracts + HTTP adapter only.
 *
 * Lane A owns this app (api-next 001 §3). Routes are thin from day one:
 * generated from the contracts package, no hand-written routing.
 */
export const httpWorker = "api-next/http-worker: lane A (001 §3)" as const;
