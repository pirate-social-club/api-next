import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import {
  makeModeratedDancePublicationCleanup,
  makeModeratedDancePublicationStorage,
} from "../../packages/platform-cf/src/moderated-dance-publication-storage.ts";

const bucket = (env as typeof env & { MEDIA_IMMUTABLE_ORIGINALS: R2Bucket })
  .MEDIA_IMMUTABLE_ORIGINALS;
const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((v) => v.toString(16).padStart(2, "0")).join("");
async function fixture() {
  const reviewId = crypto.randomUUID(),
    token = crypto.randomUUID(),
    fenceToken = crypto.randomUUID(),
    key = `immutable/dance-post-operation:${reviewId}/video/1`,
    bytes = new Uint8Array([0, 1, 2, 3, 255]),
    plan = {
      key,
      sha256: hex(await crypto.subtle.digest("SHA-256", bytes)),
      size: bytes.length,
      sourceSha256: "a".repeat(64),
      bodyStartMs: 3000,
      bodyEndMs: 15000,
      durationMs: 12000,
      transformRevision: "dance-publication-body-v1",
    };
  let consumed = false,
    cleanupConsumed = false,
    closed = false,
    adopted = false,
    losePut = false,
    loseCommit = false,
    loseCleanupCommit = false,
    raceWriter = false,
    noChecksum = false;
  const observations: unknown[] = [],
    results: unknown[] = [];
  let puts = 0,
    reads = 0,
    heads = 0;
  const objectStore = {
    head: async (k: string) => {
      heads++;
      const head = await bucket.head(k);
      return head !== null && noChecksum
        ? {
            ...head,
            checksums: { toJSON: () => ({}) },
            writeHttpMetadata: (headers: Headers) => head.writeHttpMetadata(headers),
          }
        : head;
    },
    get: async (k: string, options?: R2GetOptions) => {
      reads++;
      return bucket.get(k, options);
    },
    put: async (k: string, body: Parameters<R2Bucket["put"]>[1], options?: R2PutOptions) => {
      puts++;
      if (raceWriter) {
        raceWriter = false;
        await bucket.put(key, bytes, {
          sha256: plan.sha256,
          httpMetadata: { contentType: "video/mp4" },
          customMetadata: { dancePublicationInput: token, dancePublicationReview: reviewId },
        });
      }
      const result = await bucket.put(k, body, options);
      if (losePut) {
        losePut = false;
        throw new Error("R2 committed but reply was lost");
      }
      return result;
    },
  };
  const call = async (
    _label: string,
    sql: string,
    values: readonly unknown[],
  ): Promise<unknown> => {
    if (sql.includes("claim_moderated_dance_publication_cleanup_v1")) {
      if (adopted) return null;
      closed = true;
      const fresh = !cleanupConsumed;
      cleanupConsumed = true;
      if (loseCleanupCommit) {
        loseCleanupCommit = false;
        throw new Error("Cleanup grant COMMIT unknown");
      }
      return {
        reviewId,
        key,
        plan,
        body: null,
        inputToken: token,
        fenceToken,
        delivery: fresh ? "fresh_grant" : "recovery_only",
      };
    }
    if (sql.includes("finish_moderated_dance_publication_cleanup_v1")) {
      results.push(JSON.parse(String(values[2])));
      return null;
    }
    const action = values[1],
      fields = JSON.parse(String(values[2]));
    if (fields.token !== token) throw new Error("Original token required");
    if (action === "inspect")
      return {
        review_id: reviewId,
        token,
        destination_key: key,
        state: adopted ? "adopted" : closed ? "cleanup" : "preparing",
        body_plan: plan,
      };
    if (closed || adopted) throw new Error("Original lifecycle closed");
    if (action === "plan") return plan;
    if (action === "put") {
      if (consumed) return { status: "unknown" };
      consumed = true;
      if (loseCommit) {
        loseCommit = false;
        throw new Error("PUT grant COMMIT unknown");
      }
      return { status: "put", body: plan };
    }
    if (action === "observe") {
      observations.push(fields.body);
      return fields.body;
    }
    throw new Error(`Unexpected command ${String(action)}`);
  };
  return {
    plan,
    key,
    bytes,
    token,
    reviewId,
    fenceToken,
    objectStore,
    observations,
    results,
    storage: makeModeratedDancePublicationStorage({
      call,
      bucket: objectStore,
      reviewId,
      token,
      videoTrackEnabled: true,
      signal: new AbortController().signal,
    }),
    cleanup: makeModeratedDancePublicationCleanup({ call, bucket: objectStore }),
    counts: () => ({ puts, reads, heads }),
    losePut: () => {
      losePut = true;
    },
    loseCommit: () => {
      loseCommit = true;
    },
    loseCleanupCommit: () => {
      loseCleanupCommit = true;
    },
    raceWriter: () => {
      raceWriter = true;
    },
    noChecksum: () => {
      noChecksum = true;
    },
    adopt: () => {
      adopted = true;
    },
  };
}

describe("Dance independent input in Workerd with real R2 and an offline command journal", () => {
  test("lost upload reply recovers exact version/hash without another PUT", async () => {
    const f = await fixture();
    f.losePut();
    expect(await f.storage.store(f.plan, f.bytes)).toEqual({ outcome: "unknown" });
    expect(f.observations).toHaveLength(0);
    expect(await f.storage.recover()).toEqual({ outcome: "stored" });
    expect(await f.storage.store(f.plan, f.bytes)).toEqual({ outcome: "stored" });
    const head = await bucket.head(f.key);
    expect(f.observations).toEqual([
      { ...f.plan, version: head?.version, etag: head?.etag },
      { ...f.plan, version: head?.version, etag: head?.etag },
    ]);
    expect(f.counts()).toMatchObject({ puts: 1, reads: 0 });
    await bucket.delete(f.key);
  });
  test("lost grant COMMIT cannot dispatch or regain the consumed PUT", async () => {
    const f = await fixture();
    f.loseCommit();
    await expect(f.storage.store(f.plan, f.bytes)).rejects.toThrow("COMMIT unknown");
    expect(await f.storage.store(f.plan, f.bytes)).toEqual({ outcome: "unknown" });
    expect(f.counts().puts).toBe(0);
    expect(f.observations).toHaveLength(0);
  });
  test("body/hash/duration/key substitutions cannot cross the storage boundary", async () => {
    const f = await fixture();
    for (const plan of [
      { ...f.plan, size: 6 },
      { ...f.plan, sha256: "b".repeat(64) },
      { ...f.plan, key: "immutable/foreign/video/1" },
      { ...f.plan, durationMs: 12001 },
      { ...f.plan, bodyEndMs: 34000, durationMs: 31000 },
    ])
      await expect(f.storage.store(plan, f.bytes)).rejects.toThrow();
    expect(f.counts().puts).toBe(0);
  });
  test("missing stored checksum requires a bounded conditional byte digest", async () => {
    const f = await fixture();
    expect(await f.storage.store(f.plan, f.bytes)).toEqual({ outcome: "stored" });
    f.noChecksum();
    expect(await f.storage.recover()).toEqual({ outcome: "stored" });
    expect(f.counts().reads).toBe(1);
    await bucket.put(f.key, new Uint8Array([1, 1, 2, 3, 255]), {
      httpMetadata: { contentType: "video/mp4" },
      customMetadata: { dancePublicationInput: f.token, dancePublicationReview: f.reviewId },
    });
    expect(await f.storage.recover()).toEqual({ outcome: "unknown" });
    expect(f.counts().reads).toBe(2);
    await bucket.delete(f.key);
  });
  test("foreign objects cannot be adopted or overwritten by cleanup", async () => {
    const f = await fixture();
    const foreign = await bucket.put(f.key, f.bytes, {
      httpMetadata: { contentType: "video/mp4" },
    });
    expect(await f.storage.store(f.plan, f.bytes)).toEqual({ outcome: "unknown" });
    await f.cleanup.run();
    expect(f.results).toEqual([{ outcome: "unknown" }]);
    expect((await bucket.head(f.key))?.version).toBe(foreign.version);
    expect(f.observations).toHaveLength(0);
    await bucket.delete(f.key);
  });
  test("cancellation fences secured bytes and prevents an already-issued late upload", async () => {
    const f = await fixture();
    await f.storage.store(f.plan, f.bytes);
    await f.cleanup.run();
    expect(f.results[0]).toMatchObject({ outcome: "fenced", key: f.key, fenceToken: f.fenceToken });
    expect(await f.storage.recover()).toEqual({ outcome: "closed" });
    expect(await bucket.put(f.key, f.bytes, { onlyIf: { etagDoesNotMatch: "*" } })).toBeNull();
    expect((await bucket.head(f.key))?.customMetadata?.dancePublicationErasureFence).toBe(
      f.fenceToken,
    );
    await bucket.delete(f.key);
  });
  test("an original writer winning the absent-key race is fenced after known CAS refusal", async () => {
    const f = await fixture();
    f.raceWriter();
    await f.cleanup.run();
    expect(f.counts().puts).toBe(2);
    expect(f.results[0]).toMatchObject({ outcome: "fenced" });
    await bucket.delete(f.key);
  });
  test("lost cleanup PUT only observes the original fence on recovery", async () => {
    const f = await fixture();
    f.losePut();
    await f.cleanup.run();
    expect(f.results).toEqual([{ outcome: "unknown" }]);
    await f.cleanup.run();
    expect(f.results[1]).toMatchObject({ outcome: "fenced" });
    expect(f.counts().puts).toBe(1);
    await bucket.delete(f.key);
  });
  test("lost cleanup grant COMMIT leaves no physical effect and recovery cannot write", async () => {
    const f = await fixture();
    f.loseCleanupCommit();
    await expect(f.cleanup.run()).rejects.toThrow("COMMIT unknown");
    await f.cleanup.run();
    expect(f.counts().puts).toBe(0);
    expect(f.results).toEqual([{ outcome: "unknown" }]);
  });
  test("an adopted Post is never read, fenced or changed by private cleanup", async () => {
    const f = await fixture();
    await f.storage.store(f.plan, f.bytes);
    const before = f.counts();
    f.adopt();
    await f.cleanup.run();
    expect(await f.storage.recover()).toEqual({ outcome: "adopted" });
    expect(f.counts()).toEqual(before);
    await bucket.delete(f.key);
  });
});
