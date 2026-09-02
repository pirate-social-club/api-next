const PROCESSING_QUEUE_RETRY_BASE_SECONDS = 15;
export const PROCESSING_QUEUE_RETRY_CAP_SECONDS = 900;

/** Shared media/DATA processing backoff; each lane retains its own attempt limit. */
export const processingQueueRetryDelaySeconds = (attempts: number): number =>
  Math.min(
    PROCESSING_QUEUE_RETRY_CAP_SECONDS,
    PROCESSING_QUEUE_RETRY_BASE_SECONDS * 2 ** Math.max(0, attempts - 1),
  );
