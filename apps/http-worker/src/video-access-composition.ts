import type { ControlPlaneDb, ControlPlaneError } from "@pirate/application";
import { InternalError } from "@pirate/contracts";
import { makeControlPlaneContentStore } from "@pirate/platform-cf/content-repository";
import { Effect, type Layer } from "effect";
import { makeVideoPublicationAuthorization } from "../../../packages/platform-cf/src/video-access-authorization.ts";
import { makeVideoPlaybackAuthority } from "../../../packages/platform-cf/src/video-playback-authority.ts";
import { loadVideoPlaybackSecurity } from "../../../packages/platform-cf/src/video-playback-security.ts";
import { makeVideoPosterAuthority } from "../../../packages/platform-cf/src/video-poster-authority.ts";
import type { VideoPosterStreamServices } from "../../../packages/platform-cf/src/video-poster-stream.ts";
import { makeVideoPlaybackHandler } from "./video-playback-handler.ts";
import { makeVideoPosterHandler } from "./video-poster-handler.ts";

type Security = Parameters<typeof loadVideoPlaybackSecurity>[0];
export interface VideoAccessBindings {
  readonly VIDEO_DELIVERY_ENABLED?: string;
  readonly VIDEO_STREAM_CUSTOMER_HOST?: string;
  readonly VIDEO_STREAM_SIGNING_KEY_ID?: string;
  readonly VIDEO_STREAM_SIGNING_JWK_BASE64?: string;
  readonly VIDEO_PLAYBACK_SOURCE_HMAC_BASE64?: string;
  readonly VIDEO_PLAYBACK_RATE_LIMITER?: Security["namespace"];
  readonly MEDIA_DERIVED?: VideoPosterStreamServices["bucket"];
}

export async function makeVideoAccessHandlers(
  bindings: VideoAccessBindings,
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
) {
  if (bindings.VIDEO_DELIVERY_ENABLED !== "true") {
    const unavailable = () => {
      throw new InternalError({ message: "Video delivery unavailable" });
    };
    return { GetVideoPoster: unavailable, CreateVideoPlaybackAccess: unavailable };
  }
  if (bindings.MEDIA_DERIVED === undefined)
    throw new Error("MEDIA_DERIVED binding is required for video delivery");
  const security = await loadVideoPlaybackSecurity({
    ...(bindings.VIDEO_STREAM_CUSTOMER_HOST === undefined
      ? {}
      : { customerHost: bindings.VIDEO_STREAM_CUSTOMER_HOST }),
    ...(bindings.VIDEO_STREAM_SIGNING_KEY_ID === undefined
      ? {}
      : { signingKeyId: bindings.VIDEO_STREAM_SIGNING_KEY_ID }),
    ...(bindings.VIDEO_STREAM_SIGNING_JWK_BASE64 === undefined
      ? {}
      : { signingJwkBase64: bindings.VIDEO_STREAM_SIGNING_JWK_BASE64 }),
    ...(bindings.VIDEO_PLAYBACK_SOURCE_HMAC_BASE64 === undefined
      ? {}
      : { sourceHmacBase64: bindings.VIDEO_PLAYBACK_SOURCE_HMAC_BASE64 }),
    ...(bindings.VIDEO_PLAYBACK_RATE_LIMITER === undefined
      ? {}
      : { namespace: bindings.VIDEO_PLAYBACK_RATE_LIMITER }),
    nowSeconds: () => Math.floor(Date.now() / 1000),
  });
  const authorization = {
    contentStore: makeControlPlaneContentStore(runtime),
    authorizePublication: makeVideoPublicationAuthorization(runtime),
  };
  return {
    GetVideoPoster: makeVideoPosterHandler({
      ...authorization,
      bucket: bindings.MEDIA_DERIVED,
      resolveArtifact: makeVideoPosterAuthority(runtime),
    }),
    CreateVideoPlaybackAccess: makeVideoPlaybackHandler({
      ...authorization,
      ...security,
      nowMs: Effect.sync(Date.now),
      resolveApprovedPlayback: makeVideoPlaybackAuthority(runtime),
    }),
  };
}
