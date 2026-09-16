import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import { AuthError, BadRequest, Conflict, InternalError, NotFound, RateLimited } from "./errors.ts";

const boundedIdentifier = (label: string) =>
  Schema.String.check(
    Schema.makeFilter((value) =>
      value.length > 0 &&
      value.length <= 128 &&
      value === value.trim() &&
      ![...value].some(
        (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
      )
        ? undefined
        : `Expected a bounded ${label}`,
    ),
  );

const nullableBoundedText = (maximumLength: number, label: string) =>
  Schema.NullOr(
    Schema.String.check(
      Schema.makeFilter((value) =>
        value.length <= maximumLength &&
        ![...value].some(
          (character) => character.charCodeAt(0) === 0 || character.charCodeAt(0) === 0x7f,
        )
          ? undefined
          : `Expected bounded ${label}`,
      ),
    ),
  );

export const PersonaIdV1 = boundedIdentifier("persona identifier");
export type PersonaIdV1 = Schema.Schema.Type<typeof PersonaIdV1>;

/**
 * Server-validated persona choice for a terminal community membership or
 * community-creation commit (spec 014 section 11.2). A browser never invents
 * a persona id or a binding: it either names an existing owned persona or
 * asks the server to mint one in the same commit.
 */
export const PersonaCommunityChoiceV1 = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("existing"),
    persona_id: PersonaIdV1,
  }),
  Schema.Struct({ kind: Schema.Literal("create_new") }),
]);
export type PersonaCommunityChoiceV1 = Schema.Schema.Type<typeof PersonaCommunityChoiceV1>;

export const PersonaStatusV1 = Schema.Literals(["active", "suspended", "retired"]);
export type PersonaStatusV1 = Schema.Schema.Type<typeof PersonaStatusV1>;

export const PersonaChainAccountKindV1 = Schema.Literal("evm");
export type PersonaChainAccountKindV1 = Schema.Schema.Type<typeof PersonaChainAccountKindV1>;

const EvmAddressV1 = Schema.String.check(
  Schema.makeFilter((value) =>
    /^0x[0-9a-f]{40}$/u.test(value) ? undefined : "Expected a canonical lowercase EVM address",
  ),
);

const HdWalletIndexV1 = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);

export const PersonaProfileV1 = Schema.Struct({
  persona_id: PersonaIdV1,
  object: Schema.Literal("persona_profile"),
  revision: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  display_name: nullableBoundedText(80, "display name"),
  avatar_ref: nullableBoundedText(2_048, "avatar reference"),
  cover_ref: nullableBoundedText(2_048, "cover reference"),
  bio: nullableBoundedText(2_000, "bio"),
  preferred_locale: nullableBoundedText(64, "locale"),
  primary_public_handle: nullableBoundedText(255, "public handle"),
});
export type PersonaProfileV1 = Schema.Schema.Type<typeof PersonaProfileV1>;

/** Public surfaces may embed this projection; it has no account or wallet key. */
export const PublicPersonaV1 = Schema.Struct({
  persona_id: PersonaIdV1,
  object: Schema.Literal("persona"),
  display_name: nullableBoundedText(80, "display name"),
  avatar_ref: nullableBoundedText(2_048, "avatar reference"),
  primary_public_handle: nullableBoundedText(255, "public handle"),
});
export type PublicPersonaV1 = Schema.Schema.Type<typeof PublicPersonaV1>;

export const PersonaEvmWalletAssignmentV1 = Schema.Struct({
  chain_account_kind: PersonaChainAccountKindV1,
  hd_wallet_index: HdWalletIndexV1,
  address: EvmAddressV1,
  assigned_at: Schema.String,
});
export type PersonaEvmWalletAssignmentV1 = Schema.Schema.Type<typeof PersonaEvmWalletAssignmentV1>;

export const PersonaWalletSetV1 = Schema.Struct({
  evm: Schema.NullOr(PersonaEvmWalletAssignmentV1),
});
export type PersonaWalletSetV1 = Schema.Schema.Type<typeof PersonaWalletSetV1>;

export const PersonaEvmWalletPreparationV1 = Schema.Union([
  Schema.Struct({
    persona_id: PersonaIdV1,
    chain_account_kind: Schema.Literal("evm"),
    hd_wallet_index: HdWalletIndexV1,
    status: Schema.Literal("pending"),
    assignment: Schema.Null,
  }),
  Schema.Struct({
    persona_id: PersonaIdV1,
    chain_account_kind: Schema.Literal("evm"),
    hd_wallet_index: HdWalletIndexV1,
    status: Schema.Literal("active"),
    assignment: PersonaEvmWalletAssignmentV1,
  }),
]);
export type PersonaEvmWalletPreparationV1 = Schema.Schema.Type<
  typeof PersonaEvmWalletPreparationV1
>;

/** Account-private binding history, never part of the public persona projection. */
export const PersonaCommunityBindingV1 = Schema.Struct({
  community_id: boundedIdentifier("community identifier"),
  binding_source: Schema.Literals([
    "first_membership",
    "community_creation",
    "persona_creation",
    "activity_participation",
    "migration_single_evidence",
    "explicit_migration_resolution",
  ]),
});
export type PersonaCommunityBindingV1 = Schema.Schema.Type<typeof PersonaCommunityBindingV1>;

export const PersonaCommunityBindingSourceV1 = PersonaCommunityBindingV1.fields.binding_source;
export type PersonaCommunityBindingSourceV1 = Schema.Schema.Type<
  typeof PersonaCommunityBindingSourceV1
>;

const CanonicalInstantV1 = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
      ? undefined
      : "Expected a canonical ISO instant";
  }),
);

/**
 * The account's current explicitly selected activity persona for one
 * community. It is not the same fact as membership: preparation never joins,
 * follows, assigns a role or allocates a wallet.
 */
export const ActivityPresentationV1 = Schema.Struct({
  object: Schema.Literal("activity_presentation"),
  community_id: boundedIdentifier("community identifier"),
  persona_id: PersonaIdV1,
  updated_at: CanonicalInstantV1,
});
export type ActivityPresentationV1 = Schema.Schema.Type<typeof ActivityPresentationV1>;

/**
 * Result of explicit activity preparation (spec 014 section 11.2). An active
 * persona can enter activities immediately; a `pending_wallet` persona follows
 * the ordinary additional-persona activation before any activity command
 * accepts it. `activity_presentation` is null until an active persona is
 * prepared, because presentation requires an active owned persona.
 */
export const ActivityPersonaPreparationV1 = Schema.Struct({
  object: Schema.Literal("activity_persona_preparation"),
  community_id: boundedIdentifier("community identifier"),
  persona_id: PersonaIdV1,
  persona_status: Schema.Literals(["active", "pending_wallet"]),
  activity_presentation: Schema.NullOr(ActivityPresentationV1),
});
export type ActivityPersonaPreparationV1 = Schema.Schema.Type<typeof ActivityPersonaPreparationV1>;

export const PrivatePersonaV1 = Schema.Struct({
  persona_id: PersonaIdV1,
  object: Schema.Literal("persona"),
  status: PersonaStatusV1,
  profile: PersonaProfileV1,
  wallet_set: PersonaWalletSetV1,
  community_binding: Schema.NullOr(PersonaCommunityBindingV1),
  created_at: Schema.String,
  retired_at: Schema.NullOr(Schema.String),
});
export type PrivatePersonaV1 = Schema.Schema.Type<typeof PrivatePersonaV1>;

const CreatePersonaRequestV1 = Schema.Struct({
  idempotency_key: boundedIdentifier("idempotency key"),
  /**
   * Spec 014 section 11.2: creating a further persona outside onboarding
   * requires a target community; the new persona is born bound there in the
   * creation transaction and the account must hold an active membership.
   */
  community_id: boundedIdentifier("community identifier"),
  display_name: Schema.optional(nullableBoundedText(80, "display name")),
  bio: Schema.optional(nullableBoundedText(2_000, "bio")),
  preferred_locale: Schema.optional(nullableBoundedText(64, "locale")),
});

const PersonaPathV1 = Schema.Struct({ personaId: PersonaIdV1 });

const PreparePersonaEvmWalletRequestV1 = Schema.Struct({
  idempotency_key: boundedIdentifier("idempotency key"),
});

const RetirePersonaRequestV1 = Schema.Struct({
  idempotency_key: boundedIdentifier("idempotency key"),
  /**
   * Spec 014 section 11.3: retiring a persona that is a community's current
   * role or activity presentation must atomically designate another active
   * persona bound to the same community, or the retirement is rejected.
   */
  replacement_persona_id: Schema.optional(PersonaIdV1),
});

export const PersonaRetirementV1 = Schema.Struct({
  persona_id: PersonaIdV1,
  status: Schema.Literal("retired"),
  retired_at: Schema.String,
  /** Present only when this retirement re-designated a current presentation. */
  replacement_persona_id: Schema.optional(PersonaIdV1),
});
export type PersonaRetirementV1 = Schema.Schema.Type<typeof PersonaRetirementV1>;

const proofToken = (label: string) =>
  Schema.String.check(
    Schema.makeFilter((value) =>
      value.length > 0 && value.length <= 16 * 1_024 && !/[\r\n]/u.test(value)
        ? undefined
        : `Expected a bounded ${label}`,
    ),
  );

const ConfirmPersonaEvmWalletRequestV1 = Schema.Struct({
  proof: Schema.Struct({
    type: Schema.Literal("privy_access_token"),
    privy_access_token: proofToken("Privy access token"),
    privy_identity_token: Schema.optional(Schema.NullOr(proofToken("Privy identity token"))),
  }),
});

export const ListMyPersonas = endpoint({
  method: "GET",
  path: "/personas",
  auth: Auth.userOrAdmin(),
  response: Schema.Struct({
    personas: Schema.Array(PrivatePersonaV1),
  }),
  successStatus: 200,
  errors: [AuthError, InternalError],
});

/** Account-private recovery inventory, separate from public profile projections. */
export const ListMyPendingPersonaWallets = endpoint({
  method: "GET",
  path: "/personas/wallets/evm/pending",
  auth: Auth.userOrAdmin(),
  response: Schema.Struct({ wallets: Schema.Array(PersonaEvmWalletPreparationV1) }),
  successStatus: 200,
  errors: [AuthError, InternalError],
});

export const CreatePersona = endpoint({
  method: "POST",
  path: "/personas",
  auth: Auth.userOrAdmin(),
  request: { body: CreatePersonaRequestV1 },
  response: PersonaEvmWalletPreparationV1,
  successStatus: 201,
  errors: [AuthError, BadRequest, Conflict, InternalError, RateLimited],
});

const ActivityCommunityPathV1 = Schema.Struct({
  communityId: boundedIdentifier("community identifier"),
});

/**
 * Explicit activity preparation before any join (spec 014 section 11.2). It
 * resolves one of three server-validated choices — select the active owned
 * persona already bound to the community, bind an owned unbound persona once,
 * or mint a new persona born bound with `activity_participation` as its
 * source. It records no membership, follow, role, wallet for an existing
 * persona or verification claim, and preserves an existing explicit activity
 * presentation.
 */
export const PrepareActivityPersona = endpoint({
  method: "POST",
  path: "/communities/:communityId/activity-personas/prepare",
  auth: Auth.userOrAdmin(),
  request: {
    path: ActivityCommunityPathV1,
    body: Schema.Struct({
      idempotency_key: boundedIdentifier("idempotency key"),
      choice: PersonaCommunityChoiceV1,
    }),
  },
  response: ActivityPersonaPreparationV1,
  successStatus: 200,
  errors: [AuthError, BadRequest, Conflict, InternalError, NotFound, RateLimited],
});

/** Retrieve the append-only provider HD index reserved by persona creation. */
export const PreparePersonaEvmWallet = endpoint({
  method: "POST",
  path: "/personas/:personaId/wallets/evm/prepare",
  auth: Auth.userOrAdmin(),
  request: { path: PersonaPathV1, body: PreparePersonaEvmWalletRequestV1 },
  response: PersonaEvmWalletPreparationV1,
  successStatus: 200,
  errors: [AuthError, BadRequest, Conflict, InternalError, NotFound],
});

/** Retire an active persona or cancel a private pending persona without recycling its index. */
export const RetirePersona = endpoint({
  method: "POST",
  path: "/personas/:personaId/retire",
  auth: Auth.userOrAdmin(),
  request: { path: PersonaPathV1, body: RetirePersonaRequestV1 },
  response: PersonaRetirementV1,
  successStatus: 200,
  errors: [AuthError, BadRequest, Conflict, InternalError, NotFound],
});

/** Confirm only the exact provider-attested wallet at the reserved HD index. */
export const ConfirmPersonaEvmWallet = endpoint({
  method: "POST",
  path: "/personas/:personaId/wallets/evm/confirm",
  auth: Auth.userOrAdmin(),
  request: { path: PersonaPathV1, body: ConfirmPersonaEvmWalletRequestV1 },
  response: PersonaEvmWalletAssignmentV1,
  successStatus: 200,
  errors: [AuthError, BadRequest, Conflict, InternalError, NotFound],
});
