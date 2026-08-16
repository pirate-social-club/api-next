import { describe, expect, test } from "bun:test";
import { BadRequest, InternalError, NotFound } from "@pirate/contracts";
import { Effect } from "effect";
import type { PublicProfileLookup, PublicProfileStoreService } from "../ports.ts";
import { getPublicProfileByHandle, normalizePirateHandle } from "./public-profile.ts";

const account = (userId = "usr_public", label = "captainpublic.pirate") => ({
  user: {
    user_id: userId,
    primary_wallet_attachment_id: null,
    capability_provider: null,
    verification_capabilities_json: null,
    verified_at: null,
    created_at: "2026-08-16T12:00:00.000Z",
  },
  profile: {
    user_id: userId,
    display_name: "Public Captain",
    bio: "A public bio",
    bio_source: "manual",
    avatar_ref: "https://cdn.test/avatar.png",
    avatar_source: "upload",
    cover_ref: null,
    cover_source: "none",
    preferred_locale: "en",
    display_verified_nationality_badge: 0,
    global_handle_id: "handle_public",
    primary_linked_handle_id: null,
    xmtp_inbox_id: "secret-xmtp",
    created_at: "2026-08-16T12:00:00.000Z",
  },
  global_handle: {
    global_handle_id: "handle_public",
    label_display: label,
    status: "active",
    tier: "standard",
    issuance_source: "generated_signup",
    redirect_target_global_handle_id: null,
    price_paid_cents: null,
    free_rename_consumed: 0,
    issued_at: "2026-08-16T12:00:00.000Z",
    replaced_at: null,
  },
  linked_handles: [],
  wallet_attachments: [],
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
});

const lookup = (overrides: Partial<PublicProfileLookup> = {}): PublicProfileLookup => ({
  account: account(),
  canonicalUserId: "usr_public",
  handleId: "handle_public",
  handleLabelNormalized: "captainpublic",
  handleLabelDisplay: "captainpublic.pirate",
  handleStatus: "active",
  createdCommunities: [
    {
      community: "community-beta",
      display_name: "Beta Club",
      created: 1_776_000_000,
      route_slug: null,
    },
  ],
  ...overrides,
});

function store(result: PublicProfileLookup | null): PublicProfileStoreService {
  return { getByHandle: () => Effect.succeed(result) };
}

describe("public profile by Pirate handle", () => {
  test("normalizes only ASCII Pirate forms and rejects ENS/Unicode/input controls", () => {
    expect(normalizePirateHandle("  @@@CaptainPublic.PIRATE ")).toEqual({
      stem: "captainpublic",
      labelDisplay: "captainpublic.pirate",
    });
    for (const value of [
      "",
      "@",
      "captain.eth",
      "café",
      "captain.pirate.pirate",
      "captain\u0000",
      "\tcaptain",
      "captain\n",
      "captain\u00a0",
    ]) {
      expect(() => normalizePirateHandle(value)).toThrow(BadRequest);
    }
  });

  test("projects a dedicated narrow body and includes real creator communities", async () => {
    const body = await Effect.runPromise(
      getPublicProfileByHandle(
        { handle: "@CAPTAINPUBLIC.pirate" },
        { publicProfileStore: store(lookup()) },
      ),
    );
    expect(body).toEqual({
      profile: {
        id: "usr_public",
        object: "profile",
        display_name: "Public Captain",
        avatar_ref: "https://cdn.test/avatar.png",
        avatar_source: "upload",
        cover_ref: null,
        cover_source: "none",
        bio: "A public bio",
        bio_source: "manual",
        preferred_locale: "en",
        global_handle: {
          id: "gh_handle_public",
          object: "global_handle",
          label: "captainpublic.pirate",
          status: "active",
        },
        created: 1_786_881_600,
      },
      requested_handle_label: "captainpublic.pirate",
      resolved_handle_label: "captainpublic.pirate",
      is_canonical: true,
      created_communities: [
        {
          community: "community-beta",
          display_name: "Beta Club",
          created: 1_776_000_000,
          route_slug: null,
        },
      ],
    });
    const forbidden = [
      "primary_wallet_address",
      "xmtp_inbox",
      "is_bookable",
      "verification_capabilities",
      "nationality_badge_country",
      "activity",
      "follower_count",
      "media",
    ];
    for (const field of forbidden) expect(JSON.stringify(body)).not.toContain(field);
  });

  test("redirect labels resolve the same body shape but are not canonical", async () => {
    const body = await Effect.runPromise(
      getPublicProfileByHandle(
        { handle: "oldcaptain" },
        {
          publicProfileStore: store(
            lookup({ handleStatus: "redirect", handleLabelDisplay: "oldcaptain.pirate" }),
          ),
        },
      ),
    );
    expect(body.is_canonical).toBe(false);
    expect(body.requested_handle_label).toBe("oldcaptain.pirate");
    expect(body.resolved_handle_label).toBe("captainpublic.pirate");
  });

  test("maps absence to not_found and projection corruption to redacted internal_error", async () => {
    const missing = await Effect.runPromise(
      Effect.flip(
        getPublicProfileByHandle({ handle: "missing" }, { publicProfileStore: store(null) }),
      ),
    );
    expect(missing).toBeInstanceOf(NotFound);

    const malformed = await Effect.runPromise(
      Effect.flip(
        getPublicProfileByHandle(
          { handle: "captainpublic" },
          { publicProfileStore: store(lookup({ account: {} })) },
        ),
      ),
    );
    expect(malformed).toBeInstanceOf(InternalError);
  });
});
