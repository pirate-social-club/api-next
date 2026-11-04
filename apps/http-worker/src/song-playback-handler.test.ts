import { expect, test } from "bun:test";
import type { KaraokePlaybackServices } from "@pirate/application/use-cases/content/song-playback";
import { CreateKaraokePlaybackAccess } from "@pirate/contracts";
import { Effect, Schema } from "effect";
import { makeKaraokePlaybackHandler } from "./song-playback-handler.ts";
import type { DecodedRequest } from "./transport.ts";

function fixture() {
  const calls: string[] = [];
  const services: KaraokePlaybackServices = {
    nowMs: Effect.succeed(1_000_000),
    limit: ({ source }) =>
      Effect.sync(() => {
        calls.push(`limit:${source}`);
        return { allowed: true, retryAfterSeconds: 0 };
      }),
    authorize: (input) =>
      Effect.sync(() => {
        calls.push(`authorize:${input.viewerUserId ?? "anonymous"}`);
        expect(input).toMatchObject({
          postId: "post",
          communityId: "community",
          karaokeRevisionId: "revision",
          playbackRef: "media://immutable/instrumental",
        });
        return {
          postId: "post",
          communityId: "community",
          karaokeRevisionId: "revision",
          immutableRef: "media://immutable/instrumental",
        };
      }),
    sign: ({ immutableRef }) =>
      Effect.sync(() => {
        calls.push(`sign:${immutableRef}`);
        return "https://audio.example.test/signed";
      }),
  };
  const request: DecodedRequest = {
    principal: null,
    params: { postId: "post" },
    body: {
      community_id: "community",
      karaoke_revision_id: "revision",
      playback_ref: "media://immutable/instrumental",
    },
    query: {},
    edgeClientIp: "198.51.100.1",
  };
  return { handler: makeKaraokePlaybackHandler(services), request, calls };
}

test("Karaoke handler binds declared source fields and returns private no-store on initial and renewal", async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) {
    const result = await f.handler(f.request);
    expect(result.status).toBe(200);
    expect(new Headers(result.responseHeaders).get("cache-control")).toBe("private, no-store");
    const body = Schema.decodeUnknownSync(CreateKaraokePlaybackAccess.response)(result.body);
    expect(body).toMatchObject({
      kind: "instrumental",
      post_id: "post",
      community_id: "community",
      karaoke_revision_id: "revision",
      playback_audio: { kind: "instrumental", ref: "media://immutable/instrumental" },
      expires_at: 1900,
      renew_after: 1840,
    });
  }
  expect(f.calls).toEqual([
    "limit:198.51.100.1",
    "authorize:anonymous",
    "sign:media://immutable/instrumental",
    "limit:198.51.100.1",
    "authorize:anonymous",
    "sign:media://immutable/instrumental",
  ]);
});

test("missing or malformed target fields cannot reach the authority or signer", async () => {
  const f = fixture();
  for (const body of [
    undefined,
    {},
    { community_id: "community", karaoke_revision_id: "revision" },
    { community_id: "community", karaoke_revision_id: "revision", playback_ref: " " },
    { community_id: "community", karaoke_revision_id: "revision", playback_ref: "ref\u0000tail" },
  ])
    await expect(f.handler({ ...f.request, body })).rejects.toThrow();
  expect(f.calls).toEqual([]);
});

test("machine principals and untrusted forwarding headers cannot authorize a Karaoke grant", async () => {
  const f = fixture();
  for (const kind of ["agent", "device"] as const) {
    await expect(
      f.handler({ ...f.request, principal: { kind, subject: "machine" } }),
    ).rejects.toThrow("Authorization failed");
  }
  const { edgeClientIp: _, ...withoutEdge } = f.request;
  await expect(
    f.handler({ ...withoutEdge, headers: { "x-forwarded-for": "198.51.100.1" } }),
  ).rejects.toThrow("Song playback unavailable");
  expect(f.calls).toEqual([]);
});
