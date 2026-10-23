import { expect, test } from "bun:test";
import { makeModeratedDancePublicationRuntime } from "./moderated-dance-publication-runtime.ts";
import { makeDirectPostgresControlPlaneLayer, type PostgresClientLike } from "./postgres.ts";

test("an unknown create-grant COMMIT escapes before provider I/O and never authorizes another create", async () => {
  let consumed = false,
    pendingCommit = false,
    lose = true,
    creates = 0,
    finds = 0;
  const work = {
    reviewId: "review",
    inputToken: "original",
    leaseToken: "observer",
    tag: "dance-publication:review:1",
    jobId: null,
    timeoutSeconds: 30,
    deadlineMs: Date.now() + 120000,
    bodyStartMs: 2000,
    bodyEndMs: 12000,
    sourceSha256: "a".repeat(64),
  };
  const driver: PostgresClientLike = {
    connect: async () => {},
    end: async () => {},
    query: async (q) => {
      if (q.text === "COMMIT" && pendingCommit) {
        pendingCommit = false;
        if (lose) {
          lose = false;
          throw new Error("Create grant COMMIT response lost");
        }
      }
      let packet: unknown = null;
      if (q.text.includes("claim_moderated_dance_publication_v1"))
        packet = { ...work, action: consumed ? "observe" : "create" };
      if (q.text.includes("moderated_dance_publication_provider_v1")) {
        if (q.values?.[1] === "source") packet = { expiresAtMs: work.deadlineMs };
        if (q.values?.[1] === "create") {
          consumed = true;
          pendingCommit = true;
          packet = { status: "create", tag: work.tag, timeoutSeconds: 30 };
        }
        if (q.values?.[1] === "observe") packet = { status: "observe", jobId: null, tag: work.tag };
      }
      return q.text.startsWith("SELECT ")
        ? { rows: [{ packet }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    },
  };
  const runtime = makeModeratedDancePublicationRuntime({
    runtime: makeDirectPostgresControlPlaneLayer("postgres://offline.invalid/unused", {
      clientFactory: () => driver,
      logger: { info: () => {}, error: () => {} },
    }),
    bucket: {
      head: async () => {
        throw new Error("Storage must not be reached");
      },
      get: async () => null,
      put: async () => {
        throw new Error("Storage must not be reached");
      },
    },
    gatewayOrigin: "https://gateway.example",
    runtimeRevision: "test-media",
    videoTrackEnabled: true,
    provider: {
      create: async () => {
        creates++;
        throw new Error("Provider must not be reached");
      },
      findByTag: async () => {
        finds++;
        return null;
      },
      showPrivatePublication: async () => {
        throw new Error("Job must be identified first");
      },
    },
  });
  await expect(runtime.run()).rejects.toMatchObject({
    _tag: "ControlPlaneTransactionOutcomeUnknown",
    phase: "commit",
  });
  expect(creates).toBe(0);
  expect(await runtime.run()).toEqual({ outcome: "waiting" });
  expect(creates).toBe(0);
  expect(finds).toBe(1);
});
