import type { IdentityStore } from "@pirate/application";
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
import { AuthError } from "@pirate/contracts";
import {
  makeRs256SessionTokenMinter,
  makeRs256SessionTokenVerifier,
  makeSessionBridge,
} from "@pirate/platform-cf";
import { Effect } from "effect";
import { createHttpWorker, type Principal } from "../../apps/http-worker/src/transport.ts";

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

async function sessionBridge() {
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
  return makeSessionBridge({
    privateKeyPem: toPem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicKeyPem: toPem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey)),
  });
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

const identityStore: IdentityStore["Service"] = {
  findUser: (userId) =>
    Effect.succeed(userId === "usr_workerd_test" ? { userId: "usr_workerd_test", account } : null),
  resolveCanonical: ({ sourceUserId }) =>
    Effect.succeed({
      sourceUserId,
      canonicalUserId: "usr_workerd_test",
      aliasPath: sourceUserId === "usr_workerd_test" ? [] : [sourceUserId],
    }),
};

const bridge = await sessionBridge();
const tokenVerifier = makeRs256SessionTokenVerifier(bridge, identityStore);
const sessionExchange: SessionExchangeServices = {
  proofVerifier: {
    verifyPrivy: () =>
      Effect.succeed({ sourceUserId: "usr_workerd_source", classification: "user" }),
    verifyJwt: () => Effect.succeed({ sourceUserId: "usr_workerd_source", classification: "user" }),
  },
  identityStore: makeSessionIdentityStore(identityStore),
  tokenMinter: makeRs256SessionTokenMinter(bridge),
};

const app = createHttpWorker({
  sessionExchange,
  handlers: {
    GetCurrentUser: ({ principal, query }) => {
      if (principal === null || (principal.kind !== "user" && principal.kind !== "admin")) {
        throw new AuthError({ message: "Authorization failed" });
      }
      const communityRef = (query ?? {}) as { readonly community_ref?: string };
      return Effect.runPromise(
        getCurrentUser(
          {
            userId: principal.subject,
            ...(communityRef.community_ref === undefined
              ? {}
              : { communityRef: communityRef.community_ref }),
          },
          { identityStore },
        ),
      );
    },
    CastPostVote: () => ({ post: "post_1", value: 1 }),
    ClearPostVote: () => ({ post: "post_1", value: null }),
    GetJwks: () => bridge.jwks(),
  },
  profile: ({ principal }) =>
    Effect.runPromise(getMyProfile({ userId: principal?.subject ?? "" }, { identityStore })),
  authenticate: ({ credentials }) =>
    Effect.runPromise(
      authenticateSession(
        { authorization: credentials.authorization },
        { verifier: tokenVerifier },
      ).pipe(
        Effect.map(
          (session): Principal => ({
            kind: session.kind,
            subject: session.subject,
            ...(session.scopes === undefined ? {} : { scopes: session.scopes }),
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
