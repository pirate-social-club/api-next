/** Fictional offline profile only. No operational or economic selection. */

import { Schema } from "effect";
import type { ModeratedDanceCreationFacts } from "../../application/src/use-cases/dance/moderated-intake.ts";
import {
  MODERATION_POLICY_CATEGORIES_V1,
  ModerationPolicyTableV1,
} from "../../contracts/src/community-moderation-policy.ts";
import { moderatedDanceFixture } from "./moderated-dance-fixture.ts";
export function moderatedDanceIntakeFacts(): ModeratedDanceCreationFacts {
  const c = moderatedDanceFixture().state.capture;
  const table = Schema.decodeUnknownSync(ModerationPolicyTableV1)(
    Object.fromEntries(MODERATION_POLICY_CATEGORIES_V1.map((k) => [k, "permit"])),
  );
  const safetyPolicy = {
    policy_revision: "test-safety",
    policy_hash: "a".repeat(64),
    platform_policy_revision: "test-floor",
    platform_policy_hash: "b".repeat(64),
    platform_policy: table,
    community_policy_revision: "test-community",
    community_policy_hash: "c".repeat(64),
    community_policy: table,
  };
  return {
    nowMs: 1000,
    mediaReady: true,
    accountFenceRevision: 1,
    accountId: c.accountId,
    personaId: c.personaId,
    communityId: c.communityId,
    songPostId: c.songPostId,
    audioRevision: c.audioRevision,
    choreographyId: c.choreographyId,
    choreographyRevision: c.choreographyRevision,
    segmentId: c.segmentId,
    bodyDurationMs: 10000,
    timezone: c.timezone,
    timezoneVersion: c.timezoneVersion,
    policyId: "policy",
    policy: {
      ...c.policy,
      safetyHash: "8f1282ad88d4286980d31784b2b506417375bbff80dac1e247578ad5573e73e4",
    },
    safetyPolicy,
    disposition: {
      accepted: true,
      version: "test-disposition",
      hash: c.policy.retentionHash,
      validUntilMs: 10000000000,
      cleanupWithinMs: 1000,
      temporaryCleanupWithinMs: 500,
      transferWithinMs: 100,
      hold: {
        accepted: true,
        authorityRef: "test-hold",
        policyHash: c.policy.retentionHash,
        disposeByMs: 10000000000,
      },
    },
    objectives: [],
    profile: {
      version: "dance-moderated-intake-profile-v1",
      sessionTtlMs: 120000,
      uploadTtlMs: 60000,
      presignTtlSeconds: 30,
      maximumBytes: 1000000,
      maximumActiveSessions: 2,
      maximumPendingMediaPerAccount: 3,
      maximumPendingMediaGlobal: 10,
      maximumAccountProviderSpendPerWindow: 1200,
      maximumGlobalProviderSpendPerWindow: 4000,
      windowMs: 60000,
      maximumSessionsPerWindow: 3,
      maximumCommandsPerWindow: 20,
      maximumReadsPerWindow: 30,
      mediaLeaseMs: 5000,
      maximumOwnerPendingReviews: 10,
      cueStartMs: 0,
      cueEndMs: 2000,
      cueHoldMs: 1000,
      bodyStartMs: 2000,
      normalizationWidth: 64,
      normalizationHeight: 64,
      normalizationFps: 10,
      normalizationTimeoutSeconds: 30,
      providerWaitMs: 60000,
      readinessLeaseMs: 30000,
      workLeaseMs: 10000,
      maximumFrameBytes: 100000,
      maximumDurationErrorMs: 0,
      replayCompatibleEpochs: ["test-epoch"],
      maximumProviderCalls: 6,
      maximumProviderSpendMicrounits: 400,
      replayScope: "global-body-v1",
      replayKeyEpoch: "test-epoch",
      replayRetentionMs: 86400000,
      mediaRuntimeRevision: "test-media",
      safetyProviderRevision: "test-safety",
    },
  };
}
