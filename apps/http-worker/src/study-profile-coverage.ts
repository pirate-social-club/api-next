import type { MissingStudyProfile } from "@pirate/platform-cf/study-profile-coverage-repository";

export const makeStudyProfileCoverageRunner =
  (services: {
    nextMissing: () => Promise<MissingStudyProfile | null>;
    generateProfile: (input: { communityId: string; postId: string }) => Promise<{
      lyricsRevision: number;
      sourceHash: string;
    }>;
    reportFailure: (input: { communityId: string; postId: string; reason: string }) => void;
  }) =>
  async () => {
    const missing = await services.nextMissing();
    if (missing === null) return false;
    try {
      const outcome = await services.generateProfile({
        communityId: missing.communityId,
        postId: missing.postId,
      });
      if (
        outcome.lyricsRevision !== missing.lyricsRevision ||
        outcome.sourceHash !== missing.sourceHash
      ) {
        throw new Error("profile source changed during generation");
      }
      return true;
    } catch (error) {
      services.reportFailure({
        communityId: missing.communityId,
        postId: missing.postId,
        reason: error instanceof Error ? error.name : "unknown",
      });
      return false;
    }
  };
