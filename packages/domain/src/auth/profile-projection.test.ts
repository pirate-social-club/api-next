import { describe, expect, test } from "bun:test";
import { GetCurrentUser, GetMyProfile, SessionExchange } from "@pirate/contracts";
import { Schema } from "effect";
import {
  assembleProfile,
  type GlobalHandleRowInput,
  getPrimaryWalletAddressFromRows,
  getProfilePublicHandleLabel,
  getProfilePublicHandleStem,
  type LegacyUserInput,
  type LinkedHandleRowInput,
  type ProfileRowInput,
  publicId,
  serializeUser,
  serializeUserRow,
  serializeWalletAttachments,
  type UserRowInput,
  type VerificationCapabilitiesResponse,
  type WalletAttachmentRowInput,
} from "./profile-projection.ts";

const globalHandle: GlobalHandleRowInput = {
  global_handle_id: "gh_123",
  label_display: "captain.pirate",
  status: "active",
  tier: "standard",
  issuance_source: "generated_signup",
  redirect_target_global_handle_id: null,
  price_paid_cents: null,
  free_rename_consumed: 0,
  issued_at: "2026-08-01T00:00:00.999Z",
  replaced_at: null,
};

const profileRow: ProfileRowInput = {
  user_id: "usr_usr_profile",
  display_name: "Captain",
  bio: "Sails the feed",
  bio_source: "manual",
  avatar_ref: "avatar_1",
  avatar_source: "upload",
  cover_ref: null,
  cover_source: "none",
  preferred_locale: "en",
  display_verified_nationality_badge: 1,
  global_handle_id: "gh_123",
  primary_linked_handle_id: "ens_1",
  xmtp_inbox_id: "inbox_1",
  created_at: "2026-08-01T00:00:01.999Z",
};

const linkedHandles: readonly LinkedHandleRowInput[] = [
  {
    linked_handle_id: "ens_1",
    kind: "ens",
    label_display: "captain.eth",
    verification_state: "verified",
    metadata_json: '{"avatar":"ipfs://avatar","header":null}',
  },
  {
    linked_handle_id: "ens_2",
    kind: "ens",
    label_display: "second.eth",
    verification_state: "stale",
    metadata_json: "[]",
  },
];

const walletRows: readonly WalletAttachmentRowInput[] = [
  {
    wallet_attachment_id: "wallet_secondary",
    chain_namespace: "eip155:1",
    wallet_address_display: "0xsecondary",
    is_primary: 1,
  },
  {
    wallet_attachment_id: "wallet_selected",
    chain_namespace: "eip155:8453",
    wallet_address_display: "0xselected",
    is_primary: 0,
  },
];

function capabilities(
  overrides: Partial<VerificationCapabilitiesResponse> = {},
): VerificationCapabilitiesResponse {
  return {
    unique_human: {
      state: "verified" as const,
      provider: "self" as const,
      proof_type: "unique_human",
      mechanism: "self-attestation",
      verified_at: 1_786_320_000,
    },
    age_over_18: {
      state: "unverified" as const,
      provider: null,
      proof_type: null,
      mechanism: null,
      verified_at: null,
    },
    minimum_age: {
      state: "unverified" as const,
      value: null,
      provider: null,
      proof_type: null,
      mechanism: null,
      verified_at: null,
    },
    nationality: {
      state: "verified" as const,
      value: "USA",
      provider: "self" as const,
      proof_type: "nationality",
      mechanism: "self-attestation",
      verified_at: 1_786_320_000,
    },
    gender: {
      state: "unverified" as const,
      value: null,
      provider: null,
      proof_type: null,
      mechanism: null,
      verified_at: null,
    },
    wallet_score: {
      state: "unverified" as const,
      provider: null,
      proof_type: null,
      mechanism: null,
      verified_at: null,
      score_decimal: null,
      score_threshold_decimal: null,
      passing_score: null,
      last_scored_at: null,
      expires_at: null,
      stamps: null,
    },
    ...overrides,
  };
}

function legacyUser(overrides: Partial<LegacyUserInput> = {}): LegacyUserInput {
  return {
    user_id: "usr_usr_user",
    community_posting_state: {
      community_ref: "home",
      community_id: "cmt_1",
      has_created_text_post: true,
    },
    primary_wallet_attachment_id: "wallet_1",
    verification_state: "verified",
    capability_provider: "self",
    verification_capabilities: capabilities(),
    verified_at: "2026-08-10T00:00:01.999Z",
    created_at: "2026-08-01T00:00:01.999Z",
    ...overrides,
  };
}

function row(overrides: Partial<UserRowInput> = {}): UserRowInput {
  return {
    user_id: "usr_usr_row",
    primary_wallet_attachment_id: "wallet_1",
    capability_provider: "zkpass",
    verification_capabilities_json: JSON.stringify(capabilities()),
    verified_at: "2026-08-10T00:00:01.999Z",
    created_at: "2026-08-01T00:00:01.999Z",
    ...overrides,
  };
}

describe("profile and identity projections", () => {
  test("keeps user serializer public ids, community mapping, and timestamp flooring", () => {
    const result = serializeUser(legacyUser());
    expect(result).toMatchObject({
      id: "usr_user",
      object: "user",
      community_posting_state: {
        community_ref: "home",
        community: "com_cmt_1",
        has_created_text_post: true,
      },
      verified_at: Math.floor(Date.parse("2026-08-10T00:00:01.999Z") / 1000),
    });
    expect(result.created).toBe(Math.floor(Date.parse("2026-08-01T00:00:01.999Z") / 1000));
    expect(JSON.stringify(serializeUser(legacyUser({ community_posting_state: null })))).toContain(
      '"community_posting_state":null',
    );
  });

  test("maps database rows through old verification defaults and provider aliases", () => {
    const result = serializeUserRow(row());
    expect(result).toMatchObject({
      id: "usr_row",
      primary_wallet_attachment: "wallet_1",
      capability_provider: "zkpassport",
      verification_state: "verified",
      created: Math.floor(Date.parse("2026-08-01T00:00:01.999Z") / 1000),
      verified_at: Math.floor(Date.parse("2026-08-10T00:00:01.999Z") / 1000),
    });
    expect(
      serializeUserRow(row({ verification_capabilities_json: "not-json" })).verification_state,
    ).toBe("unverified");
    expect(
      serializeUserRow(row({ capability_provider: "passport" })).capability_provider,
    ).toBeNull();
  });

  test("normalizes old-wire capability timestamps and fails closed for malformed strings", () => {
    const baseline = capabilities();
    const oldWireCapabilities = {
      ...baseline,
      unique_human: {
        ...baseline.unique_human,
        verified_at: "2026-08-10T00:00:01.999Z",
      },
      nationality: {
        ...baseline.nationality,
        verified_at: "not-a-timestamp",
      },
    };

    const result = serializeUserRow(
      row({ verification_capabilities_json: JSON.stringify(oldWireCapabilities) }),
    );

    expect(result.verification_capabilities.unique_human.verified_at).toBe(
      Math.floor(Date.parse("2026-08-10T00:00:01.999Z") / 1000),
    );
    expect(result.verification_capabilities.nationality.verified_at).toBeNull();
    expect(Number.isNaN(result.verification_capabilities.nationality.verified_at ?? 0)).toBeFalse();
  });

  test("assembles the profile with old ordering, badge policy, handle ids, and defaults", () => {
    const user = serializeUserRow(row());
    const result = assembleProfile(profileRow, globalHandle, linkedHandles, "0xprimary", user);
    expect(result).toMatchObject({
      id: "usr_profile",
      object: "profile",
      display_verified_nationality_badge: true,
      nationality_badge_country: "US",
      primary_public_handle: {
        linked_handle: "ens_1",
        label: "captain.eth",
      },
      primary_wallet_address: "0xprimary",
      global_handle: {
        id: "gh_gh_123",
        issued_at: Math.floor(Date.parse("2026-08-01T00:00:00.999Z") / 1000),
      },
    });
    expect(result.linked_handles).toEqual([
      {
        linked_handle: "global:gh_123",
        label: "captain.pirate",
        kind: "pirate",
        verification_state: "verified",
      },
      {
        linked_handle: "ens_1",
        label: "captain.eth",
        kind: "ens",
        metadata: { avatar: "ipfs://avatar", header: null },
        verification_state: "verified",
      },
      {
        linked_handle: "ens_2",
        label: "second.eth",
        kind: "ens",
        metadata: null,
        verification_state: "stale",
      },
    ]);
    expect(assembleProfile(profileRow, globalHandle, [], null, null)).toMatchObject({
      display_verified_nationality_badge: true,
      nationality_badge_country: null,
      primary_public_handle: null,
      primary_wallet_address: null,
    });
  });

  test("selects the requested primary wallet before the is_primary fallback", () => {
    expect(getPrimaryWalletAddressFromRows("wallet_selected", walletRows)).toBe("0xselected");
    expect(getPrimaryWalletAddressFromRows("missing", walletRows)).toBe("0xsecondary");
    expect(getPrimaryWalletAddressFromRows(null, walletRows)).toBe("0xsecondary");
    expect(getPrimaryWalletAddressFromRows(null, [])).toBeNull();
    expect(serializeWalletAttachments(walletRows)).toEqual([
      {
        wallet_attachment: "wallet_secondary",
        chain_namespace: "eip155:1",
        wallet_address: "0xsecondary",
        is_primary: true,
      },
      {
        wallet_attachment: "wallet_selected",
        chain_namespace: "eip155:8453",
        wallet_address: "0xselected",
        is_primary: false,
      },
    ]);
  });

  test("keeps old public-handle fallback and stem trimming", () => {
    const profile = assembleProfile(profileRow, globalHandle, linkedHandles);
    expect(getProfilePublicHandleLabel(profile)).toBe("captain.eth");
    expect(getProfilePublicHandleStem(profile)).toBe("captain.eth");
    const fallback = assembleProfile(
      { ...profileRow, primary_linked_handle_id: null },
      globalHandle,
    );
    expect(getProfilePublicHandleLabel(fallback)).toBe("captain.pirate");
    expect(getProfilePublicHandleStem(fallback)).toBe("captain");
  });

  test("type-checks projections against all v1 consumers", () => {
    const user: Schema.Schema.Type<typeof GetCurrentUser.response> = serializeUserRow(row());
    const profile: Schema.Schema.Type<typeof GetMyProfile.response> = assembleProfile(
      profileRow,
      globalHandle,
      linkedHandles,
      "0xprimary",
      user,
    );
    const session: Schema.Schema.Type<typeof SessionExchange.response> = {
      user,
      profile,
      onboarding: {
        generated_handle_assigned: true,
        cleanup_rename_available: false,
        unique_human_verification_status: "verified",
        namespace_verification_status: "not_started",
        community_creation_ready: true,
        missing_requirements: [],
        reddit_verification_status: "not_started",
        reddit_import_status: "not_started",
      },
      wallet_attachments: serializeWalletAttachments(walletRows),
    };
    expect(Schema.decodeUnknownSync(GetCurrentUser.response)(user)).toEqual(user);
    expect(Schema.decodeUnknownSync(GetMyProfile.response)(profile)).toEqual(profile);
    expect(Schema.decodeUnknownSync(SessionExchange.response)(session)).toEqual(session);
    expect(session.user.id).toBe(user.id);
    expect(session.profile.id).toBe(profile.id);
  });

  test("keeps public-id normalization limited to the old user family", () => {
    expect(publicId(" usr_usr_123 ", "usr")).toBe("usr_123");
    expect(publicId("global_123", "global")).toBe("global_global_123");
  });
});
