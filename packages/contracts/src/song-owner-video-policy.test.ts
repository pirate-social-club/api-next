import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  decodeOpenSongFundingPolicyV2,
  decodeSongOwnerDerivativeVideoPolicyRevisionV2,
  decodeUpdateSongOwnerDerivativeVideoPolicyV2,
  GetPublicSongOwnerPolicy,
  GetSongOwnerPolicy,
  openSongFundingPolicyPreimageV2,
  PublicSongOwnerPolicyV1,
  SongOwnerPolicyManagementV1,
  songOwnerDerivativeVideoPolicyPreimageV2,
  UpdateSongOwnerPolicy,
  UpdateSongOwnerPolicyV1,
} from "./song-owner-video-policy.ts";

const strictDecode = (schema: Schema.Schema<unknown>) =>
  Schema.decodeUnknownSync(schema as unknown as Schema.ConstraintDecoder<unknown>, {
    onExcessProperty: "error",
  });

const management = {
  object: "song_owner_policy",
  community_id: "community-1",
  post_id: "song-1",
  audio_revision: 1,
  owner_account_id: "account-owner",
  policy_revision: 2,
  third_party_reward_legs: "allowed",
  pool_leg: "declined",
  derivative_video: "owner_only",
  policy_hash: "11".repeat(32),
  effective_at: "2026-09-02T12:00:00.000Z",
} as const;

describe("song owner derivative-video policy contracts", () => {
  test("keeps the owner identity in management responses only", () => {
    expect(strictDecode(SongOwnerPolicyManagementV1)(management)).toEqual(management);
    const publicPolicy = {
      object: "song_owner_policy",
      community_id: management.community_id,
      post_id: management.post_id,
      policy_revision: management.policy_revision,
      derivative_video: management.derivative_video,
      can_post_with_song: false,
      video_ready: true,
    } as const;
    expect(strictDecode(PublicSongOwnerPolicyV1)(publicPolicy)).toMatchObject({
      object: "song_owner_policy",
      derivative_video: "owner_only",
      can_post_with_song: false,
      video_ready: true,
    });
    expect(() => strictDecode(PublicSongOwnerPolicyV1)(management)).toThrow();
  });

  test("requires an explicit persona for private reads and updates", () => {
    expect(GetSongOwnerPolicy.request?.query).toBeDefined();
    expect(UpdateSongOwnerPolicy.request?.body).toBeDefined();
    expect(GetSongOwnerPolicy.auth).toEqual({ policy: { kind: "user" } });
    expect(GetPublicSongOwnerPolicy.auth).toEqual({
      policy: { kind: "user" },
      optionalUser: true,
    });
  });
});

const fundingSource = {
  version: "open-song-funding-policy-v2",
  community_id: "community-1",
  post_id: "song-1",
  audio_revision: 1,
  funding_policy_revision: 1,
  open_funding_rule_hash: "aa".repeat(32),
  third_party_reward_legs: "allowed",
  pool_leg: "allowed",
} as const;
const derivativeSource = {
  version: "song-owner-derivative-video-policy-v2",
  community_id: "community-1",
  post_id: "song-1",
  audio_revision: 1,
  owner_account_id: "account-owner",
  derivative_policy_revision: 2,
  derivative_video: "owner_only",
} as const;
// Supplied projection commitments, not hashes computed by this contract slice.
const fundingProjection = { ...fundingSource, funding_policy_hash: "bb".repeat(32) };
const derivativeProjection = { ...derivativeSource, derivative_policy_hash: "cc".repeat(32) };
const derivativeCommand = {
  persona_id: "persona-owner",
  expected_derivative_policy_revision: 2,
  derivative_video: "blocked",
} as const;

describe("unregistered independent Song policy V2 representations", () => {
  test("preserves the historical V1 management wire representation and legacy command choices", () => {
    expect(JSON.stringify(strictDecode(SongOwnerPolicyManagementV1)(management))).toBe(
      '{"object":"song_owner_policy","community_id":"community-1","post_id":"song-1","audio_revision":1,"owner_account_id":"account-owner","policy_revision":2,"third_party_reward_legs":"allowed","pool_leg":"declined","derivative_video":"owner_only","policy_hash":"1111111111111111111111111111111111111111111111111111111111111111","effective_at":"2026-09-02T12:00:00.000Z"}',
    );
    const v1Command = {
      persona_id: "persona-owner",
      expected_policy_revision: 2,
      third_party_reward_legs: "owner_only",
      pool_leg: "declined",
      derivative_video: "blocked",
    };
    expect(strictDecode(UpdateSongOwnerPolicyV1)(v1Command)).toEqual(v1Command);
    expect(UpdateSongOwnerPolicy.request?.body).toBe(UpdateSongOwnerPolicyV1);
    expect(GetSongOwnerPolicy.response).toBe(SongOwnerPolicyManagementV1);
    expect(GetPublicSongOwnerPolicy.response).toBe(PublicSongOwnerPolicyV1);
  });

  test("V2 commands contain only explicit persona, derivative revision and derivative choice", () => {
    expect(decodeUpdateSongOwnerDerivativeVideoPolicyV2(derivativeCommand)).toEqual(
      derivativeCommand,
    );
    for (const derivative_video of ["allowed", "owner_only", "blocked"] as const) {
      expect(
        decodeUpdateSongOwnerDerivativeVideoPolicyV2({ ...derivativeCommand, derivative_video })
          .derivative_video,
      ).toBe(derivative_video);
    }
    for (const extra of [
      { third_party_reward_legs: "owner_only" },
      { third_party_reward_legs: "allowed" },
      { pool_leg: "declined" },
      { pool_leg: "allowed" },
      { funding_policy_revision: 1 },
      { funding_policy_hash: "aa".repeat(32) },
      { open_funding_rule_hash: "aa".repeat(32) },
      { expected_policy_revision: 2 },
      { ignored: true },
    ])
      expect(() =>
        decodeUpdateSongOwnerDerivativeVideoPolicyV2({ ...derivativeCommand, ...extra }),
      ).toThrow();
  });

  test("missing or malformed command inputs do not acquire defaults", () => {
    for (const key of Object.keys(derivativeCommand)) {
      const missing: Record<string, unknown> = { ...derivativeCommand };
      delete missing[key];
      expect(() => decodeUpdateSongOwnerDerivativeVideoPolicyV2(missing)).toThrow();
      expect(() =>
        decodeUpdateSongOwnerDerivativeVideoPolicyV2({ ...derivativeCommand, [key]: null }),
      ).toThrow();
    }
    for (const persona_id of [
      "",
      " persona",
      "persona ",
      "bad\u0000id",
      "bad\u007fid",
      "a".repeat(129),
    ])
      expect(() =>
        decodeUpdateSongOwnerDerivativeVideoPolicyV2({ ...derivativeCommand, persona_id }),
      ).toThrow();
    for (const expected_derivative_policy_revision of [
      0,
      -1,
      1.5,
      "2",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      expect(() =>
        decodeUpdateSongOwnerDerivativeVideoPolicyV2({
          ...derivativeCommand,
          expected_derivative_policy_revision,
        }),
      ).toThrow();
    expect(() =>
      decodeUpdateSongOwnerDerivativeVideoPolicyV2({
        ...derivativeCommand,
        derivative_video: "declined",
      }),
    ).toThrow();
  });

  test("projections require explicit versions, revisions and hashes and reject cross-policy fields", () => {
    expect(decodeOpenSongFundingPolicyV2(fundingProjection)).toEqual(fundingProjection);
    expect(decodeSongOwnerDerivativeVideoPolicyRevisionV2(derivativeProjection)).toEqual(
      derivativeProjection,
    );
    for (const [decode, projection, fields] of [
      [
        decodeOpenSongFundingPolicyV2,
        fundingProjection,
        ["version", "funding_policy_revision", "open_funding_rule_hash", "funding_policy_hash"],
      ],
      [
        decodeSongOwnerDerivativeVideoPolicyRevisionV2,
        derivativeProjection,
        ["version", "derivative_policy_revision", "derivative_policy_hash"],
      ],
    ] as const) {
      for (const key of fields) {
        const missing: Record<string, unknown> = { ...projection };
        delete missing[key];
        expect(() => decode(missing)).toThrow();
        expect(() => decode({ ...projection, [key]: null })).toThrow();
      }
      expect(() => decode({ ...projection, unknown: true })).toThrow();
    }
    expect(() =>
      decodeOpenSongFundingPolicyV2({ ...fundingProjection, derivative_video: "allowed" }),
    ).toThrow();
    expect(() =>
      decodeSongOwnerDerivativeVideoPolicyRevisionV2({
        ...derivativeProjection,
        pool_leg: "allowed",
      }),
    ).toThrow();
    expect(() =>
      decodeOpenSongFundingPolicyV2({
        ...fundingProjection,
        third_party_reward_legs: "owner_only",
      }),
    ).toThrow();
    expect(() =>
      decodeOpenSongFundingPolicyV2({ ...fundingProjection, pool_leg: "declined" }),
    ).toThrow();
  });

  test("canonical preimages have independent domains and fixed exact V2 tuple ordering", () => {
    const funding = openSongFundingPolicyPreimageV2(fundingSource);
    const derivative = songOwnerDerivativeVideoPolicyPreimageV2(derivativeSource);
    expect(funding).toBe(
      '["pirate.open-song-funding-policy.v2",["community-1","song-1",1,"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","allowed","allowed"]]',
    );
    expect(derivative).toBe(
      '["pirate.song-owner-derivative-video-policy.v2",["community-1","song-1",1,"account-owner",2,"owner_only"]]',
    );
    expect(
      openSongFundingPolicyPreimageV2(Object.fromEntries(Object.entries(fundingSource).reverse())),
    ).toBe(funding);
    expect(
      songOwnerDerivativeVideoPolicyPreimageV2(
        Object.fromEntries(Object.entries(derivativeSource).reverse()),
      ),
    ).toBe(derivative);
    expect(funding).not.toBe(derivative);
  });

  test("a derivative edit changes only its own identity and cannot enter the funding preimage", () => {
    const beforeFunding = openSongFundingPolicyPreimageV2(fundingSource);
    const beforeDerivative = songOwnerDerivativeVideoPolicyPreimageV2(derivativeSource);
    const edited = {
      ...derivativeSource,
      derivative_policy_revision: 3,
      derivative_video: "blocked",
    };
    expect(songOwnerDerivativeVideoPolicyPreimageV2(edited)).not.toBe(beforeDerivative);
    expect(openSongFundingPolicyPreimageV2(fundingSource)).toBe(beforeFunding);
    expect(() =>
      openSongFundingPolicyPreimageV2({ ...fundingSource, derivative_policy_revision: 3 }),
    ).toThrow();
    expect(() =>
      openSongFundingPolicyPreimageV2({ ...fundingSource, derivative_video: "blocked" }),
    ).toThrow();
    expect(
      openSongFundingPolicyPreimageV2({
        ...fundingSource,
        open_funding_rule_hash: "dd".repeat(32),
      }),
    ).not.toBe(beforeFunding);
    expect(songOwnerDerivativeVideoPolicyPreimageV2(derivativeSource)).toBe(beforeDerivative);
  });

  test("preimages require version/revision/input commitment and refuse output hashes instead of hashing themselves", () => {
    for (const [preimage, source, fields] of [
      [
        openSongFundingPolicyPreimageV2,
        fundingSource,
        ["version", "funding_policy_revision", "open_funding_rule_hash"],
      ],
      [
        songOwnerDerivativeVideoPolicyPreimageV2,
        derivativeSource,
        ["version", "derivative_policy_revision", "owner_account_id"],
      ],
    ] as const) {
      for (const key of fields) {
        const missing: Record<string, unknown> = { ...source };
        delete missing[key];
        expect(() => preimage(missing)).toThrow();
      }
      expect(() => preimage({ ...source, version: "song-owner-policy-v1" })).toThrow();
    }
    expect(() => openSongFundingPolicyPreimageV2(fundingProjection)).toThrow();
    expect(() => songOwnerDerivativeVideoPolicyPreimageV2(derivativeProjection)).toThrow();
  });

  test("target identifiers, audio/revision evidence and all hashes remain bounded and canonical", () => {
    for (const invalid of ["", " bad", "bad ", "bad\u0000id", "bad\u0080id", "a".repeat(129)]) {
      expect(() =>
        decodeOpenSongFundingPolicyV2({ ...fundingProjection, community_id: invalid }),
      ).toThrow();
      expect(() =>
        decodeOpenSongFundingPolicyV2({ ...fundingProjection, post_id: invalid }),
      ).toThrow();
      expect(() =>
        decodeSongOwnerDerivativeVideoPolicyRevisionV2({
          ...derivativeProjection,
          owner_account_id: invalid,
        }),
      ).toThrow();
    }
    for (const revision of [
      0,
      -1,
      1.1,
      "1",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() =>
        decodeOpenSongFundingPolicyV2({ ...fundingProjection, audio_revision: revision }),
      ).toThrow();
      expect(() =>
        decodeOpenSongFundingPolicyV2({ ...fundingProjection, funding_policy_revision: revision }),
      ).toThrow();
      expect(() =>
        decodeSongOwnerDerivativeVideoPolicyRevisionV2({
          ...derivativeProjection,
          derivative_policy_revision: revision,
        }),
      ).toThrow();
    }
    for (const hash of ["", "ab", "g".repeat(64), "A".repeat(64), "a".repeat(65)]) {
      expect(() =>
        decodeOpenSongFundingPolicyV2({ ...fundingProjection, funding_policy_hash: hash }),
      ).toThrow();
      expect(() =>
        openSongFundingPolicyPreimageV2({ ...fundingSource, open_funding_rule_hash: hash }),
      ).toThrow();
      expect(() =>
        decodeSongOwnerDerivativeVideoPolicyRevisionV2({
          ...derivativeProjection,
          derivative_policy_hash: hash,
        }),
      ).toThrow();
    }
  });

  test("canonicalization keeps explicit Unicode identities without adding normalization or actor defaults", () => {
    const unicode = { ...fundingSource, community_id: "community-海", post_id: "cafe\u0301" };
    expect(openSongFundingPolicyPreimageV2(unicode)).toBe(
      '["pirate.open-song-funding-policy.v2",["community-海","café",1,"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","allowed","allowed"]]',
    );
    expect(openSongFundingPolicyPreimageV2({ ...unicode, post_id: "café" })).not.toBe(
      openSongFundingPolicyPreimageV2(unicode),
    );
    expect(() =>
      songOwnerDerivativeVideoPolicyPreimageV2({
        ...derivativeSource,
        owner_account_id: undefined,
      }),
    ).toThrow();
  });
});
