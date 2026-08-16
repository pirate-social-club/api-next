import type {
  SessionAccount,
  SessionExchangeServices,
} from "@pirate/application/use-cases/session-exchange";
import { AuthError } from "@pirate/contracts";
import { Effect } from "effect";
import { createHttpWorker } from "../../apps/http-worker/src/transport.ts";

const sessionAccount: SessionAccount = {
  canonicalUserId: "workerd-test-user",
  user: {
    id: "workerd-test-user",
    object: "user",
    verification_state: "unverified",
    verification_capabilities: {
      unique_human: { state: "unverified" },
      age_over_18: { state: "unverified" },
      minimum_age: { state: "unverified" },
      nationality: { state: "unverified" },
      gender: { state: "unverified" },
      wallet_score: { state: "unverified" },
    },
    created: 1_700_000_000,
  },
  profile: {
    id: "workerd-test-user",
    object: "profile",
    global_handle: {
      id: "workerd-test-handle",
      object: "global_handle",
      label: "workerd-test",
      tier: "generated",
      status: "active",
      issuance_source: "generated_signup",
      issued_at: 1_700_000_000,
    },
    created: 1_700_000_000,
  },
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
  wallet_attachments: [],
};

const sessionExchange: SessionExchangeServices = {
  proofVerifier: {
    verifyPrivy: () =>
      Effect.succeed({ sourceUserId: "workerd-test-user", classification: "user" }),
    verifyJwt: () => Effect.succeed({ sourceUserId: "workerd-test-user", classification: "user" }),
  },
  identityStore: { resolve: () => Effect.succeed(sessionAccount) },
  tokenMinter: { mint: () => Effect.succeed("workerd-session-token") },
};

const app = createHttpWorker({
  sessionExchange,
  handlers: {
    CastPostVote: () => ({ post: "post_1", value: 1 }),
  },
  profile: () => sessionAccount.profile,
  authenticate: ({ credentials }) => {
    if (!credentials.authorization.startsWith("Bearer ")) {
      throw new AuthError({ message: "Invalid authorization" });
    }
    return { kind: "user", subject: "workerd-test-user" };
  },
  authorize: ({ input }) => {
    if (input.principal === null) throw new AuthError({ message: "Authentication required" });
  },
});

export default app;
