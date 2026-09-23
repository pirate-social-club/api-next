/**
 * Local rehearsal only. Recreates on a disposable database the staging
 * preconditions the qualification relies on: a public published song with no
 * canonical timing, whose author is an active member with an active persona
 * in an active community. Never run against staging.
 */
import { Client } from "pg";
import { insertActiveCommunityMembershipFixture } from "../packages/platform-cf/src/community-follow.pg-fixture.ts";
import {
  community,
  seedPublishedSongFixture,
  seedSongOwner,
  seedVideoActors,
  songOwner,
  songOwnerPersona,
} from "../packages/platform-cf/src/video-publication.pg-fixture.ts";

const url = process.env.QUAL_DATABASE_URL;
if (!url || !/127\.0\.0\.1|localhost/u.test(url)) throw new Error("rehearsal seed runs only against a local database");
const [songPostId, audioAssetRef, sha256] = process.argv.slice(2);
if (!songPostId || !audioAssetRef || !sha256) throw new Error("usage: rehearsal-seed.ts <song-post> <asset-ref> <sha256>");
const admin = new Client({ connectionString: url });
await admin.connect();
try {
  await admin.query("SET search_path TO api_next");
  await seedVideoActors(admin);
  await seedSongOwner(admin);
  await insertActiveCommunityMembershipFixture(admin, {
    communityId: community,
    membershipId: "membership-rehearsal-song-owner",
    userId: songOwner,
  });
  await admin.query(
    `INSERT INTO persona_community_bindings (persona_id,account_id,community_id,binding_source)
     VALUES ($1,$2,$3,'persona_creation')`,
    [songOwnerPersona, songOwner, community],
  );
  await seedPublishedSongFixture(admin, {
    songPostId,
    communityId: community,
    audioAssetRef,
    canonicalAudioSha256: sha256,
    durationSamples: null,
    title: "Rehearsal song",
    contentRating: "general",
    derivativeVideo: "allowed",
    licensePreset: "commercial-remix",
    commercialRemixShareBps: 1_000,
  });
  console.log(JSON.stringify({ seeded: { songPostId, community, author: songOwner } }));
} finally {
  await admin.end();
}
