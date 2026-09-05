import { expect, test } from "bun:test";
import type { VideoStreamObservation } from "@pirate/domain";
import {
  consumeVideoStreamIngest,
  type VideoStreamClaim,
  type VideoStreamIngestServices,
} from "./stream-ingest.ts";

function fixture() {
  let row: VideoStreamClaim = {
    effectIdentity: "video-enrichment:operation-1:stream",
    leaseOwner: "fixture-writer",
    fence: 1,
    revision: 0,
    identity: {
      operationId: "operation-1",
      creator: "pirate-video-operation-1",
      sourceSha256: "a".repeat(64),
    },
    sealedSourceRef: "media://immutable/fixture-original",
    authority: {
      submissionId: "submission-1",
      postId: "post-1",
      creationRevision: 1,
      videoRevision: 1,
      analysisRevision: 1,
    },
    state: { state: "not_started" },
  };
  let time = 0;
  let copies = 0;
  let observations = 0;
  let completed = false;
  let copyThrows = false;
  let observationThrows = false;
  let completionResponseLost = false;
  let rejectTransition = false;
  let encoding: VideoStreamObservation["encoding"] = "pending";
  let matchesEmpty = false;
  const events: string[] = [];
  const services: VideoStreamIngestServices = {
    nowMs: () => time,
    deadlines: (now) => ({ acceptanceDeadlineMs: now + 100, encodingDeadlineMs: now + 1_000 }),
    store: {
      // Fixture models reacquisition after lease expiry, not a production lease implementation.
      claim: async () => (completed ? null : { ...row }),
      transition: async (claim, next, release) => {
        if (rejectTransition || claim.fence !== row.fence || claim.revision !== row.revision)
          return null;
        row = { ...row, revision: row.revision + 1, state: next };
        events.push(`persist:${next.state}:${release}`);
        if (release && ["ready", "failed", "reconciliation_required"].includes(next.state)) {
          completed = true;
          if (completionResponseLost) throw new Error("completion response lost");
        }
        return { ...row };
      },
    },
    transport: {
      copy: async (input) => {
        expect(row.state.state).toBe("sending");
        expect(input).toEqual({
          identity: row.identity,
          sealedSourceRef: row.sealedSourceRef,
          requireSignedURLs: true,
          downloadsEnabled: false,
        });
        copies++;
        events.push("copy");
        if (copyThrows) throw new Error("acceptance response lost");
      },
      observe: async () => {
        observations++;
        if (observationThrows) throw new Error("provider unavailable");
        return matchesEmpty
          ? []
          : [
              {
                providerVideoId: "provider-1",
                creator: row.identity.creator,
                sourceSha256: row.identity.sourceSha256,
                encoding,
                requireSignedURLs: true,
                downloadsEnabled: false,
              },
            ];
      },
    },
  };
  return {
    services,
    run: () => consumeVideoStreamIngest(row.effectIdentity, services),
    row: () => row,
    copies: () => copies,
    observations: () => observations,
    events,
    time: (value: number) => {
      time = value;
    },
    copyThrows: () => {
      copyThrows = true;
    },
    observationThrows: () => {
      observationThrows = true;
    },
    loseCompletion: () => {
      completionResponseLost = true;
    },
    rejectTransition: () => {
      rejectTransition = true;
    },
    encoding: (value: VideoStreamObservation["encoding"]) => {
      encoding = value;
    },
    empty: () => {
      matchesEmpty = true;
    },
    supersede: () => {
      row = { ...row, fence: row.fence + 1 };
    },
  };
}

test("persists before copy, binds without readiness, then completes without a second copy", async () => {
  const f = fixture();
  expect(await f.run()).toBe("pending");
  expect(f.events).toEqual(["persist:sending:false", "copy", "persist:bound:true"]);
  f.encoding("ready");
  expect(await f.run()).toBe("ready");
  expect(await f.run()).toBe("unclaimed");
  expect(f.copies()).toBe(1);
});

test("a rejected initial CAS never calls the provider", async () => {
  const f = fixture();
  f.rejectTransition();
  expect(await f.run()).toBe("stale");
  expect(f.copies()).toBe(0);
  expect(f.observations()).toBe(0);
});

test("ambiguous copy replays by observation with original deadlines", async () => {
  const f = fixture();
  f.copyThrows();
  expect(await f.run()).toBe("retry");
  expect(f.row().state.state).toBe("sending");
  f.time(50);
  f.encoding("ready");
  expect(await f.run()).toBe("ready");
  expect(f.row().state).toMatchObject({ acceptanceDeadlineMs: 100, encodingDeadlineMs: 1_000 });
  expect(f.copies()).toBe(1);
});

test("crash after committed intent but before copy cannot grant copy again", async () => {
  const f = fixture();
  const persist = f.services.store.transition;
  f.services.store.transition = async (...args) => {
    const result = await persist(...args);
    if (!args[2]) throw new Error("lost intent response");
    return result;
  };
  await expect(f.run()).rejects.toThrow("lost intent response");
  f.empty();
  f.time(100);
  expect(await f.run()).toBe("failed");
  expect(f.row().state).toMatchObject({
    state: "reconciliation_required",
    reason: "acceptance_unknown",
  });
  expect(f.copies()).toBe(0);
});

test("missing acceptance expires instead of recopying or resetting its deadline", async () => {
  const f = fixture();
  f.empty();
  expect(await f.run()).toBe("pending");
  f.time(99);
  expect(await f.run()).toBe("pending");
  f.time(100);
  expect(await f.run()).toBe("failed");
  expect(f.copies()).toBe(1);
});

test("provider lookup failure is retryable evidence absence, not terminal failure", async () => {
  const f = fixture();
  f.observationThrows();
  expect(await f.run()).toBe("retry");
  f.time(2_000);
  expect(await f.run()).toBe("retry");
  expect(f.row().state.state).toBe("sending");
  expect(f.copies()).toBe(1);
});

test("a superseded observation cannot overwrite durable state", async () => {
  const f = fixture();
  const observe = f.services.transport.observe;
  f.services.transport.observe = async (identity) => {
    const matches = await observe(identity);
    f.supersede();
    return matches;
  };
  expect(await f.run()).toBe("stale");
  expect(f.row().state.state).toBe("sending");
});

test("lost atomic completion response does not duplicate an encode or completion", async () => {
  const f = fixture();
  f.encoding("ready");
  f.loseCompletion();
  await expect(f.run()).rejects.toThrow("completion response lost");
  expect(await f.run()).toBe("unclaimed");
  expect(f.copies()).toBe(1);
  expect(f.events.filter((event) => event === "persist:ready:true")).toHaveLength(1);
});

test("encoding failure stops enrichment without a publication mutation", async () => {
  const f = fixture();
  f.encoding("error");
  expect(await f.run()).toBe("failed");
  expect(f.row().state).toMatchObject({
    state: "failed",
    reason: "encoding_failed",
    providerVideoId: "provider-1",
  });
  expect(await f.run()).toBe("unclaimed");
});
