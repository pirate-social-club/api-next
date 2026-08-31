import { Data, Schema } from "effect";
import type {
  DanceReferenceAuthoringAuthorityResolver,
  DanceReferencePolicyAuthority,
} from "./reference-services.ts";

const Identifier = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.length <= 512 &&
    value.trim() === value &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
      ? undefined
      : "Expected a bounded canonical identifier",
  ),
);
const ObjectKey = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.length <= 2_048 &&
    value.trim() === value &&
    !value.includes("\u0000") &&
    !value.includes("\\") &&
    !value.split("/").includes("..") &&
    !value.startsWith("http://") &&
    !value.startsWith("https://")
      ? undefined
      : "Expected a private server-owned object reference",
  ),
);
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const PositiveInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const NonNegativeInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const BasisPoints = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 }));

const Target = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("song"), songPostId: Identifier }),
  Schema.Struct({
    kind: Schema.Literal("choreography"),
    choreographyId: Identifier,
    songPostId: Identifier,
  }),
]);

/**
 * Immutable publication facts emitted by the future Spec 013 video lane.
 * This contains no provider result, URL, credential, reward, or account-wide
 * policy beyond the exact publication-authority snapshot.
 */
export const SealedDanceReferencePublication = Schema.Struct({
  version: Schema.Literal("sealed-dance-reference-publication-v1"),
  communityId: Identifier,
  target: Target,
  canonicalAudio: Schema.Struct({
    postId: Identifier,
    audioRevision: PositiveInteger,
    objectKey: ObjectKey,
    sha256: Sha256,
    durationMs: PositiveInteger,
    status: Schema.Literal("published"),
    visibility: Schema.Literal("public"),
  }),
  referenceVideo: Schema.Struct({
    postId: Identifier,
    authorAccountId: Identifier,
    track: Schema.Literal("video"),
    status: Schema.Literal("published"),
    visibility: Schema.Literal("public"),
    sealStatus: Schema.Literal("sealed"),
    songPostId: Identifier,
    audioRevision: PositiveInteger,
    objectKey: ObjectKey,
    sha256: Sha256,
    durationMs: PositiveInteger,
  }),
  publicationOwnerPolicy: Schema.Struct({
    observedAtTransition: Schema.Literal("publication_committed"),
    songPostId: Identifier,
    audioRevision: PositiveInteger,
    ownerAccountId: Identifier,
    revision: PositiveInteger,
    hash: Sha256,
    derivativeVideo: Schema.Literals(["allowed", "owner_only", "blocked"]),
  }),
});
export type SealedDanceReferencePublication = Schema.Schema.Type<
  typeof SealedDanceReferencePublication
>;

const ProcessingPolicy = Schema.Struct({
  extraction: Schema.Struct({
    policyVersion: Identifier,
    outputProfile: Schema.Struct({
      sampleRateHz: Schema.Int.check(Schema.isBetween({ minimum: 8_000, maximum: 192_000 })),
      channels: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 })),
      codec: Schema.Literals(["flac", "pcm_s16le", "pcm_s24le", "wav"]),
    }),
  }),
  alignment: Schema.Struct({
    policyVersion: Identifier,
    adapterId: Identifier,
    adapterRevision: Identifier,
    limits: Schema.Struct({
      maximumAbsoluteOffsetMs: NonNegativeInteger,
      maximumAbsoluteDriftMs: NonNegativeInteger,
      maximumAbsoluteSlopeDeltaPpm: NonNegativeInteger,
      minimumOverallConfidenceBps: BasisPoints,
      minimumCoverageBps: BasisPoints,
      minimumSoundtrackMatchBps: BasisPoints,
    }),
  }),
  pose: Schema.Struct({
    modelVersion: Identifier,
    runtimeVersion: Identifier,
    featureSchemaVersion: Identifier,
    scorerContractVersion: Identifier,
    fingerprintPolicyVersion: Identifier,
    integrityPolicyVersion: Identifier,
  }),
  qualityLimits: Schema.Struct({
    minimumUsableCoverageBps: BasisPoints,
    maximumMissingGapSlots: NonNegativeInteger,
    minimumBodyCoverageBps: BasisPoints,
    minimumVisibilityCoverageBps: BasisPoints,
    minimumMotionEnergyBps: BasisPoints,
    minimumSpatialExtentBps: BasisPoints,
  }),
});

const ResolverInput = Schema.Struct({
  actorAccountId: Identifier,
  communityId: Identifier,
  target: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("song"), songPostId: Identifier }),
    Schema.Struct({ kind: Schema.Literal("choreography"), choreographyId: Identifier }),
  ]),
  audioRevision: PositiveInteger,
  referenceVideoPostId: Identifier,
  startMs: NonNegativeInteger,
  endMs: PositiveInteger,
}).check(
  Schema.makeFilter(({ startMs, endMs }) => {
    const durationMs = endMs - startMs;
    return durationMs >= 6_000 && durationMs <= 30_000
      ? undefined
      : "Expected a valid half-open Dance reference interval";
  }),
);

export type DanceReferenceSealedPublicationSourceInput = Readonly<{
  readonly communityId: string;
  readonly target:
    | Readonly<{ readonly kind: "song"; readonly songPostId: string }>
    | Readonly<{ readonly kind: "choreography"; readonly choreographyId: string }>;
  readonly audioRevision: number;
  readonly referenceVideoPostId: string;
}>;

export interface DanceReferenceSealedPublicationSource {
  readonly resolve: (input: DanceReferenceSealedPublicationSourceInput) => Promise<unknown>;
}

export type DanceReferenceProcessingPolicy = Omit<DanceReferencePolicyAuthority, "ownerPolicy">;

export class DanceReferenceAuthorityError extends Data.TaggedError("DanceReferenceAuthorityError")<{
  readonly reason:
    | "invalid-configuration"
    | "invalid-input"
    | "source-unavailable"
    | "invalid-publication"
    | "authority-mismatch"
    | "publication-forbidden";
}> {}

const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown) =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);

function sameTarget(
  requested: Schema.Schema.Type<typeof ResolverInput>["target"],
  resolved: SealedDanceReferencePublication["target"],
): boolean {
  return requested.kind === "song"
    ? resolved.kind === "song" && resolved.songPostId === requested.songPostId
    : resolved.kind === "choreography" && resolved.choreographyId === requested.choreographyId;
}

const targetSongPostId = (target: SealedDanceReferencePublication["target"]): string =>
  target.songPostId;

/**
 * Builds provider-neutral authoring authority from one immutable sealed-video
 * publication snapshot and one explicitly supplied processing policy. Nothing
 * in this adapter performs network I/O or installs itself into production.
 */
export function makeSealedDanceReferenceAuthoringAuthorityResolver(options: {
  readonly source: DanceReferenceSealedPublicationSource;
  readonly processingPolicy: DanceReferenceProcessingPolicy;
}): DanceReferenceAuthoringAuthorityResolver {
  let processingPolicy: DanceReferenceProcessingPolicy;
  try {
    processingPolicy = decode(ProcessingPolicy, options.processingPolicy);
  } catch {
    throw new DanceReferenceAuthorityError({ reason: "invalid-configuration" });
  }

  return {
    resolve: async (rawInput) => {
      let input: Schema.Schema.Type<typeof ResolverInput>;
      try {
        input = decode(ResolverInput, rawInput);
      } catch {
        throw new DanceReferenceAuthorityError({ reason: "invalid-input" });
      }

      let rawPublication: unknown;
      try {
        rawPublication = await options.source.resolve({
          communityId: input.communityId,
          target: input.target,
          audioRevision: input.audioRevision,
          referenceVideoPostId: input.referenceVideoPostId,
        });
      } catch {
        throw new DanceReferenceAuthorityError({ reason: "source-unavailable" });
      }

      let publication: SealedDanceReferencePublication;
      try {
        publication = decode(SealedDanceReferencePublication, rawPublication);
      } catch {
        throw new DanceReferenceAuthorityError({ reason: "invalid-publication" });
      }

      const songPostId = targetSongPostId(publication.target);
      if (
        publication.communityId !== input.communityId ||
        !sameTarget(input.target, publication.target) ||
        publication.canonicalAudio.postId !== songPostId ||
        publication.canonicalAudio.audioRevision !== input.audioRevision ||
        publication.referenceVideo.postId !== input.referenceVideoPostId ||
        publication.referenceVideo.songPostId !== songPostId ||
        publication.referenceVideo.audioRevision !== input.audioRevision ||
        publication.referenceVideo.authorAccountId !== input.actorAccountId ||
        publication.publicationOwnerPolicy.songPostId !== songPostId ||
        publication.publicationOwnerPolicy.audioRevision !== input.audioRevision ||
        input.endMs > publication.canonicalAudio.durationMs ||
        input.endMs - input.startMs > publication.referenceVideo.durationMs
      ) {
        throw new DanceReferenceAuthorityError({ reason: "authority-mismatch" });
      }

      if (
        publication.publicationOwnerPolicy.derivativeVideo === "blocked" ||
        (publication.publicationOwnerPolicy.derivativeVideo === "owner_only" &&
          publication.referenceVideo.authorAccountId !==
            publication.publicationOwnerPolicy.ownerAccountId)
      ) {
        throw new DanceReferenceAuthorityError({ reason: "publication-forbidden" });
      }

      return {
        canonicalAudio: {
          objectKey: publication.canonicalAudio.objectKey,
          sha256: publication.canonicalAudio.sha256,
          durationMs: publication.canonicalAudio.durationMs,
          audioRevision: publication.canonicalAudio.audioRevision,
        },
        referenceVideo: {
          postId: publication.referenceVideo.postId,
          objectKey: publication.referenceVideo.objectKey,
          sha256: publication.referenceVideo.sha256,
          durationMs: publication.referenceVideo.durationMs,
        },
        ...processingPolicy,
        ownerPolicy: {
          revision: publication.publicationOwnerPolicy.revision,
          hash: publication.publicationOwnerPolicy.hash,
        },
      };
    },
  };
}
