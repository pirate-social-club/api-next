import { makeOpenAiTextModerationProvider } from "@pirate/platform-cf/openai-text-moderation";
import { makeHyperdriveControlPlaneLayer } from "@pirate/platform-cf/postgres";
import { Schema } from "effect";
import {
  MODERATED_DANCE_CLOUDCONVERT_REVISION,
  makeModeratedDanceCloudConvertProbe,
  makeR2ModeratedDanceProbeSource,
} from "../../../packages/platform-cf/src/moderated-dance-cloudconvert-probe.ts";
import { makeModeratedDanceMaintenance } from "../../../packages/platform-cf/src/moderated-dance-maintenance.ts";
import { makeModeratedDanceMediaRuntime } from "../../../packages/platform-cf/src/moderated-dance-media-runtime.ts";
import { makeModeratedDanceReferenceRuntime } from "../../../packages/platform-cf/src/moderated-dance-reference-runtime.ts";
import { makeSongVideoCloudConvertTransport } from "../../../packages/platform-cf/src/song-video-cloudconvert-transport.ts";

export type ModeratedDanceMediaEnv = Readonly<{
  CONTROL_PLANE?: { connectionString: string };
  MEDIA_INGRESS?: R2Bucket;
  MEDIA_IMMUTABLE_ORIGINALS?: R2Bucket;
  MEDIA_PROCESSING_ENABLED?: string;
  DANCE_MODERATED_PROCESSING_ENABLED?: string;
  OPENAI_MODERATION_ENABLED?: string;
  OPENAI_API_KEY?: string;
  QENCODE_API_KEY?: string;
  CLOUDCONVERT_RENDER_API_KEY?: string;
  VIDEO_SOURCE_GATEWAY_ORIGIN?: string;
  /** Dedicated purpose-separated keyring. No cookie/wallet/signing secret reuse.
   * Every captured compatible epoch must remain available until its accepted
   * retention/disposition completes. Source adds no secret or runtime value. */
  DANCE_MODERATED_REPLAY_KEYS?: string;
}>;
const secret = (value: string | undefined) =>
  value !== undefined && value.trim() === value && value.length >= 8 && value !== "PENDING";
export function makeModeratedDanceMaintenanceProcessor(env: ModeratedDanceMediaEnv) {
  if (
    env.CONTROL_PLANE === undefined ||
    env.MEDIA_INGRESS === undefined ||
    env.MEDIA_IMMUTABLE_ORIGINALS === undefined
  )
    return null;
  return makeModeratedDanceMaintenance({
    runtime: makeHyperdriveControlPlaneLayer(env.CONTROL_PLANE),
    ingress: env.MEDIA_INGRESS,
    originals: env.MEDIA_IMMUTABLE_ORIGINALS,
    provider: secret(env.CLOUDCONVERT_RENDER_API_KEY)
      ? makeSongVideoCloudConvertTransport({
          apiKey: env.CLOUDCONVERT_RENDER_API_KEY ?? "",
          fetch: (url, init) => fetch(url, init),
        })
      : undefined,
  });
}
/** Readiness is announced only by this concrete, fully configured composition.
 * Missing configuration remains unavailable BEFORE consent/upload. No factory
 * creates a role, credential, policy, provider job or network connection. */
export function makeModeratedDanceProcessor(env: ModeratedDanceMediaEnv) {
  if (env.DANCE_MODERATED_PROCESSING_ENABLED !== "true" || env.MEDIA_PROCESSING_ENABLED !== "true")
    return null;
  if (
    env.CONTROL_PLANE === undefined ||
    env.MEDIA_INGRESS === undefined ||
    env.MEDIA_IMMUTABLE_ORIGINALS === undefined ||
    env.OPENAI_MODERATION_ENABLED !== "true" ||
    !secret(env.OPENAI_API_KEY) ||
    !secret(env.CLOUDCONVERT_RENDER_API_KEY) ||
    env.VIDEO_SOURCE_GATEWAY_ORIGIN === undefined ||
    env.DANCE_MODERATED_REPLAY_KEYS === undefined
  )
    return null;
  const encoded = Schema.decodeUnknownSync(
    Schema.Record(Schema.NonEmptyString, Schema.String.check(Schema.isMaxLength(512))),
    { onExcessProperty: "error" },
  )(JSON.parse(env.DANCE_MODERATED_REPLAY_KEYS));
  const keys = new Map<string, Uint8Array>();
  for (const [epoch, value] of Object.entries(encoded)) {
    const key = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
    if (key.length < 32 || key.length > 256) throw new Error("Private replay keyring unavailable");
    keys.set(epoch, key);
  }
  if (keys.size === 0) return null;
  const originals = env.MEDIA_IMMUTABLE_ORIGINALS,
    runtime = makeHyperdriveControlPlaneLayer(env.CONTROL_PLANE);
  // These are supported code revisions, not an operational policy admission.
  // Only a separately admitted immutable profile can select them.
  const transform = makeSongVideoCloudConvertTransport({
    apiKey: env.CLOUDCONVERT_RENDER_API_KEY ?? "",
    fetch: (url, init) => fetch(url, init),
  });
  const reference = makeModeratedDanceReferenceRuntime({
    runtime,
    bucket: originals,
    transform,
    replayKeys: keys,
    gatewayOrigin: env.VIDEO_SOURCE_GATEWAY_ORIGIN,
    runtimeRevision: MODERATED_DANCE_CLOUDCONVERT_REVISION,
  });
  const capture = makeModeratedDanceMediaRuntime({
    runtime,
    ingress: env.MEDIA_INGRESS,
    originals,
    image: makeOpenAiTextModerationProvider({ apiKey: env.OPENAI_API_KEY ?? "" }),
    transform: makeSongVideoCloudConvertTransport({
      apiKey: env.CLOUDCONVERT_RENDER_API_KEY ?? "",
      fetch: (url, init) => fetch(url, init),
    }),
    probeForSource: (_issue, sealed, profile) =>
      makeModeratedDanceCloudConvertProbe({
        apiKey: env.CLOUDCONVERT_RENDER_API_KEY ?? "",
        timeoutSeconds: profile.normalizationTimeoutSeconds,
        readSource: makeR2ModeratedDanceProbeSource(originals, sealed),
      }),
    replayKeys: keys,
    gatewayOrigin: env.VIDEO_SOURCE_GATEWAY_ORIGIN,
    runtimeRevision: MODERATED_DANCE_CLOUDCONVERT_REVISION,
    safetyRevision: "private-three-still-openai-v1",
  });
  return {
    async run() {
      const referenceResult = await reference.run();
      const captureResult = await capture.run();
      return { reference: referenceResult, capture: captureResult };
    },
  };
}
