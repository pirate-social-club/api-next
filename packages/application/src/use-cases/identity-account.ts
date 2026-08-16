import { GetMyProfile, SessionExchange } from "@pirate/contracts";
import {
  assembleProfile,
  type GlobalHandleRowInput,
  getPrimaryWalletAddressFromRows,
  type LinkedHandleRowInput,
  type ProfileRowInput,
  serializeUserRow,
  serializeWalletAttachments,
  type UserRowInput,
  type WalletAttachmentRowInput,
} from "@pirate/domain";
import { Data, Effect, Schema } from "effect";
import type { ControlPlaneError, IdentityStore, IdentityUser } from "../ports.ts";
import type { SessionAccount } from "./session-exchange.ts";

const NullableString = Schema.NullOr(Schema.String);

const UserRow = Schema.Struct({
  user_id: Schema.String,
  primary_wallet_attachment_id: NullableString,
  capability_provider: Schema.optional(NullableString),
  verification_capabilities_json: Schema.NullOr(Schema.String),
  verified_at: NullableString,
  created_at: Schema.String,
});

const ProfileRow = Schema.Struct({
  user_id: Schema.String,
  display_name: NullableString,
  bio: NullableString,
  bio_source: Schema.NullOr(Schema.Literals(["ens", "manual", "none"])),
  avatar_ref: NullableString,
  avatar_source: Schema.NullOr(Schema.Literals(["ens", "upload", "none"])),
  cover_ref: NullableString,
  cover_source: Schema.NullOr(Schema.Literals(["ens", "upload", "none"])),
  preferred_locale: NullableString,
  display_verified_nationality_badge: Schema.Literals([0, 1]),
  global_handle_id: Schema.String,
  primary_linked_handle_id: NullableString,
  xmtp_inbox_id: NullableString,
  created_at: Schema.String,
});

const GlobalHandleRow = Schema.Struct({
  global_handle_id: Schema.String,
  label_display: Schema.String,
  status: Schema.Literals(["active", "redirect", "retired"]),
  tier: Schema.Literals(["generated", "standard", "premium"]),
  issuance_source: Schema.Literals([
    "generated_signup",
    "free_cleanup_rename",
    "reddit_verified_claim",
    "paid_upgrade",
    "admin_grant",
  ]),
  redirect_target_global_handle_id: NullableString,
  price_paid_cents: Schema.NullOr(Schema.Number),
  free_rename_consumed: Schema.Literals([0, 1]),
  issued_at: Schema.String,
  replaced_at: NullableString,
});

const LinkedHandleRow = Schema.Struct({
  linked_handle_id: Schema.String,
  kind: Schema.Literals(["pirate", "ens"]),
  label_display: Schema.String,
  verification_state: Schema.Literals(["verified", "unverified", "stale"]),
  metadata_json: NullableString,
});

const WalletAttachmentRow = Schema.Struct({
  wallet_attachment_id: Schema.String,
  chain_namespace: Schema.String,
  wallet_address_display: Schema.String,
  is_primary: Schema.Literals([0, 1]),
});

const Onboarding = SessionExchange.response.fields.onboarding;

export const IdentityAccountDocument = Schema.Struct({
  user: UserRow,
  profile: ProfileRow,
  global_handle: GlobalHandleRow,
  linked_handles: Schema.Array(LinkedHandleRow),
  wallet_attachments: Schema.Array(WalletAttachmentRow),
  onboarding: Onboarding,
});

export type IdentityAccountDocument = Schema.Schema.Type<typeof IdentityAccountDocument>;

export class IdentityAccountInvalid extends Data.TaggedError("IdentityAccountInvalid")<{
  readonly reason: "malformed" | "mismatched-user" | "projection-invalid";
}> {}

export interface IdentityAccountServices {
  readonly identityStore: IdentityStore["Service"];
}

const decodeDocument = (account: unknown): IdentityAccountDocument => {
  try {
    return Schema.decodeUnknownSync(IdentityAccountDocument)(account);
  } catch {
    throw new IdentityAccountInvalid({ reason: "malformed" });
  }
};

const assertIdentity = (identity: IdentityUser, document: IdentityAccountDocument): void => {
  if (
    identity.userId !== document.user.user_id ||
    identity.userId !== document.profile.user_id ||
    document.profile.global_handle_id !== document.global_handle.global_handle_id
  ) {
    throw new IdentityAccountInvalid({ reason: "mismatched-user" });
  }
};

export type ProjectedIdentityAccount = Omit<SessionAccount, "canonicalUserId">;

export function projectIdentityAccount(identity: IdentityUser): ProjectedIdentityAccount {
  try {
    const document = decodeDocument(identity.account);
    assertIdentity(identity, document);

    const user = serializeUserRow(document.user as UserRowInput);
    const wallets = document.wallet_attachments as readonly WalletAttachmentRowInput[];
    const profile = assembleProfile(
      document.profile as ProfileRowInput,
      document.global_handle as GlobalHandleRowInput,
      document.linked_handles as readonly LinkedHandleRowInput[],
      getPrimaryWalletAddressFromRows(document.user.primary_wallet_attachment_id, wallets),
      user,
    );
    const projected = {
      user,
      profile,
      onboarding: document.onboarding,
      wallet_attachments: serializeWalletAttachments(wallets),
    };

    Schema.decodeUnknownSync(GetMyProfile.response)(projected.profile);
    Schema.decodeUnknownSync(SessionExchange.response)({
      access_token: "validation",
      ...projected,
    });
    return projected;
  } catch (error) {
    if (error instanceof IdentityAccountInvalid) throw error;
    throw new IdentityAccountInvalid({ reason: "projection-invalid" });
  }
}

export const loadIdentityAccount = Effect.fn("loadIdentityAccount")(function* (
  userId: string,
  services: IdentityAccountServices,
): Effect.fn.Return<ProjectedIdentityAccount | null, IdentityAccountInvalid | ControlPlaneError> {
  const identity = yield* services.identityStore.findUser(userId);
  if (identity === null) return null;
  return yield* Effect.try({
    try: () => projectIdentityAccount(identity),
    catch: (error) =>
      error instanceof IdentityAccountInvalid
        ? error
        : new IdentityAccountInvalid({ reason: "projection-invalid" }),
  });
});
