import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { prepareModeratedDanceTerms } from "../../application/src/use-cases/dance/moderated-intake.ts";
import { moderatedDanceIntakeFacts } from "../../testing/src/moderated-dance-intake-fixture.ts";
import { makeModeratedDanceMediaRuntime } from "./moderated-dance-media-runtime.ts";
import { makeDirectPostgresControlPlaneLayer, type PostgresClientLike } from "./postgres.ts";
import { makeSongVideoCloudConvertTransport } from "./song-video-cloudconvert-transport.ts";

async function fixture() {
  const facts = moderatedDanceIntakeFacts();
  const terms = await Effect.runPromise(
    prepareModeratedDanceTerms(
      facts,
      { sessionId: "session", reviewId: "review", attemptId: "attempt" },
      "arms_t",
    ),
  );
  const work = {
    action: "dispatch",
    uploadId: "upload",
    token: "observation",
    sessionId: "session",
    reviewId: "review",
    accountId: facts.accountId,
    communityId: facts.communityId,
    accountFence: 1,
    terms,
    ingressKey: "moderated-dance/ingress/11111111-1111-4111-8111-111111111111/source",
    contentType: "video/mp4",
    sizeBytes: 100,
    consentReceiptId: "consent",
    consentRecordedAtMs: 1001,
    reservedAtMs: 1002,
    source: {
      outcome: "sealed",
      immutable_ref: "source",
      destination_ref: "moderated-dance/originals/upload/source",
      etag: "etag",
      version: "v1",
      size_bytes: 100,
      canonical_sha256: "a".repeat(64),
      firstStoredAtMs: 1003,
      ingress_identity: { key: "source", version: "v1", etag: "etag", size: 100 },
    },
    providerTag: "private-dance-upload",
    providerJobId: null,
    workToken: "original-provider-purpose",
    providerDeadlineMs: 61000,
  };
  const providerCalls: string[] = [],
    sql: string[] = [],
    probeCalls: string[] = [],
    sealCalls: string[] = [],
    sealProofs: unknown[] = [];
  let rawWork: unknown = work,
    storedAtMs = 1003,
    foreignDestination = false;
  let normalizationConsumed = false,
    loseGrantCommit = false,
    pendingLostCommit = false;
  let probeComplete = true;
  const attempt = {
    version: "media-transform-attempt-v1",
    runtimeFence: { submittedAtMs: 1000, runtimeDeadlineMs: 61000 },
  };
  const driver: PostgresClientLike = {
    connect: async () => {},
    end: async () => {},
    query: async (q) => {
      sql.push(q.text);
      if (q.text === "COMMIT" && pendingLostCommit) {
        pendingLostCommit = false;
        throw new Error("offline normalization claim acknowledgement lost");
      }
      let packet: unknown = null;
      if (q.text.includes("claim_moderated_dance_media_v1")) packet = rawWork;
      else if (q.text.includes("persist_moderated_dance_seal_v1"))
        sealProofs.push(JSON.parse(String(q.values?.[2])));
      else if (q.text.includes("claim_moderated_dance_probe_v1"))
        packet = {
          fresh: false,
          phase: probeComplete ? "complete" : "allocating",
          attempt,
          probe: null,
        };
      else if (q.text.includes("claim_moderated_dance_normalization_v1")) {
        packet = !normalizationConsumed;
        normalizationConsumed = true;
        if (loseGrantCommit) {
          loseGrantCommit = false;
          pendingLostCommit = true;
        }
      } else if (
        q.text.startsWith("SELECT ") &&
        !/set_config\(|announce_moderated_dance_processor_v1|issue_moderated_dance_source_v1|mark_moderated_dance_media_unknown_v1/u.test(
          q.text,
        )
      )
        throw new Error(`unexpected offline query ${q.text}`);
      return q.text.startsWith("SELECT ")
        ? { rows: [{ packet }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    },
  };
  const forbidden = async () => {
    throw new Error("No storage operation belongs to these protocol cases");
  };
  const transform = makeSongVideoCloudConvertTransport({
    apiKey: "test-only",
    fetch: async (url, init) => {
      providerCalls.push(`${init.method} ${url}`);
      if (init.method === "POST")
        throw new Error("offline provider response lost; submission may have happened");
      return new Response(JSON.stringify({ data: [] }));
    },
  });
  const processor = makeModeratedDanceMediaRuntime({
    runtime: makeDirectPostgresControlPlaneLayer("postgres://offline.invalid/unused", {
      clientFactory: () => driver,
      logger: { info: () => {}, error: () => {} },
    }),
    ingress: {
      head: async () => ({
        key: work.ingressKey,
        version: "ingress-v1",
        etag: "ingress-etag",
        httpEtag: '"ingress-etag"',
        size: 100,
        uploaded: new Date(storedAtMs),
        storageClass: "Standard",
        checksums: { toJSON: () => ({}) },
        httpMetadata: { contentType: "video/mp4" },
        writeHttpMetadata: () => {},
      }),
      get: forbidden,
    },
    originals: { head: forbidden, get: forbidden, put: forbidden },
    sealer: {
      inspect: async (request) => {
        sealCalls.push("inspect");
        expect(request.sourceKey).toBe(work.ingressKey);
        return {
          outcome: "ready",
          source: {
            key: work.ingressKey,
            version: "ingress-v1",
            etag: "ingress-etag",
            size: 100,
            contentType: "video/mp4",
            checksums: {},
            ownerMarker: null,
            sourceVersion: null,
          },
        };
      },
      seal: async (request) => {
        sealCalls.push("seal");
        return {
          result: {
            outcome: "sealed",
            immutable_ref: request.immutableRef,
            destination_ref: foreignDestination
              ? "r2://foreign/source"
              : `r2://${request.destinationKey}`,
            etag: "immutable-etag",
            version: "immutable-v1",
            size_bytes: 100,
            canonical_sha256: "a".repeat(64),
          },
        };
      },
    },
    transform,
    image: { evaluateImage: () => Effect.die(new Error("No safety purpose granted")) },
    probeForSource: () => ({
      allocate: () =>
        Effect.sync(() => {
          probeCalls.push("allocate");
          throw new Error("No allocation grant");
        }),
      submit: () =>
        Effect.sync(() => {
          probeCalls.push("submit");
          throw new Error("No submission grant");
        }),
      observe: () =>
        Effect.sync(() => {
          probeCalls.push("observe");
          throw new Error("No original provider identity");
        }),
    }),
    replayKeys: new Map([[facts.profile.replayKeyEpoch, new Uint8Array(32).fill(1)]]),
    gatewayOrigin: "https://source.test",
    runtimeRevision: facts.profile.mediaRuntimeRevision,
    safetyRevision: facts.profile.safetyProviderRevision,
    now: () => 2000,
    randomId: () => "observation",
  });
  return {
    processor,
    providerCalls,
    sql,
    probeCalls,
    sealCalls,
    sealProofs,
    useSeal: (atMs = 1003, foreign = false) => {
      rawWork = { ...work, action: "seal", source: null };
      storedAtMs = atMs;
      foreignDestination = foreign;
    },
    loseGrantCommit: () => {
      loseGrantCommit = true;
    },
    uncertainProbeAllocation: () => {
      probeComplete = false;
    },
  };
}

describe("actual private capture orchestration with offline SQL/provider ports", () => {
  test("accepted sealer R2 URI maps only to the original private target, with actual ingress identity/time", async () => {
    const f = await fixture();
    f.useSeal();
    expect(await f.processor.run()).toEqual({ outcome: "sealed" });
    expect(f.sealCalls).toEqual(["inspect", "seal"]);
    expect(f.sealProofs).toEqual([
      expect.objectContaining({
        destination_ref: "moderated-dance/originals/upload/source",
        firstStoredAtMs: 1003,
        ingress_identity: {
          key: "moderated-dance/ingress/11111111-1111-4111-8111-111111111111/source",
          version: "ingress-v1",
          etag: "ingress-etag",
          size: 100,
        },
      }),
    ]);
    expect(f.providerCalls).toEqual([]);
  });
  test("foreign sealer destination never becomes a private capture proof", async () => {
    const f = await fixture();
    f.useSeal(1003, true);
    expect(await f.processor.run()).toEqual({ outcome: "unknown" });
    expect(f.sealProofs).toEqual([]);
    expect(f.sealCalls).toEqual(["inspect", "seal"]);
  });
  test("a storage timestamp before reservation/consent cannot be replaced by a server clock", async () => {
    const f = await fixture();
    f.useSeal(1000);
    expect(await f.processor.run()).toEqual({ outcome: "unknown" });
    expect(f.sealCalls).toEqual([]);
    expect(f.sealProofs).toEqual([]);
  });
  test("unknown normalization POST retains its purpose; repeated absence never permits another POST", async () => {
    const f = await fixture();
    expect(await f.processor.run()).toEqual({ outcome: "unknown" });
    expect(await f.processor.run()).toEqual({ outcome: "unknown" });
    expect(await f.processor.run()).toEqual({ outcome: "unknown" });
    expect(f.providerCalls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
    expect(f.providerCalls.filter((c) => c.startsWith("GET"))).toHaveLength(2);
    expect(f.sql.filter((s) => s.includes("issue_moderated_dance_source_v1"))).toHaveLength(1);
    expect(f.probeCalls).toEqual([]);
  });
  test("lost purpose-claim COMMIT escapes before provider I/O and recovery does not restore it", async () => {
    const f = await fixture();
    f.loseGrantCommit();
    await expect(f.processor.run()).rejects.toMatchObject({
      _tag: "ControlPlaneTransactionOutcomeUnknown",
      phase: "commit",
    });
    expect(f.providerCalls).toHaveLength(0);
    expect(f.sql.filter((s) => s.includes("issue_moderated_dance_source_v1"))).toHaveLength(0);
    expect(await f.processor.run()).toEqual({ outcome: "unknown" });
    expect(f.providerCalls.filter((c) => c.startsWith("POST"))).toHaveLength(0);
    expect(f.providerCalls.filter((c) => c.startsWith("GET"))).toHaveLength(1);
  });
  test("an uncertain probe allocation without original provider identity cannot allocate, start or observe again", async () => {
    const f = await fixture();
    f.uncertainProbeAllocation();
    expect(await f.processor.run()).toEqual({ outcome: "unknown" });
    expect(f.probeCalls).toEqual([]);
    expect(f.providerCalls).toEqual([]);
    expect(f.sql.some((s) => s.includes("claim_moderated_dance_normalization_v1"))).toBe(false);
  });
});
