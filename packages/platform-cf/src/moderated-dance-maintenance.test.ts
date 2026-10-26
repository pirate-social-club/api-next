import { describe, expect, test } from "bun:test";
import { makeModeratedDanceMaintenance } from "./moderated-dance-maintenance.ts";
import { makeDirectPostgresControlPlaneLayer, type PostgresClientLike } from "./postgres.ts";

type Input = Parameters<typeof makeModeratedDanceMaintenance>[0];
type Bucket = Input["ingress"];
type Head = NonNullable<Awaited<ReturnType<Bucket["head"]>>>;
const upload = "11111111-1111-4111-8111-111111111111";
const ingressKey = `moderated-dance/ingress/${upload}/source`;
const token = "original-cleanup-authorization";
const unobserved = (key: string) => ({ key, version: null, etag: null, size: null });

function fixture(kind: "ingress" | "original" | "derived" = "ingress") {
  const objects = new Map<string, Head>();
  const heads: string[] = [],
    puts: string[] = [],
    outcomes: unknown[] = [],
    queries: string[] = [];
  let revision = 0,
    consumed = false,
    pendingClaim = false;
  let loseClaimCommit = false,
    losePutAcknowledgement = false,
    raceWriter = false;
  const identity =
    kind === "derived"
      ? {
          frames: [0, 1, 2].map((i) => ({
            identity: unobserved(`moderated-dance/derived/${upload}/frame-${i}.jpg`),
          })),
        }
      : unobserved(kind === "ingress" ? ingressKey : `moderated-dance/originals/${upload}/source`);
  const bucket: Bucket = {
    head: async (key) => {
      heads.push(key);
      return objects.get(key) ?? null;
    },
    put: async (key, value, options) => {
      puts.push(key);
      if (raceWriter) {
        raceWriter = false;
        objects.set(key, { version: "late-v1", etag: "late-etag", size: 100 });
      }
      const current = objects.get(key);
      if (
        "etagDoesNotMatch" in options.onlyIf
          ? current !== undefined
          : current?.etag !== options.onlyIf.etagMatches
      )
        return null;
      const head = {
        version: `v${++revision}`,
        etag: `etag${revision}`,
        size: value.length,
        customMetadata: options.customMetadata,
      };
      objects.set(key, head);
      if (losePutAcknowledgement) {
        losePutAcknowledgement = false;
        throw new Error("offline PUT response lost after storage committed");
      }
      return head;
    },
  };
  const driver: PostgresClientLike = {
    connect: async () => {},
    end: async () => {},
    query: async (q) => {
      queries.push(q.text);
      if (q.text === "COMMIT" && pendingClaim) {
        pendingClaim = false;
        if (loseClaimCommit) {
          loseClaimCommit = false;
          throw new Error("offline claim COMMIT response lost");
        }
      }
      let packet: unknown = null;
      if (q.text.includes("claim_moderated_dance_owned_cleanup_v1")) {
        packet = {
          uploadId: upload,
          kind,
          identity,
          token,
          delivery: consumed ? "recovery_only" : "fresh_grant",
        };
        consumed = true;
        pendingClaim = true;
      } else if (q.text.includes("finish_moderated_dance_owned_cleanup_v1")) {
        expect(q.values?.[2]).toBe(token);
        outcomes.push(JSON.parse(String(q.values?.[3])));
      }
      if (
        q.text.startsWith("SELECT ") &&
        !/set_config\(|next_moderated_dance_review_task_v1|claim_moderated_dance_owned_cleanup_v1|finish_moderated_dance_owned_cleanup_v1|claim_moderated_dance_provider_cleanup_v1|claim_moderated_dance_publication_cleanup_v1|drain_moderated_dance_replay_v1|drain_moderated_dance_compatible_replay_v1|record_moderated_dance_maintenance_v1|drain_moderated_dance_publication_intents_v1/u.test(
          q.text,
        )
      )
        throw new Error(`unexpected offline query ${q.text}`);
      return q.text.startsWith("SELECT ")
        ? { rows: [{ packet }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    },
  };
  const runtime = makeDirectPostgresControlPlaneLayer("postgres://offline.invalid/unused", {
    clientFactory: () => driver,
    logger: { info: () => {}, error: () => {} },
  });
  return {
    processor: makeModeratedDanceMaintenance({
      runtime,
      ingress: bucket,
      originals: bucket,
      randomId: () => token,
    }),
    objects,
    heads,
    puts,
    outcomes,
    queries,
    bucket,
    identity,
    loseClaimCommit: () => {
      loseClaimCommit = true;
    },
    losePutAcknowledgement: () => {
      losePutAcknowledgement = true;
    },
    raceWriter: () => {
      raceWriter = true;
    },
  };
}

function normalizedDerivedFixture() {
  const f = fixture("derived");
  const frames = [0, 1, 2].map((index) => {
    const identity = {
      key: `moderated-dance/derived/${upload}/frame-${index}.jpg`,
      version: `source-v${index}`,
      etag: `source-etag-${index}`,
      size: 100 + index,
    };
    f.objects.set(identity.key, identity);
    return { index, sha256: "a".repeat(64), timestampMs: index * 1000, identity };
  });
  Object.assign(f.identity, { frames });
  return { ...f, frames };
}

describe("actual private maintenance with an offline driver and conditional object store", () => {
  test("fences an absent key and refuses an already-issued late conditional upload", async () => {
    const f = fixture();
    await f.processor.run();
    expect(f.outcomes).toEqual([expect.objectContaining({ outcome: "owned_payload_fenced" })]);
    const head = f.objects.get(ingressKey);
    expect(head?.customMetadata?.privateDanceErasureFence).toBe(token);
    expect(
      await f.bucket.put(ingressKey, "late source bytes", {
        onlyIf: { etagDoesNotMatch: "*" },
        customMetadata: {},
        httpMetadata: { contentType: "video/mp4" },
      }),
    ).toBeNull();
    expect(f.objects.get(ingressKey)).toEqual(head);
  });
  test("a writer winning the first CAS is fenced using its newly observed identity", async () => {
    const f = fixture();
    f.raceWriter();
    await f.processor.run();
    expect(f.puts).toHaveLength(2);
    expect(f.outcomes).toEqual([expect.objectContaining({ outcome: "owned_payload_fenced" })]);
  });
  test("a lost PUT acknowledgement retains uncertainty; recovery observes the same fence without another write", async () => {
    const f = fixture();
    f.losePutAcknowledgement();
    await f.processor.run();
    expect(f.outcomes[0]).toMatchObject({ outcome: "unknown" });
    await f.processor.run();
    expect(f.outcomes[1]).toMatchObject({ outcome: "owned_payload_fenced" });
    expect(f.puts).toHaveLength(1);
  });
  test("lost claim COMMIT never dispatches or regains fresh authorization on recovery", async () => {
    const f = fixture();
    f.loseClaimCommit();
    await expect(f.processor.run()).rejects.toMatchObject({
      _tag: "ControlPlaneTransactionOutcomeUnknown",
      phase: "commit",
    });
    expect(f.puts).toHaveLength(0);
    await f.processor.run();
    expect(f.puts).toHaveLength(0);
    expect(f.outcomes).toEqual([expect.objectContaining({ outcome: "unknown" })]);
  });
  test("preregistered unobserved original and all three derived keys are independently fenced", async () => {
    for (const kind of ["original", "derived"] as const) {
      const f = fixture(kind);
      await f.processor.run();
      expect(f.puts).toHaveLength(kind === "derived" ? 3 : 1);
      expect(f.outcomes).toEqual([expect.objectContaining({ outcome: "owned_payload_fenced" })]);
    }
  });
  test("fences all three persisted normalized frames with the producer's complete metadata", async () => {
    const f = normalizedDerivedFixture();
    await f.processor.run();
    expect(f.puts).toEqual(f.frames.map((frame) => frame.identity.key));
    expect(f.outcomes).toEqual([expect.objectContaining({ outcome: "owned_payload_fenced" })]);
    for (const frame of f.frames)
      expect(f.objects.get(frame.identity.key)?.customMetadata?.privateDanceErasureFence).toBe(
        token,
      );
    expect(f.queries).toContain("SELECT record_moderated_dance_maintenance_v1() AS packet");
  });
  test("normalized frames never regain a write grant after a lost cleanup claim COMMIT", async () => {
    const f = normalizedDerivedFixture();
    f.loseClaimCommit();
    await expect(f.processor.run()).rejects.toMatchObject({
      _tag: "ControlPlaneTransactionOutcomeUnknown",
      phase: "commit",
    });
    expect(f.heads).toHaveLength(0);
    expect(f.puts).toHaveLength(0);
    await f.processor.run();
    expect(f.heads).toHaveLength(3);
    expect(f.puts).toHaveLength(0);
    expect(f.outcomes).toEqual([expect.objectContaining({ outcome: "unknown" })]);
  });
  test("fences a mixed set of normalized proofs and preregistered frame identities", async () => {
    const f = normalizedDerivedFixture();
    Object.assign(f.identity, {
      frames: f.frames.map((frame) =>
        frame.index === 1 ? { identity: unobserved(frame.identity.key) } : frame,
      ),
    });
    await f.processor.run();
    expect(f.puts).toHaveLength(3);
    expect(f.outcomes).toEqual([expect.objectContaining({ outcome: "owned_payload_fenced" })]);
  });
  test.each([
    { index: "0" },
    { sha256: "invalid" },
    { timestampMs: -1 },
    { unexpected: "refused" },
  ])("refuses malformed or undeclared normalized metadata before storage: %j", async (change) => {
    const f = normalizedDerivedFixture(),
      first = f.frames[0];
    if (!first) throw new Error("normalized fixture frame missing");
    Object.assign(first, change);
    await expect(f.processor.run()).rejects.toMatchObject({ name: "SchemaError" });
    expect(f.heads).toHaveLength(0);
    expect(f.puts).toHaveLength(0);
    expect(f.outcomes).toHaveLength(0);
  });
  test("scope substitution cannot write or claim completion", async () => {
    const f = fixture();
    Object.assign(f.identity, unobserved("public-posts/not-private"));
    await f.processor.run();
    expect(f.puts).toHaveLength(0);
    expect(f.outcomes[0]).toMatchObject({
      outcome: "unknown",
      observations: [{ outcome: "scope_refused" }],
    });
  });
});
