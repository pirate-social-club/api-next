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
import { handleSalesRegistry } from "./handle-sales.ts";
import { PollHnsOwnerRecovery, StartHnsOwnerRecovery } from "./hns-owner-recovery.ts";
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
  GetCommunityActivityLeaderboard,
  GetSongActivityLeaderboard,
  GetStudySession,
  SetAccountStreakTimezone,
  SetActivityPresentationPersona,
  StartStudySession,
  SubmitStudyAnswer,
} from "./rewards-qualification.ts";
import {
  AddMegapotPoolLeg,
  GetMegapotPoolFunding,
  GetMegapotPoolStanding,
  GetSongMegapotPool,
  ListMyRewardCredits,
  ObserveMegapotPoolFunding,
  OpenSongRewardOffer,
} from "./rewards-song-offers.ts";
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
  StartHnsOwnerRecovery,
  PollHnsOwnerRecovery,
  ...handleSalesRegistry,
  ListMyPersonas,
  CreatePersona,
  PreparePersonaEvmWallet,
  ConfirmPersonaEvmWallet,
  RetirePersona,
  ...platformPirateHandleRegistry,
  ...v1Registry,
  ...verification,
  ...money,
  StartNamespaceOwnership,
  PollNamespaceOwnership,
  CreateKaraokeAttempt,
  GetKaraokeReadiness,
  GetKaraokeAttempt,
  GetKaraokeLeaderboard,
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
} as const;

/** The sole source consumed by every generated HTTP artifact. */
import type { EndpointDefinition } from "./endpoint.ts";

export const endpoints: readonly EndpointDefinition[] = Object.values(registry);
