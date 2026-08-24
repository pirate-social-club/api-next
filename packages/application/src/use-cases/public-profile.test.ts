import { describe, expect, test } from "bun:test";
import { BadRequest, InternalError, NotFound } from "@pirate/contracts";
import { Effect } from "effect";
import type { PublicProfileLookup, PublicProfileStoreService } from "../ports.ts";
import { getPublicProfileByHandle, normalizePirateHandle } from "./public-profile.ts";

const lookup = (overrides: Partial<PublicProfileLookup> = {}): PublicProfileLookup => ({
  personaId: "persona_public",
  displayName: "Public Captain",
  avatarRef: "https://cdn.test/avatar.png",
  coverRef: null,
  bio: "A public bio",
  preferredLocale: "en",
  createdAt: "2026-08-16T12:00:00.000Z",
  handleId: "handle_public",
  resolvedHandleLabelDisplay: "captainpublic.pirate",
  handleLabelNormalized: "captainpublic",
  handleLabelDisplay: "captainpublic.pirate",
  handleStatus: "active",
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

  test("projects a persona-only body without account-created community leakage", async () => {
    const body = await Effect.runPromise(
      getPublicProfileByHandle(
        { handle: "@CAPTAINPUBLIC.pirate" },
        { publicProfileStore: store(lookup()) },
      ),
    );
    expect(body).toEqual({
      profile: {
        id: "persona_public",
        object: "profile",
        display_name: "Public Captain",
        avatar_ref: "https://cdn.test/avatar.png",
        avatar_source: null,
        cover_ref: null,
        cover_source: null,
        bio: "A public bio",
        bio_source: null,
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
      created_communities: [],
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
          { publicProfileStore: store(lookup({ createdAt: "not-a-date" })) },
        ),
      ),
    );
    expect(malformed).toBeInstanceOf(InternalError);
  });
});
