import { expect, test } from "bun:test";
import { dispatchVideoEnrichment } from "./enrichment-dispatch.ts";

test("enrichment dispatch emits identifiers only and a failed send remains replayable", async () => {
  const sent: unknown[] = [];
  const source = {
    listEligible: async () => [
      { effectIdentity: "first", payload: { source: "private" } },
      { effectIdentity: "second" },
    ],
  };
  const queue = {
    send: async (message: unknown) => {
      sent.push(message);
      if (sent.length === 1) throw new Error("lost queue acknowledgement");
    },
  };
  expect(await dispatchVideoEnrichment(source, queue)).toEqual({ selected: 2, sent: 1, failed: 1 });
  expect(sent).toEqual([
    { kind: "video_enrichment", outbox_id: "first" },
    { kind: "video_enrichment", outbox_id: "second" },
  ]);
  expect(await dispatchVideoEnrichment(source, queue)).toEqual({ selected: 2, sent: 2, failed: 0 });
});

test("dispatch rejects invalid limits and oversized source results before sending", async () => {
  let sends = 0;
  const queue = {
    send: async () => {
      sends++;
    },
  };
  const source = { listEligible: async () => [{ effectIdentity: "a" }, { effectIdentity: "b" }] };
  for (const limit of [0, 101, 1.5, Number.NaN])
    await expect(dispatchVideoEnrichment(source, queue, limit)).rejects.toThrow();
  await expect(dispatchVideoEnrichment(source, queue, 1)).rejects.toThrow(
    "exceeded dispatch bound",
  );
  expect(sends).toBe(0);
});
