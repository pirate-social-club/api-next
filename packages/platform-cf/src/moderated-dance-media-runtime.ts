import { Effect, type Layer, Schema } from "effect";
import type { ImageModerationProviderServiceV1 } from "../../application/src/media/processing-contracts.ts";
import type { MediaUploadSealer } from "../../application/src/media/submission-sealing.ts";
import type {
  MediaTransformVideoJobs,
  MediaTransformVideoProbeInput,
  MediaTransformVideoProbeOutcome,
} from "../../application/src/media/transform.ts";
import type { ControlPlaneDb, ControlPlaneError } from "../../application/src/ports.ts";
import { canonicalBodyHash } from "../../application/src/use-cases/content/common.ts";
import {
  ModeratedDanceDisposition,
  ModeratedDanceIntakeProfile,
  ModeratedDanceSafetyPolicySnapshot,
} from "../../application/src/use-cases/dance/moderated-intake.ts";
import { initializeModeratorReview } from "../../domain/src/dance/moderator-review.ts";
import {
  ModeratorReviewFactsSchema,
  SealedModeratorCaptureSchema,
} from "../../domain/src/dance/moderator-review-schema.ts";
import type { VideoExtractedFrame } from "../../domain/src/video-submission.ts";
import { withRetainedControlPlaneCommandTransaction } from "./control-plane-command-transaction.ts";
import { makeR2MediaSealer } from "./media-sealing-adapter.ts";
import type { ModeratedDanceProbeJobs } from "./moderated-dance-cloudconvert-probe.ts";
import {
  decodeModeratedDanceFramehash,
  makeModeratedDanceNormalizationJob,
  moderatedDanceReplayDigests,
  moderatedDanceSafetySampleOffsets,
  readModeratedDanceExport,
} from "./moderated-dance-normalization.ts";
import { bindModeratedDanceReplayKeys } from "./moderated-dance-public-replay.ts";
import { makeModeratedDanceSafetyProtocol } from "./moderated-dance-safety-contract.ts";
import { sha256Hex } from "./r2-upload-signing.ts";
import type { makeSongVideoCloudConvertTransport } from "./song-video-cloudconvert-transport.ts";
import {
  makeVideoSafetyProvider,
  type VideoSafetyEvidenceStore,
  type VideoSafetyFrameClaim,
  validateVideoSafetyFrameProviderFailure,
  validateVideoSafetyFrameProviderResult,
} from "./video-safety-provider.ts";
import { videoSourceCapabilityDigest } from "./video-source-capability.ts";
import { makeVideoSourceUrl } from "./video-source-gateway.ts";

const Id = Schema.NonEmptyString,
  Natural = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8.64e15 }));
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Sealed = Schema.Struct({
  outcome: Schema.Literal("sealed"),
  immutable_ref: Id,
  destination_ref: Id,
  etag: Id,
  version: Id,
  size_bytes: Natural,
  canonical_sha256: Hash,
  firstStoredAtMs: Natural,
  ingress_identity: Schema.Struct({ key: Id, version: Id, etag: Id, size: Natural }),
});
const Work = Schema.Struct({
  action: Schema.Literals(["seal", "dispatch", "observe"]),
  uploadId: Id,
  token: Id,
  sessionId: Id,
  reviewId: Id,
  accountId: Id,
  communityId: Id,
  accountFence: Natural,
  terms: Schema.Struct({
    version: Schema.Literal("dance-moderated-capture-terms-v1"),
    session_id: Id,
    created_at_ms: Natural,
    policy_id: Id,
    profile: ModeratedDanceIntakeProfile,
    capture: Schema.Record(Schema.String, Schema.Unknown),
    terms_hash: Hash,
    safety_policy: ModeratedDanceSafetyPolicySnapshot,
    disposition: ModeratedDanceDisposition,
  }),
  ingressKey: Id,
  contentType: Schema.Literals(["video/mp4", "video/quicktime"]),
  sizeBytes: Natural,
  consentReceiptId: Id,
  consentRecordedAtMs: Natural,
  reservedAtMs: Natural,
  source: Schema.NullOr(Sealed),
  providerTag: Schema.NullOr(Id),
  providerJobId: Schema.NullOr(Id),
  workToken: Schema.NullOr(Id),
  providerDeadlineMs: Schema.NullOr(Natural),
});
type Work = typeof Work.Type;
const Body = Schema.Struct({ bodyStartMs: Natural, bodyEndMs: Natural });
const Frame = Schema.Struct({
  index: Schema.Int,
  sha256: Hash,
  timestampMs: Natural,
  identity: Schema.Struct({ key: Id, version: Id, etag: Id, size: Natural }),
});
type Frame = typeof Frame.Type;
const Attempt = Schema.Struct({
  version: Schema.Literal("media-transform-attempt-v1"),
  runtimeFence: Schema.Struct({ submittedAtMs: Natural, runtimeDeadlineMs: Natural }),
  providerJobId: Schema.optional(Id),
  providerJobPhase: Schema.optional(Schema.Literals(["allocated", "submitting", "started"])),
});
const ProbeGrant = Schema.Struct({
  fresh: Schema.Boolean,
  phase: Schema.Literals([
    "allocating",
    "allocated",
    "submitting",
    "started",
    "complete",
    "unknown",
  ]),
  attempt: Attempt,
  probe: Schema.Unknown,
});
const PrivateSafetyFact = Schema.Struct({
  requestId: Id,
  evidenceRef: Id,
  minorSafetyEvidenceRef: Schema.Null,
  mediaSafety: Schema.Literals(["allow", "review_required", "blocked"]),
  captionSafety: Schema.Literals(["not_applicable", "allow", "review_required", "blocked"]),
  automatedRating: Schema.Literals(["general", "adult_18"]),
  policyRevision: Id,
  adapterRevision: Id,
});
const FrameClaim = Schema.Union([
  Schema.Struct({ status: Schema.Literal("dispatch"), claimToken: Id }),
  Schema.Struct({ status: Schema.Literal("succeeded"), result: Schema.Unknown }),
  Schema.Struct({ status: Schema.Literal("failed"), failure: Schema.Unknown }),
  Schema.Struct({ status: Schema.Literal("unresolved") }),
  Schema.Struct({ status: Schema.Literal("absent") }),
]);
const parse = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);

/** All external I/O happens AFTER its retained transaction commits. Every
 * subsequent database failure escapes; it cannot become another provider call
 * or a compensating rewrite of an uncertain COMMIT. Tests supply offline ports;
 * production uses the existing R2/CloudConvert/OpenAI adapters unchanged. */
export function makeModeratedDanceMediaRuntime(
  input: Readonly<{
    runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError>;
    ingress: Pick<R2Bucket, "head" | "get">;
    originals: Pick<R2Bucket, "head" | "get" | "put">;
    sealer?: MediaUploadSealer;
    transform: ReturnType<typeof makeSongVideoCloudConvertTransport>;
    image: ImageModerationProviderServiceV1;
    probeForSource: (
      issue: (input: {
        objectKey: string;
        sha256: string;
        byteLength: number;
        mediaType: "video/mp4" | "video/quicktime";
        expiresAtMs: number;
        requestId: string;
      }) => Promise<{ url: string; expiresAtMs: number }>,
      source: typeof Sealed.Type,
      profile: ModeratedDanceIntakeProfile,
    ) => ModeratedDanceProbeJobs;
    replayKeys: ReadonlyMap<string, Uint8Array>;
    gatewayOrigin: string;
    runtimeRevision: string;
    safetyRevision: string;
    send?: (url: string, init: RequestInit) => Promise<Response>;
    now?: () => number;
    randomId?: () => string;
  }>,
) {
  const now = input.now ?? Date.now,
    id = input.randomId ?? (() => crypto.randomUUID()),
    sealer =
      input.sealer ??
      makeR2MediaSealer({ ingress: input.ingress, immutableOriginals: input.originals });
  const call = (label: string, text: string, values: readonly unknown[]) =>
    Effect.runPromise(
      withRetainedControlPlaneCommandTransaction((tx) =>
        Effect.gen(function* () {
          const result = yield* tx.execute<{ packet: unknown }>({
            label,
            text,
            values,
            readonly: false,
          });
          if (
            result.rows.length !== 1 ||
            result.rows[0] === undefined ||
            !Object.hasOwn(result.rows[0], "packet")
          )
            throw new Error("Private media persistence outcome unknown");
          return result.rows[0].packet;
        }),
      ).pipe(Effect.provide(input.runtime)),
    );
  const invokeVoid = (label: string, text: string, values: readonly unknown[]) =>
    call(label, `${text} AS packet`, values);
  async function unknown(work: Work, cause: unknown) {
    try {
      await invokeVoid(
        "dance.media.unknown",
        "SELECT mark_moderated_dance_media_unknown_v1($1,$2,$3)",
        [work.uploadId, work.token, work.action],
      );
    } catch (persistence) {
      throw new AggregateError(
        [cause, persistence],
        "Private media dispatch and persistence unresolved",
      );
    }
    return { outcome: "unknown" as const };
  }
  async function seal(work: Work) {
    let proof: typeof Sealed.Type;
    try {
      const original = await input.ingress.head(work.ingressKey);
      if (
        original === null ||
        original.uploaded.getTime() < Math.max(work.reservedAtMs, work.consentRecordedAtMs)
      )
        throw new Error("Private source lacks exact consent-bound storage proof");
      const inspected = await sealer.inspect({
        sourceKey: work.ingressKey,
        expectedSizeBytes: work.sizeBytes,
        expectedContentType: work.contentType,
      });
      if (
        inspected.outcome !== "ready" ||
        inspected.source.version !== original.version ||
        inspected.source.etag !== original.etag
      )
        throw new Error("Private source changed");
      const sealed = await sealer.seal({
        source: inspected.source,
        destinationKey: `moderated-dance/originals/${work.uploadId}/source`,
        immutableRef: `private-dance://${work.uploadId}/source`,
        expectedSizeBytes: work.sizeBytes,
        expectedContentType: work.contentType,
        ownershipMarker: work.token,
      });
      const destination = `moderated-dance/originals/${work.uploadId}/source`;
      if (
        sealed.result.outcome !== "sealed" ||
        sealed.result.destination_ref !== `r2://${destination}` ||
        sealed.result.immutable_ref !== `private-dance://${work.uploadId}/source` ||
        sealed.result.size_bytes !== work.sizeBytes
      )
        throw new Error("Private source seal unavailable");
      // The accepted sealer returns an R2 URI. Only its exact original target
      // maps to the private physical locator; this is not a client-selected key.
      proof = parse(Sealed, {
        ...sealed.result,
        destination_ref: destination,
        firstStoredAtMs: original.uploaded.getTime(),
        ingress_identity: {
          key: original.key,
          version: original.version,
          etag: original.etag,
          size: original.size,
        },
      });
    } catch (cause) {
      return unknown(work, cause);
    }
    // A lost database acknowledgement never retries the object write.
    await invokeVoid(
      "dance.media.seal.commit",
      "SELECT persist_moderated_dance_seal_v1($1,$2,$3::jsonb)",
      [work.uploadId, work.token, JSON.stringify(proof)],
    );
    return { outcome: "sealed" as const };
  }
  async function sourceUrl(work: Work, expiresAtMs = work.providerDeadlineMs ?? 0) {
    const bytes = crypto.getRandomValues(new Uint8Array(32)),
      capability = btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
    await call(
      "dance.media.source.issue",
      "SELECT issue_moderated_dance_source_v1($1,$2,$3,$4) AS packet",
      [work.uploadId, work.token, await videoSourceCapabilityDigest(capability), expiresAtMs],
    );
    return makeVideoSourceUrl(input.gatewayOrigin, capability);
  }
  async function frameArtifact(
    work: Work,
    index: number,
    url: string,
    signal: AbortSignal,
    timestampMs: number,
  ): Promise<Frame> {
    const bytes = await readModeratedDanceExport(
      url,
      work.terms.profile.maximumFrameBytes,
      signal,
      input.send ?? fetch,
    );
    if (
      bytes.length < 4 ||
      bytes[0] !== 0xff ||
      bytes[1] !== 0xd8 ||
      bytes.at(-2) !== 0xff ||
      bytes.at(-1) !== 0xd9
    )
      throw new Error("Private frame is not JPEG");
    const sha256 = await sha256Hex(bytes),
      key = `moderated-dance/derived/${work.uploadId}/frame-${index}.jpg`;
    // A conditional exact-object retry is safe storage reconciliation; it never
    // reissues a transform/safety purpose authorization.
    await input.originals.put(key, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256,
      httpMetadata: { contentType: "image/jpeg" },
      customMetadata: {
        sha256,
        source: work.source?.canonical_sha256 ?? "",
        upload: work.uploadId,
      },
    });
    const head = await input.originals.head(key);
    if (
      head === null ||
      head.size !== bytes.length ||
      head.customMetadata?.sha256 !== sha256 ||
      head.customMetadata?.upload !== work.uploadId ||
      head.customMetadata?.source !== work.source?.canonical_sha256
    )
      throw new Error("Private frame identity conflict");
    return {
      index,
      sha256,
      timestampMs,
      identity: { key, version: head.version, etag: head.etag, size: head.size },
    };
  }
  function safetyStore(work: Work): VideoSafetyEvidenceStore {
    const protocol = makeModeratedDanceSafetyProtocol({
      call,
      uploadId: work.uploadId,
      token: work.token,
    });
    const interpretClaim = (
      raw: unknown,
      sha: string,
    ): VideoSafetyFrameClaim | { status: "absent" } => {
      const claim = parse(FrameClaim, raw);
      if (claim.status === "succeeded")
        return {
          status: "succeeded",
          result: validateVideoSafetyFrameProviderResult(claim.result, sha),
        };
      if (claim.status === "failed")
        return {
          status: "failed",
          failure: validateVideoSafetyFrameProviderFailure(claim.failure),
        };
      return claim;
    };
    return {
      load: async (_i, inputDigest) => {
        const e = await protocol.evidence("load", { inputDigest });
        return e === null
          ? null
          : Schema.decodeUnknownSync(Schema.Struct({ fact: PrivateSafetyFact }), {
              onExcessProperty: "ignore",
            })(e).fact;
      },
      save: async (_i, evidence) => {
        const saved = await protocol.evidence("save", {
          inputDigest: evidence.inputDigest,
          policyHash: Schema.decodeUnknownSync(Schema.Struct({ safetyHash: Hash }), {
            onExcessProperty: "ignore",
          })(work.terms.capture.policy).safetyHash,
          evidence,
        });
        return Schema.decodeUnknownSync(Schema.Struct({ fact: PrivateSafetyFact }), {
          onExcessProperty: "ignore",
        })(saved).fact;
      },
      inspectFrame: async (frame) => {
        const claim = interpretClaim(await protocol.frame("inspect", frame), frame.frameSha256);
        if (claim.status === "dispatch") throw new Error("Read cannot issue a safety grant");
        return claim;
      },
      claimFrame: async (frame) => {
        const claim = interpretClaim(
          await protocol.frame("claim", frame, {
            claimToken: id(),
          }),
          frame.frameSha256,
        );
        if (claim.status === "absent") throw new Error("Safety claim was not recorded");
        return claim;
      },
      succeedFrame: async (frame, claimToken, result) =>
        validateVideoSafetyFrameProviderResult(
          await protocol.frame("succeed", frame, {
            claimToken,
            result,
          }),
          frame.frameSha256,
        ),
      failFrame: async (frame, claimToken, result) =>
        validateVideoSafetyFrameProviderFailure(
          await protocol.frame("fail", frame, {
            claimToken,
            result,
          }),
        ),
    };
  }
  async function initialize(work: Work) {
    const raw = await call(
      "dance.media.capture.facts",
      "SELECT load_moderated_dance_sealed_capture_v1($1,$2) AS packet",
      [work.uploadId, work.token],
    );
    const f = parse(
        Schema.Struct({
          capture: SealedModeratorCaptureSchema,
          facts: ModeratorReviewFactsSchema,
          nowMs: Natural,
        }),
        raw,
      ),
      state = initializeModeratorReview(f.capture, f.facts, f.nowMs);
    if (state === null) throw new Error("Private review initializer refused current authority");
    await invokeVoid(
      "dance.media.capture.commit",
      "SELECT initialize_moderated_dance_review_v1($1,$2,$3::jsonb)",
      [work.uploadId, work.token, JSON.stringify(state)],
    );
    return { outcome: "uploaded" as const };
  }
  async function analyze(work: Work) {
    if (work.source === null || work.providerTag === null || work.providerDeadlineMs === null)
      throw new Error("Missing owned private media authority");
    const body = Schema.decodeUnknownSync(Body, { onExcessProperty: "ignore" })(work.terms.capture),
      p = work.terms.profile;
    const selectedKeys = new Map<string, Uint8Array>();
    for (const epoch of p.replayCompatibleEpochs) {
      const key = input.replayKeys.get(epoch);
      if (key === undefined || key.length < 32) throw new Error("Captured replay key unavailable");
      selectedKeys.set(epoch, key);
    }
    let providerJobId = work.providerJobId;
    const probeGrant = parse(
      ProbeGrant,
      await call(
        "dance.media.probe.claim",
        "SELECT claim_moderated_dance_probe_v1($1,$2) AS packet",
        [work.uploadId, work.token],
      ),
    );
    if (probeGrant.phase !== "complete") {
      const probe = input.probeForSource(
        async (source) => {
          if (
            source.objectKey !== work.source?.destination_ref ||
            source.sha256 !== work.source.canonical_sha256 ||
            source.byteLength !== work.sizeBytes ||
            source.mediaType !== work.contentType ||
            source.expiresAtMs > (work.providerDeadlineMs ?? 0)
          )
            throw new Error("Private probe source changed");
          return {
            url: await sourceUrl(work, source.expiresAtMs),
            expiresAtMs: source.expiresAtMs,
          };
        },
        work.source,
        p,
      );
      const request: MediaTransformVideoProbeInput = {
        version: "media-transform-video-probe-input-v1",
        binding: {
          operationId: String(work.terms.capture.attemptId),
          videoRevision: 1,
          creationRevision: 1,
          analysisRevision: 1,
          canonicalVideoSha256: work.source.canonical_sha256,
          requestId: `private-probe-${work.uploadId}`,
        },
        source: {
          objectKey: work.source.destination_ref,
          sha256: work.source.canonical_sha256,
          byteLength: work.sizeBytes,
          mediaType: work.contentType,
        },
        attempt: {
          version: probeGrant.attempt.version,
          runtimeFence: probeGrant.attempt.runtimeFence,
          ...(probeGrant.attempt.providerJobId === undefined
            ? {}
            : { providerJobId: probeGrant.attempt.providerJobId }),
          ...(probeGrant.attempt.providerJobPhase === undefined
            ? {}
            : { providerJobPhase: probeGrant.attempt.providerJobPhase }),
        },
      };
      if (
        !probeGrant.fresh &&
        probeGrant.phase !== "started" &&
        probeGrant.phase !== "submitting" &&
        !(
          probeGrant.phase === "unknown" &&
          probeGrant.attempt.providerJobId !== undefined &&
          (probeGrant.attempt.providerJobPhase === "submitting" ||
            probeGrant.attempt.providerJobPhase === "started")
        )
      )
        return unknown(work, new Error("Probe allocation uncertain; no new authorization"));
      let result:
        | MediaTransformVideoProbeOutcome
        | Effect.Success<ReturnType<MediaTransformVideoJobs["allocate"]>>;
      try {
        result = await Effect.runPromise(
          probeGrant.fresh && probeGrant.phase === "allocating"
            ? probe.allocate(request)
            : probeGrant.fresh && probeGrant.phase === "submitting"
              ? probe.submit(request)
              : probe.observe(request),
        );
      } catch (cause) {
        return unknown(work, cause);
      }
      // Recording a known/unknown result cannot retry ALLOCATE or START.
      await invokeVoid(
        "dance.media.probe.commit",
        "SELECT persist_moderated_dance_probe_v1($1,$2,$3::jsonb)",
        [work.uploadId, work.token, JSON.stringify(result)],
      );
      return { outcome: "processing" as const };
    }
    const freshNormalization = parse(
      Schema.Boolean,
      await call(
        "dance.media.normalization.claim",
        "SELECT claim_moderated_dance_normalization_v1($1,$2) AS packet",
        [work.uploadId, work.token],
      ),
    );
    if (freshNormalization) {
      const url = await sourceUrl(work); // DB unknown => no provider invocation.
      let created: Awaited<ReturnType<typeof input.transform.create>>;
      try {
        created = await input.transform.create(
          makeModeratedDanceNormalizationJob({
            tag: work.providerTag,
            sourceUrl: url,
            bodyStartMs: body.bodyStartMs,
            bodyEndMs: body.bodyEndMs,
            profile: p,
          }),
        );
      } catch (cause) {
        return unknown(work, cause);
      }
      await invokeVoid(
        "dance.media.provider.attach",
        "SELECT attach_moderated_dance_provider_v1($1,$2,$3,$4)",
        [work.uploadId, work.token, created.id, created.tag],
      );
      return { outcome: "processing" as const };
    }
    if (providerJobId === null) {
      let found: Awaited<ReturnType<typeof input.transform.findByTag>>;
      try {
        found = await input.transform.findByTag(work.providerTag);
      } catch (cause) {
        return unknown(work, cause);
      }
      if (found === null)
        return unknown(work, new Error("Absent lookup is not non-submission proof"));
      providerJobId = found.id;
      await invokeVoid(
        "dance.media.provider.reconcile",
        "SELECT attach_moderated_dance_provider_v1($1,$2,$3,$4)",
        [work.uploadId, work.token, found.id, found.tag],
      );
      return { outcome: "processing" as const };
    }
    let observation: Awaited<ReturnType<typeof input.transform.showPrivateDance>>;
    try {
      observation = await input.transform.showPrivateDance(providerJobId);
    } catch (cause) {
      return unknown(work, cause);
    }
    if (observation.id !== providerJobId || observation.tag !== work.providerTag)
      return unknown(work, new Error("Private provider provenance changed"));
    if (observation.status !== "finished" || observation.exports === null)
      return {
        outcome: observation.status === "error" ? ("failed" as const) : ("processing" as const),
      };
    const controller = new AbortController(),
      remaining = work.providerDeadlineMs - now();
    if (remaining <= 0) return { outcome: "expired" as const };
    const timer = setTimeout(() => controller.abort(), Math.min(remaining, 2147483647));
    let frames: readonly [Frame, Frame, Frame];
    try {
      const hashes = decodeModeratedDanceFramehash(
        await readModeratedDanceExport(
          observation.exports.identity,
          1024 * 1024,
          controller.signal,
          input.send ?? fetch,
        ),
        p,
        body.bodyEndMs - body.bodyStartMs,
      );
      const digests = await moderatedDanceReplayDigests({
        scope: p.replayScope,
        sourceSha256: work.source.canonical_sha256,
        frames: hashes,
        keys: selectedKeys,
      });
      // Sequential bounded stills avoid multiplying memory and provider work.
      const offsets = moderatedDanceSafetySampleOffsets(body.bodyStartMs, body.bodyEndMs, p);
      const a = await frameArtifact(
          work,
          0,
          observation.exports.frames[0],
          controller.signal,
          offsets[0],
        ),
        b = await frameArtifact(
          work,
          1,
          observation.exports.frames[1],
          controller.signal,
          offsets[1],
        ),
        c = await frameArtifact(
          work,
          2,
          observation.exports.frames[2],
          controller.signal,
          offsets[2],
        );
      frames = [a, b, c];
      // Persistence errors are outside the provider-error catch below; no retry.
      await call(
        "dance.media.normalization.commit",
        "SELECT persist_moderated_dance_normalization_v1($1,$2,$3::jsonb,$4::jsonb) AS packet",
        [work.uploadId, work.token, JSON.stringify(frames), JSON.stringify(digests.claims)],
      );
    } finally {
      clearTimeout(timer);
    }
    const capturedPolicy = Schema.decodeUnknownSync(Schema.Struct({ safetyHash: Hash }), {
      onExcessProperty: "ignore",
    })(work.terms.capture.policy);
    const moderate = makeVideoSafetyProvider({
      image: input.image,
      text: null,
      sampledFrameGate: false,
      evidence: safetyStore(work),
      readPolicy: async (community) => {
        if (community !== work.communityId) throw new Error("Private safety community changed");
        const policy = work.terms.safety_policy;
        if ((await Effect.runPromise(canonicalBodyHash(policy))) !== capturedPolicy.safetyHash)
          throw new Error("Captured private safety policy unavailable");
        return policy;
      },
      readFrame: async (key, digest) => {
        const frame = frames.find((f) => f.identity.key === key && f.sha256 === digest);
        if (frame === undefined) throw new Error("Private frame unavailable");
        const object = await input.originals.get(key, {
          onlyIf: { etagMatches: frame.identity.etag },
        });
        if (
          object === null ||
          !("body" in object) ||
          object.version !== frame.identity.version ||
          object.size !== frame.identity.size
        )
          throw new Error("Private frame changed");
        const bytes = new Uint8Array(await object.arrayBuffer());
        if ((await sha256Hex(bytes)) !== digest) throw new Error("Private frame digest changed");
        return bytes;
      },
    });
    const frameDto = (frame: Frame, role: VideoExtractedFrame["role"]): VideoExtractedFrame => ({
      role,
      artifactRef: frame.identity.key,
      sha256: frame.sha256,
      timestampMs: frame.timestampMs,
      requestedTimestampMs: frame.timestampMs,
    });
    // Reuse the actual safety engine without public submission/gate authority.
    await moderate({
      operationId: String(work.terms.capture.attemptId),
      submissionId: work.reviewId,
      communityId: work.communityId,
      videoRevision: 1,
      creationRevision: 1,
      authorDeclaredRating: "general",
      caption: null,
      captionSha256: null,
      frames: [
        frameDto(frames[0], "poster"),
        frameDto(frames[1], "first"),
        frameDto(frames[2], "midpoint"),
      ],
    });
    return initialize(work);
  }
  const run = async () => {
    await bindModeratedDanceReplayKeys(call, input.replayKeys);
    await invokeVoid(
      "dance.media.readiness",
      "SELECT announce_moderated_dance_processor_v1($1,$2,$3::jsonb)",
      [input.runtimeRevision, input.safetyRevision, JSON.stringify([...input.replayKeys.keys()])],
    );
    const raw = await call(
      "dance.media.claim",
      "SELECT claim_moderated_dance_media_v1($1,$2,$3,$4::jsonb) AS packet",
      [
        id(),
        input.runtimeRevision,
        input.safetyRevision,
        JSON.stringify([...input.replayKeys.keys()]),
      ],
    );
    if (raw === null) return { outcome: "empty" as const };
    const work = parse(Work, raw);
    return work.action === "seal" ? seal(work) : analyze(work);
  };
  return { run };
}
