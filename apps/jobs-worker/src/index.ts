/**
 * @pirate/jobs-worker — scheduler kernel, queue consumers, reconcilers,
 * alert collector.
 *
 * Lane C owns this app (api-next 001 §5). Spike order is mandatory: the
 * workerd risk-retirement spike with its go/no-go report precedes adapters
 * and the kernel.
 */
export const jobsWorker = "api-next/jobs-worker: lane C (001 §5)" as const;
