import type { MediaProcessingAuthority } from "./processing-contracts.ts";

export function alignmentRecoveryAuthority(
  overrides: Partial<MediaProcessingAuthority> = {},
): MediaProcessingAuthority {
  return {
    communityId: "recovery-community",
    actorAccountId: "recovery-actor",
    authorPersonaId: "recovery-persona",
    submissionId: "recovery-submission",
    operationId: "recovery-operation",
    songType: "original",
    title: "Recovery song",
    authorDeclaredRating: "general",
    creationRevision: 3,
    audioRevision: 1,
    analysisRevision: 1,
    decisionRevision: 1,
    workflowRevision: 3,
    replacementSequence: 0,
    retryCount: 0,
    status: "published",
    phase: null,
    audio: {
      immutableRef: "immutable-recovery",
      canonicalSha256: "a".repeat(64),
      contentType: "audio/mpeg",
      sizeBytes: 4,
    },
    termsRevision: 1,
    lyrics: {
      lyricsRevision: 1,
      audioRevision: 1,
      canonicalAudioSha256: "a".repeat(64),
      text: "Recovery lyrics",
    },
    analysis: null,
    decision: null,
    boundReferenceAssetId: null,
    postId: "recovery-post",
    publishedLyricsRevision: 1,
    ...overrides,
  };
}
