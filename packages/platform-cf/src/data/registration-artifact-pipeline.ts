import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import type { IpfsGatewayVerifier } from "@pirate/application/data/ipfs-live-verification";
import { pinAndVerifyIpfsArtifact } from "@pirate/application/data/ipfs-live-verification";
import type { IpfsPinningService } from "@pirate/application/data/ipfs-pinning";
import {
  type DataRegistrationArtifact,
  type DataRegistrationOperation,
  type DataRegistrationPinVerification,
  deterministicDataRegistrationArtifactId,
} from "@pirate/application/data/registration-persistence";
import type {
  DataRegistrationArtifactPipeline,
  DataRegistrationPreparedArtifact,
} from "@pirate/application/data/registration-workflow";
import { canonicalJson } from "@pirate/domain";
import { Effect, type Layer, Predicate } from "effect";

const IMMUTABLE_REF_PREFIX = "media://immutable/";
const SHA256 = /^[0-9a-f]{64}$/u;
const ADDRESS = /^0x[0-9a-f]{40}$/u;

type Row = Readonly<Record<string, unknown>>;

export type DataRegistrationRoyaltyAllocation = Readonly<{
  recipientId: string;
  address: string;
  shareBps: number;
}>;

type DataRegistrationArtifactAuthorityCommon = Readonly<{
  postId: string;
  projectedAt: string;
  contentRating: "general" | "adult_18";
  royaltyAllocations: readonly DataRegistrationRoyaltyAllocation[];
  acrDecision: string;
  acrPolicyRevision: string;
  creatorAddress: string;
}>;

type DataRegistrationSongArtifactAuthority = DataRegistrationArtifactAuthorityCommon &
  Readonly<{
  title: string;
  audioAssetRef: string;
  audioMediaType: string;
  audioByteLength: bigint;
  canonicalAudioSha256: string;
  coverArtifactRef: string | null;
  lyrics: string | null;
  lyricsExplicitness: "not_applicable" | "not_explicit" | "explicit" | "uncertain";
  primaryLanguageBcp47: string | null;
  commercialRemixShareBps: number;
}>;

export type DataRegistrationArtifactAuthority =
  | (DataRegistrationSongArtifactAuthority &
      Readonly<{
        mediaKind: "song";
        rightsBasis: "original" | "derivative";
        licensePreset: "non-commercial" | "commercial-use" | "commercial-remix";
      }>)
  | (DataRegistrationArtifactAuthorityCommon &
      Readonly<{
        mediaKind: "video";
        rightsBasis: "original";
        licensePreset: null;
        caption: string | null;
        videoAssetRef: string;
        videoMediaType: "video/mp4" | "video/quicktime";
        videoByteLength: bigint;
        canonicalVideoSha256: string;
        posterArtifactRef: string;
        posterSha256: string;
        originalSoundId: string;
      }>);

export interface DataRegistrationArtifactAuthorityReader {
  readonly read: (
    operation: DataRegistrationOperation,
  ) => Promise<DataRegistrationArtifactAuthority>;
  readonly listPins: (
    registrationOperationId: string,
  ) => Promise<readonly DataRegistrationPinVerification[]>;
}

const text = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error("invalid DATA artifact authority");
  }
  return value;
};

const nullableText = (row: Row, key: string): string | null => {
  const value = row[key];
  return value === null || value === undefined ? null : text(row, key);
};

const instant = (row: Row, key: string): string => {
  const value = row[key];
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(milliseconds)) throw new Error("invalid DATA artifact authority");
  return new Date(milliseconds).toISOString();
};

const positiveBigint = (value: unknown): bigint => {
  const parsed = String(value);
  if (!/^[1-9][0-9]*$/u.test(parsed)) throw new Error("invalid DATA artifact authority");
  return BigInt(parsed);
};

const integer = (value: unknown, minimum: number, maximum: number): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("invalid DATA artifact authority");
  }
  return parsed;
};

const parseAllocations = (
  value: unknown,
): readonly Readonly<{
  recipientId: string;
  shareBps: number;
}>[] => {
  if (!Array.isArray(value) || value.length === 0) throw new Error("invalid royalty allocations");
  const allocations = value.map((entry) => {
    if (!Predicate.isObject(entry)) throw new Error("invalid royalty allocations");
    return {
      recipientId: text(entry, "recipientId"),
      shareBps: integer(entry.shareBps, 1, 10_000),
    };
  });
  if (allocations.reduce((total, allocation) => total + allocation.shareBps, 0) !== 10_000) {
    throw new Error("invalid royalty allocations");
  }
  return allocations;
};

const parseVideoAllocations = (
  value: unknown,
): readonly Readonly<{ recipientId: string; shareBps: number }>[] => {
  if (!Array.isArray(value) || value.length !== 1) throw new Error("invalid royalty allocations");
  const entry = value[0];
  if (!Predicate.isObject(entry)) throw new Error("invalid royalty allocations");
  const allocation = {
    recipientId: text(entry, "recipient_id"),
    shareBps: integer(entry.share_bps, 1, 10_000),
  };
  if (allocation.shareBps !== 10_000) throw new Error("invalid royalty allocations");
  return [allocation];
};

const object = (value: unknown): Readonly<Record<string, unknown>> => {
  if (!Predicate.isObject(value)) throw new Error("invalid DATA artifact authority");
  return value;
};

export function makePostgresDataRegistrationArtifactAuthorityReader(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): DataRegistrationArtifactAuthorityReader {
  const run = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>): Promise<A> =>
    Effect.runPromise(Effect.provide(runtime)(effect));
  return {
    read: (operation) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          if (operation.mediaKind === "video") {
            const publication = yield* db.execute<Row>({
              label: "data-registration.artifacts.video-authority",
              text: `SELECT p.post_id,p.projected_at,p.caption,p.video_asset_ref,
                            p.canonical_video_sha256,p.poster_artifact_ref,p.original_sound_id,
                            v.content_type,v.size_bytes,poster.canonical_sha256 AS poster_sha256,
                            rights.rights_basis,rights.royalty_allocations,
                            analysis.analysis_snapshot,post.content_rating,
                            wallet.address AS creator_address
                       FROM media_publication_projections p
                       JOIN media_video_revisions v
                         ON v.submission_id=p.submission_id
                        AND v.video_revision=p.video_revision
                       JOIN media_video_derived_artifacts poster
                         ON poster.submission_id=p.submission_id
                        AND poster.video_revision=p.video_revision
                        AND poster.artifact_kind='poster'
                        AND poster.artifact_ref=p.poster_artifact_ref
                       JOIN media_video_rights rights ON rights.submission_id=p.submission_id
                       JOIN media_video_analyses analysis
                         ON analysis.submission_id=p.submission_id
                        AND analysis.analysis_revision=p.analysis_revision
                       JOIN posts post
                         ON post.community_id=p.community_id AND post.post_id=p.post_id
                       JOIN persona_wallet_assignments wallet
                         ON wallet.persona_id=p.author_persona_id
                        AND wallet.chain_account_kind='evm' AND wallet.status='active'
                      WHERE p.community_id=$1 AND p.actor_user_id=$2 AND p.submission_id=$3
                        AND p.operation_id=$4 AND p.post_id=$5 AND p.media_kind='video'`,
              values: [
                operation.communityId,
                operation.actorUserId,
                operation.submissionId,
                operation.mediaOperationId,
                operation.postId,
              ],
              readonly: true,
            });
            if (publication.rows.length !== 1 || publication.rows[0] === undefined) {
              throw new Error("DATA publication authority missing");
            }
            const row = publication.rows[0];
            const creatorAddress = text(row, "creator_address").toLowerCase();
            const videoSha256 = text(row, "canonical_video_sha256");
            const posterSha256 = text(row, "poster_sha256");
            const mediaType = text(row, "content_type");
            const contentRating = text(row, "content_rating");
            const analysis = object(row.analysis_snapshot);
            const audio = object(analysis.audio);
            const soundtrack = object(audio.soundtrack);
            const verification = soundtrack.verification;
            const acrDecision =
              verification === null || verification === undefined
                ? text(soundtrack, "exhaustion")
                : text(object(verification), "status");
            const royaltyAllocations = parseVideoAllocations(row.royalty_allocations).map(
              (allocation) => ({ ...allocation, address: creatorAddress }),
            );
            if (
              operation.rightsBasis !== "original" ||
              text(row, "rights_basis") !== "original" ||
              !ADDRESS.test(creatorAddress) ||
              !SHA256.test(videoSha256) ||
              !SHA256.test(posterSha256) ||
              !["video/mp4", "video/quicktime"].includes(mediaType) ||
              !["general", "adult_18"].includes(contentRating) ||
              text(audio, "intent") !== "original_audio"
            ) {
              throw new Error("invalid DATA artifact authority");
            }
            return {
              postId: text(row, "post_id"),
              projectedAt: instant(row, "projected_at"),
              contentRating: contentRating as "general" | "adult_18",
              mediaKind: "video" as const,
              rightsBasis: "original" as const,
              licensePreset: null,
              caption: nullableText(row, "caption"),
              videoAssetRef: text(row, "video_asset_ref"),
              videoMediaType: mediaType as "video/mp4" | "video/quicktime",
              videoByteLength: positiveBigint(row.size_bytes),
              canonicalVideoSha256: videoSha256,
              posterArtifactRef: text(row, "poster_artifact_ref"),
              posterSha256,
              originalSoundId: text(row, "original_sound_id"),
              royaltyAllocations,
              acrDecision,
              acrPolicyRevision: text(soundtrack, "policyRevision"),
              creatorAddress,
            };
          }
          const publication = yield* db.execute<Row>({
            label: "data-registration.artifacts.authority",
            text: `SELECT p.post_id,p.title,p.projected_at,p.audio_asset_ref,p.canonical_audio_sha256,
                          p.cover_artifact_ref,p.lyrics_text,p.lyrics_explicitness,
                          p.primary_language_bcp47,a.content_type,a.size_bytes,
                          s.song_type,t.license_preset,t.commercial_remix_share_bps,t.royalty_allocations,
                          e.acr_decision,e.acr_policy_revision,w.address AS creator_address,
                          post.content_rating
                     FROM media_publication_projections p
                     JOIN media_post_submissions s
                       ON s.community_id=p.community_id AND s.actor_user_id=p.actor_user_id
                      AND s.submission_id=p.submission_id AND s.operation_id=p.operation_id
                     JOIN media_audio_revisions a
                       ON a.community_id=p.community_id AND a.actor_user_id=p.actor_user_id
                      AND a.submission_id=p.submission_id AND a.operation_id=p.operation_id
                      AND a.audio_revision=p.audio_revision
                     JOIN media_submission_terms t
                       ON t.community_id=p.community_id AND t.actor_user_id=p.actor_user_id
                      AND t.submission_id=p.submission_id AND t.operation_id=p.operation_id
                      AND t.creation_revision=p.creation_revision
                     JOIN media_analysis_evidence e
                       ON e.community_id=p.community_id AND e.actor_user_id=p.actor_user_id
                      AND e.submission_id=p.submission_id AND e.operation_id=p.operation_id
                      AND e.analysis_revision=p.analysis_revision
                     JOIN persona_wallet_assignments w
                       ON w.persona_id=p.author_persona_id AND w.chain_account_kind='evm'
                      AND w.status='active'
                     JOIN posts post
                       ON post.community_id=p.community_id AND post.post_id=p.post_id
                    WHERE p.community_id=$1 AND p.actor_user_id=$2 AND p.submission_id=$3
                      AND p.operation_id=$4 AND p.post_id=$5`,
            values: [
              operation.communityId,
              operation.actorUserId,
              operation.submissionId,
              operation.mediaOperationId,
              operation.postId,
            ],
            readonly: true,
          });
          if (publication.rows.length !== 1 || publication.rows[0] === undefined) {
            throw new Error("DATA publication authority missing");
          }
          const row = publication.rows[0];
          const allocations = parseAllocations(row.royalty_allocations);
          const recipients = yield* db.execute<Row>({
            label: "data-registration.artifacts.recipients",
            text: `SELECT requested.recipient_id,wallet.address
                     FROM unnest($1::text[]) requested(recipient_id)
                     JOIN LATERAL (
                       SELECT candidate.persona_id
                         FROM personas candidate
                        WHERE candidate.persona_id=requested.recipient_id
                           OR (candidate.is_first_persona=true
                               AND candidate.account_id=requested.recipient_id)
                        ORDER BY CASE
                          WHEN candidate.persona_id=requested.recipient_id THEN 0 ELSE 1
                        END
                        LIMIT 1
                     ) persona ON true
                     JOIN persona_wallet_assignments wallet
                       ON wallet.persona_id=persona.persona_id
                      AND wallet.chain_account_kind='evm' AND wallet.status='active'
                    ORDER BY requested.recipient_id`,
            values: [allocations.map(({ recipientId }) => recipientId)],
            readonly: true,
          });
          const addresses = new Map(
            recipients.rows.map((recipient) => [
              text(recipient, "recipient_id"),
              text(recipient, "address").toLowerCase(),
            ]),
          );
          const royaltyAllocations = allocations.map((allocation) => {
            const address = addresses.get(allocation.recipientId);
            if (address === undefined || !ADDRESS.test(address)) {
              throw new Error("DATA royalty recipient wallet missing");
            }
            return { ...allocation, address };
          });
          const creatorAddress = text(row, "creator_address").toLowerCase();
          const audioSha256 = text(row, "canonical_audio_sha256");
          const explicitness = text(row, "lyrics_explicitness");
          const songType = text(row, "song_type");
          const licensePreset = text(row, "license_preset");
          const contentRating = text(row, "content_rating");
          if (
            !ADDRESS.test(creatorAddress) ||
            !SHA256.test(audioSha256) ||
            !["not_applicable", "not_explicit", "explicit", "uncertain"].includes(explicitness) ||
            !["original", "remix"].includes(songType) ||
            !["non-commercial", "commercial-use", "commercial-remix"].includes(licensePreset) ||
            !["general", "adult_18"].includes(contentRating)
          ) {
            throw new Error("invalid DATA artifact authority");
          }
          return {
            postId: text(row, "post_id"),
            title: text(row, "title"),
            projectedAt: instant(row, "projected_at"),
            contentRating: contentRating as "general" | "adult_18",
            audioAssetRef: text(row, "audio_asset_ref"),
            audioMediaType: text(row, "content_type"),
            audioByteLength: positiveBigint(row.size_bytes),
            canonicalAudioSha256: audioSha256,
            coverArtifactRef: nullableText(row, "cover_artifact_ref"),
            lyrics: nullableText(row, "lyrics_text"),
            lyricsExplicitness:
              explicitness as DataRegistrationArtifactAuthority["lyricsExplicitness"],
            primaryLanguageBcp47: nullableText(row, "primary_language_bcp47"),
            mediaKind: "song" as const,
            rightsBasis: songType === "original" ? ("original" as const) : ("derivative" as const),
            licensePreset: licensePreset as
              | "non-commercial"
              | "commercial-use"
              | "commercial-remix",
            commercialRemixShareBps: integer(row.commercial_remix_share_bps, 0, 10_000),
            royaltyAllocations,
            acrDecision: text(row, "acr_decision"),
            acrPolicyRevision: text(row, "acr_policy_revision"),
            creatorAddress,
          };
        }),
      ),
    listPins: (registrationOperationId) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "data-registration.artifacts.pins",
            text: `SELECT pin_verification_id,registration_operation_id,artifact_id,artifact_kind,
                          role,provider_id,attempt_number,outcome,cid,canonical_sha256,
                          byte_length,evidence_ref,verified_at
                     FROM data_registration_pin_verifications
                    WHERE registration_operation_id=$1`,
            values: [registrationOperationId],
            readonly: true,
          });
          return result.rows.map((row) => ({
            pinVerificationId: text(row, "pin_verification_id"),
            registrationOperationId: text(row, "registration_operation_id"),
            artifactId: text(row, "artifact_id"),
            artifactKind: text(
              row,
              "artifact_kind",
            ) as DataRegistrationPinVerification["artifactKind"],
            role: text(row, "role") as DataRegistrationPinVerification["role"],
            providerId: text(row, "provider_id"),
            attemptNumber: integer(row.attempt_number, 1, 10),
            outcome: text(row, "outcome") as DataRegistrationPinVerification["outcome"],
            cid: nullableText(row, "cid"),
            canonicalSha256: nullableText(row, "canonical_sha256"),
            byteLength: row.byte_length === null ? null : positiveBigint(row.byte_length),
            evidenceRef: text(row, "evidence_ref"),
            verifiedAt: row.verified_at === null ? null : instant(row, "verified_at"),
          }));
        }),
      ),
  };
}

const sha256 = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const memoryArtifact = async (
  operation: DataRegistrationOperation,
  kind: "ip_metadata" | "nft_metadata",
  value: unknown,
): Promise<DataRegistrationPreparedArtifact> => {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const hash = await sha256(bytes);
  const artifact: DataRegistrationArtifact = {
    artifactId: deterministicDataRegistrationArtifactId(operation.registrationOperationId, kind),
    registrationOperationId: operation.registrationOperationId,
    artifactKind: kind,
    sourceRef: `data-registration://canonical/${operation.registrationOperationId}/${kind}`,
    mediaType: "application/json",
    byteLength: BigInt(bytes.byteLength),
    canonicalSha256: hash,
    canonicalizationRevision: "rfc8785-jcs-v1",
  };
  return {
    artifact,
    filename: `${kind}.json`,
    contentType: artifact.mediaType,
    open: async function* () {
      yield new Uint8Array(bytes);
    },
  };
};

function objectKey(reference: string): string {
  const prefix = reference.startsWith(IMMUTABLE_REF_PREFIX)
    ? IMMUTABLE_REF_PREFIX
    : reference.startsWith("media://derived/")
      ? "media://derived/"
      : null;
  if (prefix === null) throw new Error("invalid media artifact reference");
  const suffix = reference.slice(prefix.length);
  if (
    suffix.length === 0 ||
    suffix.length > 768 ||
    suffix.startsWith("/") ||
    suffix.includes("\\") ||
    suffix.split("/").includes("..")
  ) {
    throw new Error("invalid media artifact reference");
  }
  return `${prefix === IMMUTABLE_REF_PREFIX ? "immutable" : "derived"}/${suffix}`;
}

const audioArtifact = (
  operation: DataRegistrationOperation,
  authority: Extract<DataRegistrationArtifactAuthority, { mediaKind: "song" }>,
  bucket: R2Bucket,
): DataRegistrationPreparedArtifact => {
  const key = objectKey(authority.audioAssetRef);
  const artifact: DataRegistrationArtifact = {
    artifactId: deterministicDataRegistrationArtifactId(
      operation.registrationOperationId,
      "canonical_audio",
    ),
    registrationOperationId: operation.registrationOperationId,
    artifactKind: "canonical_audio",
    sourceRef: authority.audioAssetRef,
    mediaType: authority.audioMediaType,
    byteLength: authority.audioByteLength,
    canonicalSha256: authority.canonicalAudioSha256,
    canonicalizationRevision: null,
  };
  return {
    artifact,
    filename: "canonical-audio",
    contentType: artifact.mediaType,
    open: async function* (signal) {
      const selected = await bucket.get(key);
      if (
        selected === null ||
        selected.size !== Number(artifact.byteLength) ||
        selected.httpMetadata?.contentType !== artifact.mediaType ||
        selected.body === undefined
      ) {
        throw new Error("canonical audio object mismatch");
      }
      const reader = selected.body.getReader();
      try {
        while (true) {
          if (signal.aborted) throw new DOMException("cancelled", "AbortError");
          const part = await reader.read();
          if (part.done) return;
          yield part.value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
};

const bucketArtifact = (
  operation: DataRegistrationOperation,
  input: Readonly<{
    kind: "canonical_video" | "poster";
    sourceRef: string;
    mediaType: string;
    byteLength: bigint;
    canonicalSha256: string;
    filename: string;
  }>,
  bucket: R2Bucket,
): DataRegistrationPreparedArtifact => {
  const key = objectKey(input.sourceRef);
  const artifact: DataRegistrationArtifact = {
    artifactId: deterministicDataRegistrationArtifactId(
      operation.registrationOperationId,
      input.kind,
    ),
    registrationOperationId: operation.registrationOperationId,
    artifactKind: input.kind,
    sourceRef: input.sourceRef,
    mediaType: input.mediaType,
    byteLength: input.byteLength,
    canonicalSha256: input.canonicalSha256,
    canonicalizationRevision: null,
  };
  return {
    artifact,
    filename: input.filename,
    contentType: input.mediaType,
    open: async function* (signal) {
      const selected = await bucket.get(key);
      if (
        selected === null ||
        selected.size !== Number(input.byteLength) ||
        selected.httpMetadata?.contentType !== input.mediaType ||
        selected.body === undefined
      ) {
        throw new Error(`${input.kind} object mismatch`);
      }
      const reader = selected.body.getReader();
      try {
        while (true) {
          if (signal.aborted) throw new DOMException("cancelled", "AbortError");
          const part = await reader.read();
          if (part.done) return;
          yield part.value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
};

export type DataRegistrationArtifactPipelineOptions = Readonly<{
  authority: DataRegistrationArtifactAuthorityReader;
  immutableOriginals: R2Bucket;
  pinning: IpfsPinningService;
  gateway: IpfsGatewayVerifier;
  publicOrigin: string;
  now?: () => number;
}>;

export function makeDataRegistrationArtifactPipeline(
  options: DataRegistrationArtifactPipelineOptions,
): DataRegistrationArtifactPipeline {
  const now = options.now ?? Date.now;
  return {
    prepare: async (operation) => {
      const authority = await options.authority.read(operation);
      if (authority.mediaKind === "video") {
        if (
          operation.mediaKind !== "video" ||
          operation.rightsBasis !== "original" ||
          authority.rightsBasis !== "original" ||
          authority.licensePreset !== null ||
          authority.postId !== operation.postId ||
          authority.canonicalVideoSha256 !== operation.canonicalAudioSha256
        ) {
          throw new Error("video DATA publication authority mismatch");
        }
        const posterHead = await options.immutableOriginals.head(
          objectKey(authority.posterArtifactRef),
        );
        if (
          posterHead === null ||
          posterHead.size <= 0 ||
          posterHead.httpMetadata?.contentType !== "image/jpeg"
        ) {
          throw new Error("poster object mismatch");
        }
        const video = bucketArtifact(
          operation,
          {
            kind: "canonical_video",
            sourceRef: authority.videoAssetRef,
            mediaType: authority.videoMediaType,
            byteLength: authority.videoByteLength,
            canonicalSha256: authority.canonicalVideoSha256,
            filename: "canonical-video",
          },
          options.immutableOriginals,
        );
        const poster = bucketArtifact(
          operation,
          {
            kind: "poster",
            sourceRef: authority.posterArtifactRef,
            mediaType: "image/jpeg",
            byteLength: BigInt(posterHead.size),
            canonicalSha256: authority.posterSha256,
            filename: "poster.jpg",
          },
          options.immutableOriginals,
        );
        const pins = await options.authority.listPins(operation.registrationOperationId);
        const verifiedCid = (artifact: DataRegistrationArtifact): string | null =>
          pins.find(
            (pin) =>
              pin.artifactId === artifact.artifactId &&
              pin.role === "primary" &&
              pin.providerId === "filebase" &&
              pin.outcome === "verified" &&
              pin.cid !== null &&
              pin.canonicalSha256 === artifact.canonicalSha256 &&
              pin.byteLength === artifact.byteLength,
          )?.cid ?? null;
        const videoCid = verifiedCid(video.artifact);
        const posterCid = verifiedCid(poster.artifact);
        if (videoCid === null || posterCid === null) return [video, poster];
        const creators = authority.royaltyAllocations.map((allocation) => ({
          name: allocation.recipientId,
          address: allocation.address,
          contributionPercent: allocation.shareBps / 100,
        }));
        const mediaUrl = `ipfs://${videoCid}`;
        const image = `ipfs://${posterCid}`;
        const common = {
          schema_version: "pirate-data-metadata-v1",
          title: "Pirate video",
          createdAt: authority.projectedAt,
          creators,
          external_url: new URL(
            `/posts/${encodeURIComponent(authority.postId)}`,
            options.publicOrigin,
          ).toString(),
        } as const;
        const ipMetadata = await memoryArtifact(operation, "ip_metadata", {
          ...common,
          description: authority.caption ?? "Public video published on Pirate.",
          mediaUrl,
          mediaHash: `0x${authority.canonicalVideoSha256}`,
          mediaType: authority.videoMediaType,
          image,
          imageHash: `0x${authority.posterSha256}`,
          content_rating: authority.contentRating,
          rights: {
            basis: "original",
            offered_license: null,
            beneficiaries: authority.royaltyAllocations.map(({ recipientId, shareBps }) => ({
              recipient_id: recipientId,
              share_bps: shareBps,
            })),
          },
          provenance: {
            acr_decision: authority.acrDecision,
            acr_policy_revision: authority.acrPolicyRevision,
          },
          post: { original_sound_id: authority.originalSoundId },
        });
        const nftMetadata = await memoryArtifact(operation, "nft_metadata", {
          ...common,
          name: "Pirate video",
          description: authority.caption ?? "Pirate public video IP Asset.",
          animation_url: mediaUrl,
          image,
          attributes: [
            { trait_type: "Media kind", value: "video" },
            { trait_type: "Rights basis", value: "original" },
            { trait_type: "Content rating", value: authority.contentRating },
          ],
        });
        return [video, poster, ipMetadata, nftMetadata];
      }
      if (
        operation.mediaKind !== "song" ||
        operation.rightsBasis !== authority.rightsBasis ||
        authority.mediaKind !== "song" ||
        authority.rightsBasis !== "original" ||
        authority.licensePreset === null
      ) {
        throw new Error(
          "song DATA artifacts require a supported original-song intent with offered license terms",
        );
      }
      if (
        authority.postId !== operation.postId ||
        authority.canonicalAudioSha256 !== operation.canonicalAudioSha256 ||
        authority.coverArtifactRef !== null
      ) {
        throw new Error("DATA publication authority mismatch");
      }
      const audio = audioArtifact(operation, authority, options.immutableOriginals);
      const pins = await options.authority.listPins(operation.registrationOperationId);
      const audioPin = pins.find(
        (pin) =>
          pin.artifactKind === "canonical_audio" &&
          pin.role === "primary" &&
          pin.providerId === "filebase" &&
          pin.outcome === "verified" &&
          pin.cid !== null &&
          pin.canonicalSha256 === authority.canonicalAudioSha256 &&
          pin.byteLength === authority.audioByteLength,
      );
      if (audioPin?.cid === undefined || audioPin.cid === null) return [audio];
      const creators = authority.royaltyAllocations.map((allocation) => ({
        name: allocation.recipientId,
        address: allocation.address,
        contributionPercent: allocation.shareBps / 100,
      }));
      const mediaUrl = `ipfs://${audioPin.cid}`;
      const common = {
        schema_version: "pirate-data-metadata-v1",
        title: authority.title,
        createdAt: authority.projectedAt,
        creators,
        external_url: new URL(
          `/posts/${encodeURIComponent(authority.postId)}`,
          options.publicOrigin,
        ).toString(),
      } as const;
      const ipMetadata = await memoryArtifact(operation, "ip_metadata", {
        ...common,
        description: "Public song published on Pirate.",
        mediaUrl,
        mediaHash: `0x${authority.canonicalAudioSha256}`,
        mediaType: authority.audioMediaType,
        ...(authority.lyrics === null ? {} : { lyrics: authority.lyrics }),
        rights: {
          basis: "original",
          license_preset: authority.licensePreset,
          commercial_remix_share_bps: authority.commercialRemixShareBps,
          royalty_allocations: authority.royaltyAllocations.map(({ recipientId, shareBps }) => ({
            recipient_id: recipientId,
            share_bps: shareBps,
          })),
        },
        provenance: {
          acr_decision: authority.acrDecision,
          acr_policy_revision: authority.acrPolicyRevision,
        },
        lyrics_explicitness: authority.lyricsExplicitness,
        primary_language_bcp47: authority.primaryLanguageBcp47,
      });
      const nftMetadata = await memoryArtifact(operation, "nft_metadata", {
        ...common,
        name: authority.title,
        description: "Pirate public song IP Asset.",
        animation_url: mediaUrl,
        attributes: [
          { trait_type: "License", value: authority.licensePreset },
          { trait_type: "Explicit lyrics", value: authority.lyricsExplicitness },
        ],
      });
      return [audio, ipMetadata, nftMetadata];
    },
    pinAndVerify: async (_operation, prepared) => {
      if (prepared.artifact.byteLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        return { status: "failed", evidenceRef: "data-registration://artifact-too-large" };
      }
      const retainedPins = await options.authority.listPins(
        prepared.artifact.registrationOperationId,
      );
      const retainedPrimary = retainedPins.find(
        (pin) =>
          pin.artifactId === prepared.artifact.artifactId &&
          pin.role === "primary" &&
          pin.providerId === "filebase" &&
          pin.outcome === "verified" &&
          pin.cid !== null &&
          pin.byteLength === prepared.artifact.byteLength &&
          pin.canonicalSha256 === prepared.artifact.canonicalSha256,
      );
      if (retainedPrimary?.cid !== undefined && retainedPrimary.cid !== null) {
        const gateway = await Effect.runPromise(
          options.gateway.verify({
            version: "ipfs-gateway-verification-v1",
            request_id: prepared.artifact.artifactId,
            cid: retainedPrimary.cid,
            expected_byte_length: Number(prepared.artifact.byteLength),
            expected_sha256: prepared.artifact.canonicalSha256,
          }),
        );
        if (gateway.status === "verified") {
          return {
            status: "verified",
            cid: retainedPrimary.cid,
            byteLength: BigInt(gateway.byte_length),
            canonicalSha256: gateway.sha256,
            primaryEvidenceRef: retainedPrimary.evidenceRef,
            gatewayEvidenceRef: `data-registration://ipfs.io/${prepared.artifact.artifactId}`,
            verifiedAt: new Date(now()).toISOString(),
          };
        }
        return {
          status: "primary_verified",
          cid: retainedPrimary.cid,
          byteLength: prepared.artifact.byteLength,
          canonicalSha256: prepared.artifact.canonicalSha256,
          primaryEvidenceRef: retainedPrimary.evidenceRef,
          gatewayEvidenceRef: `data-registration://ipfs.io/${prepared.artifact.artifactId}`,
          verifiedAt: retainedPrimary.verifiedAt ?? new Date(now()).toISOString(),
          gatewayRetryable: gateway.status === "retryable",
        };
      }
      const result = await Effect.runPromise(
        pinAndVerifyIpfsArtifact(options.pinning, options.gateway, {
          version: "ipfs-pinning-v1",
          request_id: prepared.artifact.artifactId,
          filename: prepared.filename,
          content_type: prepared.contentType,
          source: {
            byte_length: Number(prepared.artifact.byteLength),
            open: prepared.open,
          },
          expected_byte_length: Number(prepared.artifact.byteLength),
          expected_sha256: prepared.artifact.canonicalSha256,
        }),
      );
      if (result.status === "verified") {
        return {
          status: "verified",
          cid: result.pin.cid,
          byteLength: BigInt(result.pin.byte_length),
          canonicalSha256: result.pin.sha256,
          primaryEvidenceRef: `data-registration://filebase/${prepared.artifact.artifactId}`,
          gatewayEvidenceRef: `data-registration://ipfs.io/${prepared.artifact.artifactId}`,
          verifiedAt: new Date(now()).toISOString(),
        };
      }
      if (result.status === "gateway_failed") {
        return {
          status: "primary_verified",
          cid: result.pin.cid,
          byteLength: BigInt(result.pin.byte_length),
          canonicalSha256: result.pin.sha256,
          primaryEvidenceRef: `data-registration://filebase/${prepared.artifact.artifactId}`,
          gatewayEvidenceRef: `data-registration://ipfs.io/${prepared.artifact.artifactId}`,
          verifiedAt: new Date(now()).toISOString(),
          gatewayRetryable: result.gateway.status === "retryable",
        };
      }
      const retryable =
        result.status === "pin_failed" &&
        ["timeout", "retryable", "cancelled", "not_found"].includes(result.pin.status);
      return retryable
        ? { status: "retryable" }
        : {
            status: "failed",
            evidenceRef: `data-registration://pin-failed/${prepared.artifact.artifactId}`,
          };
    },
  };
}
