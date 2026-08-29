import {
  CommunityModerationStoreError,
  type CommunityModerationStoreService,
  ContentRepositoryError,
  type ContentStore,
  createTextPost,
  type IdentityStore,
  type M2Actor,
  moderateCommunityCase,
  type PersonaRecord,
  type PersonaStoreService,
  reportCommunityContent,
  type TextModeration,
  TextModerationProviderError,
  TextPostRepositoryError,
  type TextPostStore,
} from "@pirate/application";
import {
  hnsCompletionRequestHash,
  hnsNamespaceStartHash,
  type NamespaceOwnershipCompletionServices,
  type NamespaceOwnershipStartAuthority,
  type NamespaceOwnershipStartServices,
  type NamespaceOwnershipStoredCompletion,
} from "@pirate/application/namespace-ownership";
import { getCurrentUser } from "@pirate/application/use-cases/current-user";
import type { IdentityAccountDocument } from "@pirate/application/use-cases/identity-account";
import { getMyProfile } from "@pirate/application/use-cases/profile";
import {
  authenticateSession,
  authorizeSession,
} from "@pirate/application/use-cases/session-authentication";
import {
  makeSessionIdentityStore,
  type SessionExchangeServices,
} from "@pirate/application/use-cases/session-exchange";
import {
  computeVerificationRequestHash,
  makeVerificationProviderRegistry,
  type StoredVerificationCompletion,
  type VerificationCompletionStore,
  type VerificationProviderPlanInput,
} from "@pirate/application/verification";
import { AuthError } from "@pirate/contracts";
import {
  makeRs256SessionTokenMinter,
  makeRs256SessionTokenVerifier,
  makeSessionCrypto,
} from "@pirate/platform-cf";
import { makePlatformNamespaceOwnershipProviderRegistry } from "@pirate/platform-cf/namespace-ownership-provider-registry";
import { Effect } from "effect";
import { makeNamespaceOwnershipHandlers } from "../../apps/http-worker/src/namespace-ownership-handlers.ts";
import {
  createHttpWorker,
  type DecodedRequest,
  type Principal,
} from "../../apps/http-worker/src/transport.ts";
import { makeVerificationHandlers } from "../../apps/http-worker/src/verification-handlers.ts";
import { castPostVote } from "../../packages/application/src/use-cases/content/cast-post-vote.ts";
import { clearPostVote } from "../../packages/application/src/use-cases/content/clear-post-vote.ts";
import { createCommentReply } from "../../packages/application/src/use-cases/content/comments-replies.ts";
import {
  makeVeryWebProvider,
  VERY_WEB_CONFIGURATION_REFERENCE,
  VERY_WEB_CONFIGURATION_VERSION,
  VERY_WEB_ISSUER,
  VERY_WEB_METHOD,
  VERY_WEB_PROTOCOL_VERSION,
  VERY_WEB_PROVIDER_ID,
  VERY_WEB_RP_SCOPE,
} from "../../packages/platform-cf/src/verification/providers/very-web.ts";

export { HnsForwarderReplayStoreDO } from "../../packages/platform-cf/src/hns-forwarder-replay-store-do.ts";
export { KaraokeAttemptDO } from "../../packages/platform-cf/src/karaoke-attempt-do.ts";
export {
  RegistrationApplicationRateLimiterDO,
  RegistrationIpRateLimiterDO,
} from "../../packages/platform-cf/src/registration-rate-limiter-do.ts";

function toBase64(bytes: ArrayBufferLike): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function toPem(label: "PRIVATE KEY" | "PUBLIC KEY", bytes: ArrayBuffer): string {
  const base64 = toBase64(bytes);
  const lines = base64.match(/.{1,64}/gu)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

async function sessionCryptos() {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2_048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const privateKeyPem = toPem(
    "PRIVATE KEY",
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  const publicKeyPem = toPem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey));
  const common = {
    privateKeyPem,
    publicKeyPem,
    issuer: "api-next-session-workerd",
    audience: "api-next-browser-workerd",
  };
  return {
    browser: await makeSessionCrypto({
      ...common,
      defaultScope: "browser",
    }),
  };
}

const account: IdentityAccountDocument = {
  user: {
    user_id: "usr_workerd_test",
    primary_wallet_attachment_id: "wallet_workerd",
    capability_provider: null,
    verification_capabilities_json: null,
    verified_at: null,
    created_at: "2026-08-16T12:00:00.000Z",
  },
  profile: {
    user_id: "usr_workerd_test",
    display_name: "Workerd Captain",
    bio: null,
    bio_source: "none",
    avatar_ref: null,
    avatar_source: "none",
    cover_ref: null,
    cover_source: "none",
    preferred_locale: "en",
    display_verified_nationality_badge: 0,
    global_handle_id: "handle_workerd",
    primary_linked_handle_id: null,
    xmtp_inbox_id: null,
    created_at: "2026-08-16T12:00:00.000Z",
  },
  global_handle: {
    global_handle_id: "handle_workerd",
    label_display: "workerd-test.pirate",
    status: "active",
    tier: "generated",
    issuance_source: "generated_signup",
    redirect_target_global_handle_id: null,
    price_paid_cents: null,
    free_rename_consumed: 0,
    issued_at: "2026-08-16T12:00:00.000Z",
    replaced_at: null,
  },
  linked_handles: [],
  wallet_attachments: [
    {
      wallet_attachment_id: "wallet_workerd",
      chain_namespace: "eip155:1",
      wallet_address_display: "0xworkerd",
      is_primary: 1,
    },
  ],
  onboarding: {
    generated_handle_assigned: true,
    cleanup_rename_available: false,
    unique_human_verification_status: "not_started",
    namespace_verification_status: "not_started",
    community_creation_ready: false,
    missing_requirements: [],
    reddit_verification_status: "not_started",
    reddit_import_status: "not_started",
  },
};

const ownerAccount: IdentityAccountDocument = {
  ...account,
  user: {
    ...account.user,
    user_id: "usr_workerd_owner",
    primary_wallet_attachment_id: "wallet_workerd_owner",
  },
  profile: {
    ...account.profile,
    user_id: "usr_workerd_owner",
    global_handle_id: "handle_workerd_owner",
  },
  global_handle: {
    ...account.global_handle,
    global_handle_id: "handle_workerd_owner",
    label_display: "workerd-owner.pirate",
  },
  wallet_attachments: [
    {
      wallet_attachment_id: "wallet_workerd_owner",
      chain_namespace: "eip155:1",
      wallet_address_display: "0x1111111111111111111111111111111111111111",
      is_primary: 1,
    },
  ],
};

const textSubmission = {
  submission_id: "submission_workerd",
  href: "/text-content-submissions/submission_workerd",
  surface: "text_post" as const,
  status: "manual_review" as const,
  result: { decision: "manual_review" as const, reason_code: "moderation_unavailable" as const },
  published_resource: null,
  review_ref: "review_workerd",
  created_at: "2026-08-21T12:00:00.000Z",
  updated_at: "2026-08-21T12:00:00.000Z",
};

const workerdPersonaId = "persona_workerd_test";
const workerdPersona: PersonaRecord = {
  persona_id: workerdPersonaId,
  object: "persona",
  status: "active",
  profile: {
    persona_id: workerdPersonaId,
    object: "persona_profile",
    revision: 1,
    display_name: "Workerd Captain",
    avatar_ref: null,
    cover_ref: null,
    bio: null,
    preferred_locale: "en",
    primary_public_handle: null,
  },
  wallet_set: { evm: null },
  created_at: "2026-08-16T12:00:00.000Z",
  retired_at: null,
};
const personaStore: PersonaStoreService = {
  listByAccount: (accountId) =>
    Effect.succeed(accountId === account.user.user_id ? [workerdPersona] : []),
  findOwned: ({ accountId, personaId }) =>
    Effect.succeed(
      accountId === account.user.user_id && personaId === workerdPersonaId ? workerdPersona : null,
    ),
  create: () => Effect.die("unused Workerd persona fixture operation"),
};

const routeAuthorityFixtureId = "community-very-staging-fixture-acceptance-v1";
const missingRouteTextPostStore: TextPostStore["Service"] = {
  replay: () => Effect.succeed({ kind: "none" as const }),
  checkAuthority: () =>
    Effect.fail(new TextPostRepositoryError({ operation: "authority", reason: "not-found" })),
  commitTerminal: () => Effect.die("missing route must fail before moderation or commit"),
  getForAuthor: () => Effect.succeed(null),
};
const unavailableTextModeration: TextModeration["Service"] = {
  evaluate: () => Effect.fail(new TextModerationProviderError({ reason: "unavailable" })),
};

function createPostThroughContract(request: DecodedRequest) {
  const communityId = (request.params as Readonly<{ communityId: string }>).communityId;
  if (communityId !== routeAuthorityFixtureId) return textSubmission;
  const principal = request.principal;
  if (principal === null || (principal.kind !== "user" && principal.kind !== "admin")) {
    throw new AuthError({ message: "Authentication required" });
  }
  return Effect.runPromise(
    createTextPost(
      {
        communityId,
        actor: { userId: principal.subject, kind: principal.kind },
        body: request.body,
      },
      {
        textPostStore: missingRouteTextPostStore,
        textModeration: unavailableTextModeration,
        personaStore,
      },
    ),
  );
}

const identityStore: IdentityStore["Service"] = {
  findUser: (userId) => {
    if (userId === "usr_workerd_test") {
      return Effect.succeed({ userId, account });
    }
    if (userId === "usr_workerd_owner") {
      return Effect.succeed({ userId, account: ownerAccount });
    }
    return Effect.succeed(null);
  },
  resolveCanonical: ({ sourceUserId }) => {
    const canonicalUserId =
      sourceUserId === "usr_workerd_owner_source" || sourceUserId === "usr_workerd_owner"
        ? "usr_workerd_owner"
        : "usr_workerd_test";
    return Effect.succeed({
      sourceUserId,
      canonicalUserId,
      aliasPath: sourceUserId === canonicalUserId ? [] : [sourceUserId],
    });
  },
};

const sessionCryptoInstances = await sessionCryptos();
const browserTokenVerifier = makeRs256SessionTokenVerifier(
  sessionCryptoInstances.browser,
  identityStore,
);
const tokenVerifier = browserTokenVerifier;
const browserTokenMinter = makeRs256SessionTokenMinter(sessionCryptoInstances.browser);
const moderatorWalletAddress = "0x1111111111111111111111111111111111111111";
const sessionExchange: SessionExchangeServices = {
  proofVerifier: {
    verifyPrivy: ({ accessToken }) =>
      Effect.succeed({
        sourceUserId:
          accessToken === "workerd-moderator-proof"
            ? "usr_workerd_owner_source"
            : "usr_workerd_source",
        classification: "user" as const,
        ...(accessToken === "workerd-moderator-proof"
          ? { walletAddress: moderatorWalletAddress }
          : {}),
      }),
  },
  identityStore: makeSessionIdentityStore(identityStore),
  productReadiness: { isReady: () => Effect.succeed(true) },
  tokenMinter: browserTokenMinter,
};

const namespaceRoute = {
  family: "hns" as const,
  root_label: "jazleeuw",
  root_label_display: "jazleeuw",
  path_segment: "app.jazleeuw",
  href: "/c/app.jazleeuw",
  app_host: null,
};
const namespaceAuthority: NamespaceOwnershipStartAuthority = {
  actor_id: "usr_workerd_test",
  creation_intent_id: "intent-workerd",
  ceremony_intent_id: "ceremony-workerd",
  expected_revision: 3,
  requirement_hash: "a".repeat(64),
  generation: 1,
  provider_id: "hns.owner.v1",
  provider_binding_hash: "b".repeat(64),
  provider_configuration: { kind: "managed", reference: "hns-workerd", version: "1" },
  route: namespaceRoute,
};
const namespaceStartRequestHash = await hnsNamespaceStartHash({
  actor_id: namespaceAuthority.actor_id,
  creation_intent_id: namespaceAuthority.creation_intent_id,
  ceremony_intent_id: namespaceAuthority.ceremony_intent_id,
  requirement_hash: namespaceAuthority.requirement_hash,
  generation: namespaceAuthority.generation,
  provider_id: namespaceAuthority.provider_id,
  provider_binding_hash: namespaceAuthority.provider_binding_hash,
  provider_configuration: namespaceAuthority.provider_configuration,
  protocol_version: "hns-txt-v1",
  environment: "test",
  route: namespaceRoute,
});
const namespaceSession = {
  actor_id: namespaceAuthority.actor_id,
  creation_intent_id: namespaceAuthority.creation_intent_id,
  ceremony_intent_id: namespaceAuthority.ceremony_intent_id,
  requirement_hash: namespaceAuthority.requirement_hash,
  generation: namespaceAuthority.generation,
  request_hash: namespaceStartRequestHash,
  provider_id: namespaceAuthority.provider_id,
  provider_binding_hash: namespaceAuthority.provider_binding_hash,
  provider_configuration: namespaceAuthority.provider_configuration,
  protocol_version: "hns-txt-v1",
  environment: "test",
  route: namespaceRoute,
  upstream_session_ref: "upstream-workerd",
  expires_at: "2099-01-01T00:00:00.000Z",
};
const namespaceRegistry = await Effect.runPromise(makePlatformNamespaceOwnershipProviderRegistry());
const namespaceStart: NamespaceOwnershipStartServices = {
  environment: "test",
  intents: {
    resolve: (input) =>
      input.actor_id === namespaceAuthority.actor_id &&
      input.creation_intent_id === namespaceAuthority.creation_intent_id &&
      input.ceremony_intent_id === namespaceAuthority.ceremony_intent_id &&
      input.expected_revision === namespaceAuthority.expected_revision
        ? Effect.succeed(namespaceAuthority)
        : Effect.die("namespace authority input drifted"),
  },
  registry: namespaceRegistry,
  store: {
    replay: (input) => {
      if (
        input.actor_id !== namespaceAuthority.actor_id ||
        input.creation_intent_id !== namespaceAuthority.creation_intent_id ||
        input.ceremony_intent_id !== namespaceAuthority.ceremony_intent_id ||
        input.expected_revision !== namespaceAuthority.expected_revision
      ) {
        return Effect.die("namespace replay input drifted");
      }
      return Effect.succeed(
        input.client_idempotency_key === "replay-1"
          ? {
              kind: "replay" as const,
              namespace_session_id: "namespace-session-replay",
              start: {
                session: namespaceSession,
                presentation: {
                  kind: "embedded_sdk" as const,
                  session_id: "upstream-workerd",
                  protocol: "hns-txt-challenge",
                  version: "1",
                  payload: {
                    ownership_source: "hns_parent_chain_txt",
                    challenge_name: "jazleeuw",
                    challenge_value: "pirate-verification=upstream-workerd",
                    expires_at: "2099-01-01T00:00:00.000Z",
                  },
                },
              },
            }
          : { kind: "none" as const },
      );
    },
    reserve: () => Effect.die("disabled registry must reject before reservation"),
    finalize: () => Effect.die("disabled registry must reject before finalization"),
    release: () => Effect.die("disabled registry must reject before release"),
  },
};
const replayCompletionInput = {
  actor_id: namespaceAuthority.actor_id,
  creation_intent_id: namespaceAuthority.creation_intent_id,
  ceremony_intent_id: namespaceAuthority.ceremony_intent_id,
  session_id: "namespace-session-replay",
  expected_revision: 3,
  idempotency_key: "poll-replay-1",
  channel: "poll_result" as const,
};
const replayCompletionHash = await hnsCompletionRequestHash(replayCompletionInput);
const namespaceCompletion: NamespaceOwnershipCompletionServices = {
  registry: namespaceRegistry,
  store: {
    load: (input) => {
      if (
        input.actor_id !== namespaceAuthority.actor_id ||
        input.creation_intent_id !== namespaceAuthority.creation_intent_id ||
        input.ceremony_intent_id !== namespaceAuthority.ceremony_intent_id ||
        (input.session_id !== replayCompletionInput.session_id &&
          input.session_id !== "namespace-session-fresh")
      ) {
        return Effect.die("namespace completion input drifted");
      }
      const terminal = input.session_id === replayCompletionInput.session_id;
      const stored: NamespaceOwnershipStoredCompletion = {
        namespace_session_id: input.session_id,
        revision: 3,
        session: namespaceSession,
        status: terminal ? "completed" : "pending",
        terminal: terminal
          ? {
              status: "verified",
              idempotency_key: replayCompletionInput.idempotency_key,
              completion_request_hash: replayCompletionHash,
              result_hash: "d".repeat(64),
            }
          : null,
      };
      return Effect.succeed(stored);
    },
    reserve: () => Effect.die("disabled registry must reject before reservation"),
    release: () => Effect.die("disabled registry must reject before release"),
    reject: () => Effect.die("disabled registry must reject before rejection"),
    consume: () => Effect.die("disabled registry must reject before consumption"),
    verify: () => Effect.die("disabled registry must reject before verification"),
  },
};

const moderationFixture: TextPostStore["Service"] = {
  checkAuthority: ({ communityId }) =>
    communityId === "community_nonmember"
      ? Effect.fail(
          new TextPostRepositoryError({ operation: "authority", reason: "membership-required" }),
        )
      : communityId === "community_ineffective"
        ? Effect.fail(new TextPostRepositoryError({ operation: "authority", reason: "not-found" }))
        : Effect.succeed(undefined),
  replay: ({ idempotencyKey }) =>
    Effect.succeed(
      idempotencyKey === "workerd-comment-conflict"
        ? { kind: "conflict" as const, submissionId: "submission-comment-winner" }
        : { kind: "none" as const },
    ),
  commitTerminal: () => Effect.die("unused moderation fixture operation"),
  getForAuthor: () => Effect.succeed(null),
  resolveCommentTarget: ({ targetId }) =>
    Effect.succeed({
      kind: "ready" as const,
      communityId:
        targetId === "post_nonmember"
          ? "community_nonmember"
          : targetId === "post_ineffective"
            ? "community_ineffective"
            : "community_workerd",
      postId: targetId,
      parentCommentId: null,
      parentDepth: -1,
    }),
};
const communityModerationFixture: CommunityModerationStoreService = {
  getCapabilities: () => Effect.die("unused Workerd moderation capability operation"),
  listCases: () => Effect.die("unused Workerd moderation list operation"),
  getCase: () => Effect.die("unused Workerd moderation detail operation"),
  getPolicy: () => Effect.die("unused Workerd moderation policy operation"),
  updatePolicy: () => Effect.die("unused Workerd moderation policy update"),
  replayLegacyAction: () => Effect.succeed(null),
  reportTarget: () =>
    Effect.succeed({
      report_id: "report_workerd",
      case_ref: "case_workerd",
      status: "open" as const,
    }),
  actOnCase: ({ actor, action }) =>
    (actor.kind === "user" || actor.kind === "admin") && actor.userId === "usr_workerd_owner"
      ? Effect.succeed({
          version: "moderation-case-action-result-v2" as const,
          action_id: "action_workerd",
          case_ref: "case_workerd",
          action,
          target_status: action === "hide" ? ("hidden" as const) : ("published" as const),
        })
      : Effect.fail(
          new CommunityModerationStoreError({ operation: "action", reason: "not-found" }),
        ),
};
const voteFixture: ContentStore["Service"] = {
  resolvePost: ({ postId }) =>
    Effect.succeed({
      communityId:
        postId === "post_nonmember"
          ? "community_nonmember"
          : postId === "post_ineffective"
            ? "community_ineffective"
            : "community_workerd",
      postId,
    }),
  resolveComment: () => Effect.die("unused vote fixture operation"),
  createPost: () => Effect.die("unused vote fixture operation"),
  getPost: () => Effect.die("unused vote fixture operation"),
  checkVoteAuthority: ({ communityId }) =>
    communityId === "community_nonmember"
      ? Effect.fail(
          new ContentRepositoryError({
            operation: "cast-vote",
            reason: "membership-required",
          }),
        )
      : communityId === "community_ineffective"
        ? Effect.fail(new ContentRepositoryError({ operation: "cast-vote", reason: "not-found" }))
        : Effect.succeed(undefined),
  replayCastPostVote: ({ idempotencyKey }) =>
    idempotencyKey === "workerd-vote-conflict"
      ? Effect.fail(
          new ContentRepositoryError({
            operation: "cast-vote",
            reason: "idempotency-conflict",
            actionId: "vote_action_workerd_conflict",
          }),
        )
      : Effect.succeed(null),
  replayClearPostVote: () => Effect.succeed(null),
  castPostVote: ({ postId, body }) => Effect.succeed({ post_id: postId, value: body.value }),
  clearPostVote: ({ postId }) => Effect.succeed({ post_id: postId, value: 0 }),
};
const moderationActor = (request: DecodedRequest): M2Actor => {
  const principal = request.principal;
  if (principal === null || (principal.kind !== "user" && principal.kind !== "admin"))
    throw new AuthError({ message: "Authorization required" });
  return {
    userId: principal.subject,
    kind: principal.kind,
    ...(principal.scopes === undefined ? {} : { scopes: principal.scopes }),
  };
};
const moderationParams = (request: DecodedRequest): Record<string, unknown> =>
  request.params as Record<string, unknown>;

const veryNow = "2099-08-20T12:00:00.000Z";
const veryExpires = "2099-08-20T12:05:00.000Z";
const veryConfiguration = {
  kind: "dynamic" as const,
  reference: VERY_WEB_CONFIGURATION_REFERENCE,
  version: VERY_WEB_CONFIGURATION_VERSION,
};
const veryPlanInput = {
  method: VERY_WEB_METHOD,
  scope: {
    kind: "named" as const,
    scope_semantics: "issuer_rp_scope" as const,
    issuer: VERY_WEB_ISSUER,
    rp_scope: VERY_WEB_RP_SCOPE,
  },
  requested_requirements: [
    { claim_id: "credential.subject_unique" },
    { claim_id: "human.personhood" },
  ],
  requested_claim_ids: ["credential.subject_unique", "human.personhood"],
  subject_binding_intent: "establish" as const,
  protocol_version: VERY_WEB_PROTOCOL_VERSION,
  environment: "test",
  verification_purpose: {
    intent: "community_join" as const,
    policy_id: "curated-human-membership-v1",
  },
} satisfies VerificationProviderPlanInput;
const veryIdentifierCounts = new Map<string, number>();
const veryProvider = makeVeryWebProvider({
  app_id: "very-workerd-app",
  api_url: "https://api.very.example/api/v1",
  verify_url: "https://verify.very.example/api/v1/verify",
  bridge_api_url: "https://bridge.very.example/api/v1",
  sealing_key: new Uint8Array(32).fill(7),
  transport: {
    createBridge: () =>
      Effect.succeed({ status: 200, body: { sessionId: "bridge-session-workerd" } }),
    bridgeStatus: () => Effect.succeed({ status: 200, body: { status: "pending" } }),
    verify: () => Effect.succeed({ status: 200, body: { status: "valid" } }),
  },
  clock: { now: () => veryNow, expiresAt: () => veryExpires },
  identifiers: {
    next: (kind) => {
      if (kind === "session") return "very-session-workerd";
      const next = (veryIdentifierCounts.get(kind) ?? 0) + 1;
      veryIdentifierCounts.set(kind, next);
      return `very-${kind}-${next}-workerd`;
    },
  },
  randomness: { bytes: (length) => new Uint8Array(length).fill(length) },
  digest: { digest: () => Effect.succeed("b".repeat(64)) },
});
const veryRequestInput = {
  actor_id: "usr_workerd_test",
  intent_id: "intent-very-workerd",
  ...veryPlanInput,
  request_mode: "dynamic" as const,
  provider_configuration: veryConfiguration,
};
const veryRequestHash = await computeVerificationRequestHash(
  VERY_WEB_PROVIDER_ID,
  veryRequestInput,
);
const veryStarted = await Effect.runPromise(
  veryProvider.start({
    ...veryRequestInput,
    request_hash: veryRequestHash,
  }),
);
const veryRegistry = await Effect.runPromise(
  makeVerificationProviderRegistry([veryProvider], { now: () => Date.parse(veryNow) }),
);
let veryCurrentSession = veryStarted.session;
const veryCompletionStore: VerificationCompletionStore = {
  load: ({ proof_session_id }) =>
    Effect.succeed(
      proof_session_id === veryCurrentSession.id
        ? ({ session: veryCurrentSession, terminal: null } satisfies StoredVerificationCompletion)
        : null,
    ),
  reserveAttempt: () =>
    Effect.succeed({
      kind: "acquired" as const,
      reservation: {
        attempt_id: "very-attempt-workerd",
        fence_token: 1,
        lease_expires_at: veryExpires,
      },
    }),
  releaseAttempt: () => Effect.void,
  consumeAttempt: () => Effect.void,
  settleCompleted: () => Effect.void,
  commit: (input) => Effect.succeed({ kind: "committed" as const, result_hash: input.result_hash }),
};
const verificationHandlers = makeVerificationHandlers({
  start: {
    registry: veryRegistry,
    intents: {
      resolve: (input) =>
        "intent_id" in input && input.intent_id === veryRequestInput.intent_id
          ? Effect.succeed(veryPlanInput)
          : Effect.die("Very workerd intent drifted"),
    },
    store: {
      reserve: () =>
        Effect.succeed({
          kind: "acquired" as const,
          reservation: {
            reservation_id: "very-reservation-workerd",
            fence_token: 1,
            lease_expires_at: veryExpires,
          },
        }),
      finalize: (_reservation, start) => {
        veryCurrentSession = start.session;
        return Effect.succeed({ kind: "created" as const, start });
      },
      release: () => Effect.void,
    },
  },
  completion: {
    registry: veryRegistry,
    store: veryCompletionStore,
    hasher: { hash: () => Effect.succeed("c".repeat(64)) },
    now: () => Date.parse(veryNow),
  },
});

const app = createHttpWorker({
  config: { corsOrigin: "https://solid.test" },
  sessionExchange,
  handlers: {
    ...verificationHandlers,
    ...makeNamespaceOwnershipHandlers({
      start: namespaceStart,
      completion: namespaceCompletion,
    }),
    GetCurrentUser: ({ principal }) => {
      if (principal === null || (principal.kind !== "user" && principal.kind !== "admin")) {
        throw new AuthError({ message: "Authorization failed" });
      }
      return Effect.runPromise(getCurrentUser({ userId: principal.subject }, { identityStore }));
    },
    CastPostVote: (request) =>
      Effect.runPromise(
        castPostVote(
          {
            postId: String(moderationParams(request).postId),
            actor: moderationActor(request),
            body: request.body,
          },
          { contentStore: voteFixture },
        ),
      ),
    ClearPostVote: (request) =>
      Effect.runPromise(
        clearPostVote(
          {
            postId: String(moderationParams(request).postId),
            actor: moderationActor(request),
            body: request.body,
          },
          { contentStore: voteFixture },
        ),
      ),
    CreateComment: (request) =>
      Effect.runPromise(
        createCommentReply(
          {
            surface: "comment",
            targetId: String(moderationParams(request).postId),
            actor: moderationActor(request),
            body: request.body,
          },
          {
            textPostStore: moderationFixture,
            textModeration: {
              evaluate: () => Effect.die("comment route fixture must fail before moderation"),
            },
            personaStore,
          },
        ),
      ),
    ReportComment: (request) =>
      Effect.runPromise(
        reportCommunityContent(
          {
            targetType: "comment",
            targetId: String(moderationParams(request).commentId),
            actor: moderationActor(request),
            idempotencyKey: String(
              (request.body as { readonly idempotency_key: string }).idempotency_key,
            ),
            reasonCode: (request.body as { readonly reason_code: "spam" }).reason_code,
            requestHash: "a".repeat(64),
          },
          { moderationStore: communityModerationFixture },
        ),
      ),
    ModerateCaseAction: (request) =>
      Effect.runPromise(
        moderateCommunityCase(
          {
            caseRef: String(moderationParams(request).caseRef),
            actor: moderationActor(request),
            idempotencyKey: String(
              (request.body as { readonly idempotency_key: string }).idempotency_key,
            ),
            expectedCaseRevision: Number(
              (request.body as { readonly expected_case_revision: number }).expected_case_revision,
            ),
            action: (request.body as { readonly action: "hide" }).action,
            requestHash: "b".repeat(64),
          },
          { moderationStore: communityModerationFixture },
        ),
      ),
    CreatePost: createPostThroughContract,
    GetTextContentSubmission: () => textSubmission,
    GetJwks: () => sessionCryptoInstances.browser.jwks(),
  },
  profile: ({ principal }) =>
    Effect.runPromise(getMyProfile({ userId: principal?.subject ?? "" }, { identityStore })),
  authenticate: ({ credentials }) =>
    Effect.runPromise(
      authenticateSession(
        {
          ...(credentials.authorization === undefined
            ? {}
            : { authorization: credentials.authorization }),
          ...(credentials.sessionCookie === undefined
            ? {}
            : { sessionCookie: credentials.sessionCookie }),
        },
        { verifier: tokenVerifier },
      ).pipe(
        Effect.map(
          (session): Principal => ({
            kind: session.kind,
            subject: session.subject,
            ...(session.scopes === undefined ? {} : { scopes: session.scopes }),
            ...(session.walletAddress === undefined
              ? {}
              : { walletAddress: session.walletAddress }),
          }),
        ),
      ),
    ),
  authorize: ({ input }) => {
    if (input.principal === null) throw new AuthError({ message: "Authentication required" });
    return Effect.runPromise(
      authorizeSession({
        session: input.principal,
        allowedKinds: ["user", "admin"],
      }),
    );
  },
});

export default app;
