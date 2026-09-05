import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";

export const Health = endpoint({
  method: "GET",
  path: "/health",
  auth: Auth.public(),
  response: Schema.Struct({ status: Schema.Literal("ok") }),
});

import {
  CommitCommunityCreationIntent,
  CreateCommunityCreationIntent,
  GetCommunityCreationIntent,
  UpdateCommunityCreationIntent,
} from "./community-creation.ts";
import * as money from "./community-purchase-funding.ts";
import { GetCanonicalCommunityRoute } from "./community-route-resolution.ts";
import {
  AppendDanceChoreographyRevision,
  ClearSongDancePresentation,
  CreateDanceChoreography,
  DisableDanceChoreography,
  GetDanceChoreographyProcessing,
  GetDanceChoreographyRevision,
  ListReadyDanceChoreographies,
  RetireDanceChoreography,
  SetSongDancePresentation,
} from "./dance.ts";
import {
  CreateDanceSession,
  FinalizeDanceSessionUpload,
  GetDanceSession,
  RecordDanceSessionConsent,
  ReserveDanceSessionUpload,
  SubmitDanceSessionForGrading,
} from "./dance-attempt.ts";
import { handleSalesRegistry } from "./handle-sales.ts";
import { DeliverHnsEdgeAlert } from "./hns-edge-alerts.ts";
import { PublishHnsEdgeStatusReport } from "./hns-edge-status.ts";
import { PollHnsOwnerRecovery, StartHnsOwnerRecovery } from "./hns-owner-recovery.ts";
import {
  ActivateHnsCommunityRootImport,
  ActivateHnsRootImport,
  GetCurrentHnsCommunityRootImport,
  GetHnsCommunityRootImport,
  GetHnsRootImport,
  PollHnsCommunityRootImport,
  PollHnsRootImport,
  StartHnsCommunityRootImport,
  StartHnsRootImport,
} from "./hns-root-import.ts";
import {
  CreateKaraokeAttempt,
  GetKaraokeAttempt,
  GetKaraokeLeaderboard,
  GetKaraokeReadiness,
} from "./karaoke.ts";
import { DeleteMyLearnerAudio } from "./learner-audio.ts";
import { PollNamespaceOwnership, StartNamespaceOwnership } from "./namespace-ownership.ts";
import {
  ConfirmPersonaEvmWallet,
  CreatePersona,
  ListMyPersonas,
  PreparePersonaEvmWallet,
  RetirePersona,
} from "./personas.ts";
import { platformPirateHandleRegistry } from "./platform-pirate-handles.ts";
import {
  GetPublicPostBySlug,
  GetPublicPostCanonicalRouteById,
  GetPublicPostSitemap,
} from "./public-post-routes.ts";
import {
  GetCommunityActivityLeaderboard,
  GetSongActivityLeaderboard,
  GetStudySession,
  SetAccountStreakTimezone,
  SetActivityPresentationPersona,
  StartStudySession,
  SubmitStudyAnswer,
} from "./rewards-qualification.ts";
import {
  AddAssetBonusLeg,
  AddMegapotPoolLeg,
  GetAssetBonusFunding,
  GetMegapotPoolFunding,
  GetMegapotPoolStanding,
  GetSongMegapotPool,
  ListMyRewardCredits,
  ListSongAssetBonuses,
  ObserveAssetBonusFunding,
  ObserveMegapotPoolFunding,
  OpenSongRewardOffer,
} from "./rewards-song-offers.ts";
import {
  GetPublicSongOwnerPolicy,
  GetSongOwnerPolicy,
  UpdateSongOwnerPolicy,
} from "./song-owner-video-policy.ts";
import {
  GetStudyAvailabilityV2,
  GetStudySessionV2,
  RequestStudyGenerationV2,
  StartStudySessionV2,
  SubmitStudyAnswerV2,
} from "./study-v2.ts";
/** Named registry; the client generator references these exports by name. */
import { v1Registry } from "./v1.ts";
import * as verification from "./verification.ts";

export const registry = {
  Health,
  CreateCommunityCreationIntent,
  GetCommunityCreationIntent,
  UpdateCommunityCreationIntent,
  CommitCommunityCreationIntent,
  GetCanonicalCommunityRoute,
  DeliverHnsEdgeAlert,
  PublishHnsEdgeStatusReport,
  StartHnsOwnerRecovery,
  PollHnsOwnerRecovery,
  StartHnsRootImport,
  GetHnsRootImport,
  PollHnsRootImport,
  ActivateHnsRootImport,
  StartHnsCommunityRootImport,
  GetHnsCommunityRootImport,
  GetCurrentHnsCommunityRootImport,
  PollHnsCommunityRootImport,
  ActivateHnsCommunityRootImport,
  ...handleSalesRegistry,
  ListMyPersonas,
  CreatePersona,
  PreparePersonaEvmWallet,
  ConfirmPersonaEvmWallet,
  RetirePersona,
  ...platformPirateHandleRegistry,
  ...v1Registry,
  GetSongOwnerPolicy,
  UpdateSongOwnerPolicy,
  GetPublicSongOwnerPolicy,
  ...verification,
  ...money,
  StartNamespaceOwnership,
  PollNamespaceOwnership,
  CreateKaraokeAttempt,
  GetKaraokeReadiness,
  GetKaraokeAttempt,
  GetKaraokeLeaderboard,
  CreateDanceChoreography,
  GetDanceChoreographyProcessing,
  AppendDanceChoreographyRevision,
  DisableDanceChoreography,
  RetireDanceChoreography,
  ListReadyDanceChoreographies,
  GetDanceChoreographyRevision,
  SetSongDancePresentation,
  ClearSongDancePresentation,
  CreateDanceSession,
  RecordDanceSessionConsent,
  ReserveDanceSessionUpload,
  FinalizeDanceSessionUpload,
  SubmitDanceSessionForGrading,
  GetDanceSession,
  DeleteMyLearnerAudio,
  StartStudySession,
  GetStudySession,
  SubmitStudyAnswer,
  SetAccountStreakTimezone,
  SetActivityPresentationPersona,
  GetSongActivityLeaderboard,
  GetCommunityActivityLeaderboard,
  GetStudyAvailabilityV2,
  RequestStudyGenerationV2,
  StartStudySessionV2,
  GetStudySessionV2,
  SubmitStudyAnswerV2,
  OpenSongRewardOffer,
  AddMegapotPoolLeg,
  ObserveMegapotPoolFunding,
  GetMegapotPoolFunding,
  GetSongMegapotPool,
  GetMegapotPoolStanding,
  ListMyRewardCredits,
  AddAssetBonusLeg,
  ObserveAssetBonusFunding,
  GetAssetBonusFunding,
  ListSongAssetBonuses,
  GetPublicPostBySlug,
  GetPublicPostCanonicalRouteById,
  GetPublicPostSitemap,
} as const;

/** The sole source consumed by every generated HTTP artifact. */
import type { EndpointDefinition } from "./endpoint.ts";

export const endpoints: readonly EndpointDefinition[] = Object.values(registry);
