import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import type { KaraokePlaybackServices } from "@pirate/application/use-cases/content/song-playback";
import { Effect, type Layer } from "effect";
import { readKaraokeReadiness } from "./karaoke-readiness-repository.ts";

export const authorizeKaraokePlayback = Effect.fn("authorizeKaraokePlayback")(function* (
  input: Parameters<KaraokePlaybackServices["authorize"]>[0],
) {
  const db = yield* ControlPlaneDb;
  const ready = yield* readKaraokeReadiness(
    {
      communityId: input.communityId,
      postId: input.postId,
      playbackViewerUserId: input.viewerUserId ?? null,
    },
    db,
  );
  if (
    ready.state !== "ready" ||
    ready.playback_audio.kind !== "instrumental" ||
    ready.karaoke_revision_id !== input.karaokeRevisionId ||
    ready.playback_audio.ref !== input.playbackRef
  )
    return null;
  return {
    postId: ready.post_id,
    communityId: ready.community_id,
    karaokeRevisionId: ready.karaoke_revision_id,
    immutableRef: ready.playback_audio.ref,
  };
});

export function makeKaraokePlaybackAuthority(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): KaraokePlaybackServices["authorize"] {
  return (input) => authorizeKaraokePlayback(input).pipe(Effect.provide(runtime));
}
