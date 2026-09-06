export interface VideoEnrichmentDispatchSource {
  listEligible(limit: number): Promise<readonly Readonly<{ effectIdentity: string }>[]>;
}

/** Scheduled outbox delivery is repeatable; only a consumer's durable claim permits I/O. */
export async function dispatchVideoEnrichment(
  source: VideoEnrichmentDispatchSource,
  queue: {
    send(message: Readonly<{ kind: "video_enrichment"; outbox_id: string }>): Promise<void>;
  },
  limit = 25,
): Promise<Readonly<{ selected: number; sent: number; failed: number }>> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new TypeError("Video enrichment dispatch limit must be between 1 and 100");
  const rows = await source.listEligible(limit);
  if (rows.length > limit) throw new Error("Video enrichment source exceeded dispatch bound");
  let sent = 0;
  // Serial dispatch bounds pressure and isolates one failed delivery from the rest.
  for (const row of rows) {
    try {
      await queue.send({ kind: "video_enrichment", outbox_id: row.effectIdentity });
      sent++;
    } catch {
      // Leave the durable row untouched for the next scheduled tick.
    }
  }
  return { selected: rows.length, sent, failed: rows.length - sent };
}
