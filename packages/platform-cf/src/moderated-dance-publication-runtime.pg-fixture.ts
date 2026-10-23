import { expect } from "bun:test";
import { Schema } from "effect";
import type { Client } from "pg";
import type { ModeratorReview } from "../../domain/src/dance/moderator-review.ts";
import type { seedModeratedDanceIntake } from "./moderated-dance-intake.pg-fixture.ts";
import { makeModeratedDancePublicationRuntime } from "./moderated-dance-publication-runtime.ts";
import { sha256Hex } from "./r2-upload-signing.ts";
import { videoSourceCapabilityDigest } from "./video-source-capability.ts";

/** Real SQL/retained transactions, with explicit provider/body/storage stand-ins.
 * Body transformation and real local R2 are independently covered elsewhere. */
export async function publicationRuntimeFixture(
  f: Awaited<ReturnType<typeof seedModeratedDanceIntake>>,
  admin: Client,
  r: ModeratorReview,
) {
  const bytes = new TextEncoder().encode("synthetic independent Post input"),
    sha256 = await sha256Hex(bytes),
    key = `immutable/dance-post-operation:${r.capture.reviewId}/video/1`,
    objects = new Map<string, R2Object>();
  let creates = 0,
    shows = 0,
    finds = 0,
    puts = 0,
    reads = 0,
    exists = false,
    loseCreate = false,
    losePut = false;
  const bucket: Parameters<typeof makeModeratedDancePublicationRuntime>[0]["bucket"] = {
    head: async (k) => objects.get(k) ?? null,
    get: async () => null,
    put: async (k, value, options) => {
      if (!(value instanceof Uint8Array)) throw new Error("Expected bounded input bytes");
      expect(k).toBe(key);
      expect(options?.sha256).toBe(sha256);
      const condition = options?.onlyIf;
      if (condition instanceof Headers || condition?.etagDoesNotMatch !== "*")
        throw new Error("Conditional ownership required");
      puts++;
      if (objects.has(k)) return null;
      const digest = await crypto.subtle.digest("SHA-256", value);
      const object: R2Object = {
        key: k,
        version: "independent-v1",
        etag: "independent-etag",
        httpEtag: '"independent-etag"',
        uploaded: new Date(),
        size: value.length,
        storageClass: "Standard",
        httpMetadata: { contentType: "video/mp4" },
        customMetadata: { ...options?.customMetadata },
        checksums: { sha256: digest, toJSON: () => ({ sha256 }) },
        writeHttpMetadata: () => {},
      };
      objects.set(k, object);
      if (losePut) {
        losePut = false;
        throw new Error("Storage committed; reply lost");
      }
      return object;
    },
  };
  const original = async () => {
    const job = (
      await admin.query(
        "SELECT provider_tag FROM dance_moderated_publication_jobs_v1 WHERE review_id=$1",
        [r.capture.reviewId],
      )
    ).rows[0];
    return {
      id: "original-provider-job",
      tag: String(job?.provider_tag),
      status: "finished" as const,
    };
  };
  const runtime = makeModeratedDancePublicationRuntime({
    runtime: f.runtime,
    bucket,
    gatewayOrigin: "https://gateway.example",
    runtimeRevision: f.facts.profile.mediaRuntimeRevision,
    videoTrackEnabled: true,
    provider: {
      create: async (request) => {
        creates++;
        exists = true;
        expect(request.tag).toBe((await original()).tag);
        const source = Schema.decodeUnknownSync(
            Schema.Struct({ "import-recording": Schema.Struct({ url: Schema.String }) }),
          )(request.tasks),
          url = new URL(source["import-recording"].url);
        expect(url.origin).toBe("https://gateway.example");
        const cap = url.pathname.split("/").at(-1);
        if (cap === undefined) throw new Error("Original source capability missing");
        const grants = (
          await admin.query("SELECT * FROM resolve_moderated_dance_publication_source_v1($1)", [
            await videoSourceCapabilityDigest(cap),
          ])
        ).rows;
        expect(grants).toHaveLength(1);
        expect(grants[0]?.canonical_sha256).toBe(r.capture.sourceDigest);
        const effect = (
          await admin.query(
            "SELECT provider_tag,work_deadline FROM dance_moderated_provider_effects_v1 WHERE purpose='publication'",
          )
        ).rows[0];
        expect(effect?.provider_tag).toBe(request.tag);
        expect(effect?.work_deadline.getTime()).toBe(r.transferDeadlineMs);
        if (loseCreate) {
          loseCreate = false;
          throw new Error("Provider accepted; reply lost");
        }
        return original();
      },
      findByTag: async (tag) => {
        finds++;
        if (!exists) return null;
        const job = await original();
        expect(tag).toBe(job.tag);
        return job;
      },
      showPrivatePublication: async (id) => {
        shows++;
        expect(id).toBe("original-provider-job");
        return {
          ...(await original()),
          exportUrl: "https://storage.cloudconvert.com/private/body.mp4",
          metadata: { fixture: true },
        };
      },
    },
    readBody: async () => {
      reads++;
      return {
        bytes,
        plan: {
          key,
          sha256,
          size: bytes.length,
          sourceSha256: r.capture.sourceDigest,
          bodyStartMs: r.capture.bodyStartMs,
          bodyEndMs: r.capture.bodyEndMs,
          durationMs: r.capture.bodyEndMs - r.capture.bodyStartMs,
          transformRevision: "dance-publication-body-v1" as const,
        },
      };
    },
  });
  return {
    runtime,
    objects,
    key,
    counts: () => ({ creates, shows, finds, puts, reads }),
    loseCreate: () => {
      loseCreate = true;
    },
    losePut: () => {
      losePut = true;
    },
  };
}
