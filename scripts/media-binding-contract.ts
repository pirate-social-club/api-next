import type { MediaProcessorRuntimeEnv } from "../apps/media-processor-worker/src/composition.ts";
import type { ModeratedDanceMediaEnv } from "../apps/media-processor-worker/src/moderated-dance-composition.ts";

export const MEDIA_BINDING_KINDS = {
  CONTROL_PLANE: "platform",
  MEDIA_PROCESSING_ENABLED: "var",
  DANCE_MODERATED_PROCESSING_ENABLED: "var",
  DANCE_MODERATED_REPLAY_KEYS: "secret",
  MEDIA_INGRESS: "platform",
  SONG_SOURCE_RECORDING_ENABLED: "var",
  SONG_VIDEO_PCM_ADMISSION_ENABLED: "var",
  VIDEO_ANALYSIS_ENABLED: "var",
  VIDEO_DELIVERY_ENABLED: "var",
  VIDEO_CLOUDCONVERT_RENDER_ENABLED: "var",
  CLOUDCONVERT_RENDER_API_KEY: "secret",
  VIDEO_STREAM_API_TOKEN: "secret",
  MEDIA_PROCESSING_WORKFLOW: "platform",
  VIDEO_ANALYSIS_WORKFLOW: "platform",
  VIDEO_WORKFLOW_ACCOUNT_ID: "var",
  VIDEO_WORKFLOW_NAME: "var",
  VIDEO_WORKFLOW_SCRIPT_NAME: "var",
  VIDEO_WORKFLOW_READ_TOKEN: "secret",
  MEDIA_IMMUTABLE_ORIGINALS: "platform",
  MEDIA_DERIVED_ARTIFACTS: "platform",
  IMAGE_TRANSFORMATIONS: "platform",
  ACRCLOUD_IDENTIFY_HOST: "var",
  ACRCLOUD_ACCESS_KEY: "secret",
  ACRCLOUD_ACCESS_SECRET: "secret",
  ACRCLOUD_CONSOLE_ORIGIN: "var",
  ACRCLOUD_CONSOLE_TOKEN: "secret",
  ACRCLOUD_SOURCE_BUCKET_ID: "var",
  ELEVENLABS_API_KEY: "secret",
  OPENAI_API_KEY: "secret",
  OPENAI_MODERATION_ENABLED: "var",
  VIDEO_SAFETY_GATE: "var",
  OPENROUTER_API_KEY: "secret",
  QENCODE_API_KEY: "secret",
  VIDEO_SOURCE_GATEWAY_ORIGIN: "var",
  DATA_REGISTRATION_ENABLED: "var",
  DATA_REGISTRATION_CHAIN_ID: "var",
} as const satisfies {
  [K in keyof (MediaProcessorRuntimeEnv & ModeratedDanceMediaEnv)]-?: "platform" | "secret" | "var";
};

const MEDIA_DANCE_ENABLED_REQUIRED = [
  "CONTROL_PLANE",
  "MEDIA_INGRESS",
  "DANCE_MODERATED_REPLAY_KEYS",
  "OPENAI_MODERATION_ENABLED",
  "OPENAI_API_KEY",
] as const;

const MEDIA_ENABLED_REQUIRED = [
  "ACRCLOUD_IDENTIFY_HOST",
  "ACRCLOUD_ACCESS_KEY",
  "ACRCLOUD_ACCESS_SECRET",
  "ELEVENLABS_API_KEY",
  "OPENAI_API_KEY",
] as const;

const SONG_SOURCE_RECORDING_REQUIRED = [
  "ACRCLOUD_CONSOLE_ORIGIN",
  "ACRCLOUD_CONSOLE_TOKEN",
  "ACRCLOUD_SOURCE_BUCKET_ID",
] as const;

function mediaUsesCloudConvert(vars: Readonly<Record<string, unknown>>): boolean {
  return (
    vars.VIDEO_CLOUDCONVERT_RENDER_ENABLED === "true" ||
    vars.SONG_VIDEO_PCM_ADMISSION_ENABLED === "true" ||
    vars.DANCE_MODERATED_PROCESSING_ENABLED === "true"
  );
}

export function requiredMediaBindingNames(vars: Readonly<Record<string, unknown>>): string[] {
  const required: string[] =
    vars.MEDIA_PROCESSING_ENABLED === "true"
      ? ["MEDIA_PROCESSING_ENABLED", ...MEDIA_ENABLED_REQUIRED]
      : ["MEDIA_PROCESSING_ENABLED"];
  if (vars.SONG_SOURCE_RECORDING_ENABLED === "true") {
    required.push("SONG_SOURCE_RECORDING_ENABLED", ...SONG_SOURCE_RECORDING_REQUIRED);
  }
  if (vars.DANCE_MODERATED_PROCESSING_ENABLED === "true") {
    required.push(...MEDIA_DANCE_ENABLED_REQUIRED);
  }
  if (mediaUsesCloudConvert(vars)) {
    required.push(
      "CLOUDCONVERT_RENDER_API_KEY",
      "VIDEO_SOURCE_GATEWAY_ORIGIN",
      "MEDIA_IMMUTABLE_ORIGINALS",
    );
  }
  return required;
}
