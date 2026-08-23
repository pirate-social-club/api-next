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
import { PollHnsOwnerRecovery, StartHnsOwnerRecovery } from "./hns-owner-recovery.ts";
import { CreateKaraokeAttempt, GetKaraokeAttempt, GetKaraokeLeaderboard } from "./karaoke.ts";
import { PollNamespaceOwnership, StartNamespaceOwnership } from "./namespace-ownership.ts";
import {
  ConfirmPersonaEvmWallet,
  CreatePersona,
  ListMyPersonas,
  PreparePersonaEvmWallet,
} from "./personas.ts";
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
  ListMyPersonas,
  CreatePersona,
  PreparePersonaEvmWallet,
  ConfirmPersonaEvmWallet,
  ...v1Registry,
  ...verification,
  ...money,
  StartNamespaceOwnership,
  PollNamespaceOwnership,
  CreateKaraokeAttempt,
  GetKaraokeAttempt,
  GetKaraokeLeaderboard,
} as const;

/** The sole source consumed by every generated HTTP artifact. */
import type { EndpointDefinition } from "./endpoint.ts";

export const endpoints: readonly EndpointDefinition[] = Object.values(registry);
