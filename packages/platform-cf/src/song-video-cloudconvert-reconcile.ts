import type {
  CloudConvertJob,
  CloudConvertJobObservation,
} from "./song-video-cloudconvert-transport.ts";
import {
  type VerifiedCloudConvertMaster,
  verifyCloudConvertExport,
} from "./song-video-cloudconvert-verified-master.ts";

export type CloudConvertRenderObservation =
  | Readonly<{ status: "pending" }>
  | Readonly<{ status: "refused"; reason: "provider_failed" }>
  | Readonly<{ status: "operator_reconciliation"; reason: "provider_wait_expired" }>
  | Readonly<{ status: "verified"; jobId: string; master: VerifiedCloudConvertMaster }>;

/**
 * Reconciles a possibly lost create response from the attempt's exact tag.
 * A missing tag is inconclusive, not permission to create a second job.
 * Once the persisted wait deadline is reached, no late provider result can
 * silently revive the attempt. Only an operator may reconcile it.
 */
export async function reconcileCloudConvertRender(
  input: Readonly<{
    tag: string;
    nowMs: number;
    providerWaitDeadlineMs: number;
    expectedSamples: number;
    expectedPcmSha256: string;
    jobs: Readonly<{
      findByTag: (tag: string) => Promise<CloudConvertJob | null>;
      show: (jobId: string) => Promise<CloudConvertJobObservation>;
    }>;
    fetch: (url: string, init: RequestInit) => Promise<Response>;
  }>,
): Promise<CloudConvertRenderObservation> {
  if (
    !Number.isSafeInteger(input.nowMs) ||
    !Number.isSafeInteger(input.providerWaitDeadlineMs) ||
    input.providerWaitDeadlineMs <= 0
  ) {
    throw new TypeError("invalid CloudConvert provider wait clock");
  }
  if (input.nowMs >= input.providerWaitDeadlineMs) {
    return { status: "operator_reconciliation", reason: "provider_wait_expired" };
  }
  const job = await input.jobs.findByTag(input.tag);
  if (job === null) return { status: "pending" };
  if (job.tag !== input.tag) throw new Error("CloudConvert attempt tag mismatch");
  if (job.status === "error") return { status: "refused", reason: "provider_failed" };
  if (job.status !== "finished") return { status: "pending" };

  const observed = await input.jobs.show(job.id);
  if (observed.id !== job.id || observed.tag !== input.tag) {
    throw new Error("CloudConvert job identity changed");
  }
  if (observed.status === "error") return { status: "refused", reason: "provider_failed" };
  if (observed.status !== "finished") return { status: "pending" };
  if (observed.exportUrl === null) throw new Error("CloudConvert finished without export");
  const master = await verifyCloudConvertExport({
    exportUrl: observed.exportUrl,
    expectedSamples: input.expectedSamples,
    expectedPcmSha256: input.expectedPcmSha256,
    fetch: input.fetch,
  });
  return { status: "verified", jobId: job.id, master };
}
