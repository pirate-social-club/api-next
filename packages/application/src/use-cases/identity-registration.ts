import { Data, Effect } from "effect";
import type { IdentityAccountDocument } from "./identity-account.ts";
import type { PersonaWalletPreparation } from "./personas.ts";

export const MAX_IDENTITY_REGISTRATION_ATTEMPTS = 5;

export type IdentityRegistrationCandidate = {
  readonly credentialId: string;
  readonly userId: string;
  readonly handleId: string;
  readonly handleLabel: string;
  readonly createdAt: string;
};

export type IdentityRegistrationStoreOutcome =
  | {
      readonly kind: "created";
      readonly canonicalUserId: string;
      readonly account: IdentityAccountDocument;
    }
  | {
      readonly kind: "already_registered";
      readonly canonicalUserId: string;
      readonly account: IdentityAccountDocument;
    }
  | { readonly kind: "tombstoned" }
  | {
      readonly kind: "candidate_collision";
      readonly field: "credential_id" | "user_id" | "handle";
    };

export class IdentityRegistrationStoreFailure extends Data.TaggedError(
  "IdentityRegistrationStoreFailure",
)<{
  readonly reason: "identity-conflict" | "storage";
}> {}

export interface IdentityRegistrationStore {
  readonly registerCredential: (input: {
    readonly provider: "privy";
    readonly providerAppId: string;
    readonly providerSubject: string;
    readonly credentialId: string;
    readonly userId: string;
    readonly account: IdentityAccountDocument;
  }) => Effect.Effect<IdentityRegistrationStoreOutcome, IdentityRegistrationStoreFailure>;
  readonly getFirstPersonaWalletPreparation?: (
    accountId: string,
  ) => Effect.Effect<PersonaWalletPreparation | null, IdentityRegistrationStoreFailure>;
}

export interface IdentityRegistrationCandidateSource {
  readonly next: () => Effect.Effect<IdentityRegistrationCandidate, unknown>;
}

/**
 * Creates the opaque account/handle candidates used by the production
 * registration composition. The provider subject never participates in these
 * identifiers; each retry gets a fresh cryptographically random candidate.
 */
export function makeRandomIdentityRegistrationCandidateSource(): IdentityRegistrationCandidateSource {
  return {
    next: () =>
      Effect.sync(() => {
        const random = crypto.randomUUID();
        const handleStem = `new-${random.replaceAll("-", "").slice(0, 20)}`;
        return {
          credentialId: `cred_${random}`,
          userId: `usr_${random}`,
          handleId: `hndl_${random}`,
          handleLabel: `${handleStem}.pirate`,
          createdAt: new Date().toISOString(),
        };
      }),
  };
}

export interface IdentityRegistrationServices {
  readonly store: IdentityRegistrationStore;
  readonly candidates: IdentityRegistrationCandidateSource;
}

export class IdentityRegistrationFailed extends Data.TaggedError("IdentityRegistrationFailed")<{
  readonly reason: "invalid-input" | "invalid-candidate" | "identity-conflict" | "storage";
}> {}

export class IdentityRegistrationExhausted extends Data.TaggedError(
  "IdentityRegistrationExhausted",
)<{
  readonly attempts: number;
}> {}

export class IdentityCredentialTombstoned extends Data.TaggedError(
  "IdentityCredentialTombstoned",
) {}

const reservedHandleStems = new Set([
  "admin",
  "api",
  "help",
  "pirate",
  "root",
  "staging",
  "support",
  "www",
]);

const validIdentifier = (value: string): boolean =>
  value.length > 0 && value === value.trim() && !value.includes("\u0000");

const validCandidate = (candidate: IdentityRegistrationCandidate): boolean => {
  if (
    !validIdentifier(candidate.credentialId) ||
    !validIdentifier(candidate.userId) ||
    !validIdentifier(candidate.handleId) ||
    !Number.isFinite(Date.parse(candidate.createdAt))
  ) {
    return false;
  }
  if (candidate.handleLabel !== candidate.handleLabel.trim().toLowerCase()) return false;
  const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.pirate$/u.exec(candidate.handleLabel);
  const stem = match?.[1];
  return stem !== undefined && stem.length <= 32 && !reservedHandleStems.has(stem);
};

export function makeUnverifiedIdentityAccount(
  candidate: IdentityRegistrationCandidate,
): IdentityAccountDocument {
  return {
    user: {
      user_id: candidate.userId,
      primary_wallet_attachment_id: null,
      capability_provider: null,
      verification_capabilities_json: null,
      verified_at: null,
      created_at: candidate.createdAt,
    },
    profile: {
      user_id: candidate.userId,
      display_name: null,
      bio: null,
      bio_source: "none",
      avatar_ref: null,
      avatar_source: "none",
      cover_ref: null,
      cover_source: "none",
      preferred_locale: null,
      display_verified_nationality_badge: 0,
      global_handle_id: candidate.handleId,
      primary_linked_handle_id: null,
      xmtp_inbox_id: null,
      created_at: candidate.createdAt,
    },
    global_handle: {
      global_handle_id: candidate.handleId,
      label_display: candidate.handleLabel,
      status: "active",
      tier: "generated",
      issuance_source: "generated_signup",
      redirect_target_global_handle_id: null,
      price_paid_cents: null,
      free_rename_consumed: 0,
      issued_at: candidate.createdAt,
      replaced_at: null,
    },
    linked_handles: [],
    wallet_attachments: [],
    onboarding: {
      generated_handle_assigned: true,
      cleanup_rename_available: true,
      unique_human_verification_status: "not_started",
      namespace_verification_status: "not_started",
      community_creation_ready: false,
      missing_requirements: [],
      reddit_verification_status: "not_started",
      reddit_import_status: "not_started",
    },
  };
}

export const registerIdentity = Effect.fn("registerIdentity")(function* (
  input: { readonly providerAppId: string; readonly providerSubject: string },
  services: IdentityRegistrationServices,
): Effect.fn.Return<
  {
    readonly status: "created" | "already_registered";
    readonly canonicalUserId: string;
    /** The account document returned by the same transactional registration seam. */
    readonly account: IdentityAccountDocument;
    readonly walletSetup?: PersonaWalletPreparation | null;
  },
  IdentityRegistrationFailed | IdentityRegistrationExhausted | IdentityCredentialTombstoned
> {
  if (!validIdentifier(input.providerAppId) || !validIdentifier(input.providerSubject)) {
    return yield* new IdentityRegistrationFailed({ reason: "invalid-input" });
  }

  for (let attempt = 1; attempt <= MAX_IDENTITY_REGISTRATION_ATTEMPTS; attempt += 1) {
    const candidate = yield* services.candidates
      .next()
      .pipe(Effect.mapError(() => new IdentityRegistrationFailed({ reason: "storage" })));
    if (!validCandidate(candidate)) {
      return yield* new IdentityRegistrationFailed({ reason: "invalid-candidate" });
    }
    const outcome = yield* services.store
      .registerCredential({
        provider: "privy",
        providerAppId: input.providerAppId,
        providerSubject: input.providerSubject,
        credentialId: candidate.credentialId,
        userId: candidate.userId,
        account: makeUnverifiedIdentityAccount(candidate),
      })
      .pipe(Effect.mapError((error) => new IdentityRegistrationFailed({ reason: error.reason })));

    if (outcome.kind === "created" || outcome.kind === "already_registered") {
      const walletSetup =
        services.store.getFirstPersonaWalletPreparation === undefined
          ? null
          : yield* services.store
              .getFirstPersonaWalletPreparation(outcome.canonicalUserId)
              .pipe(Effect.mapError(() => new IdentityRegistrationFailed({ reason: "storage" })));
      return {
        status: outcome.kind,
        canonicalUserId: outcome.canonicalUserId,
        account: outcome.account,
        walletSetup,
      };
    }
    if (outcome.kind === "tombstoned") return yield* new IdentityCredentialTombstoned();
  }

  return yield* new IdentityRegistrationExhausted({
    attempts: MAX_IDENTITY_REGISTRATION_ATTEMPTS,
  });
});
