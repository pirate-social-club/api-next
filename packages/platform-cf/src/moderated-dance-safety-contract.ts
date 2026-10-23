import { Effect } from "effect";
import { canonicalBodyHash } from "../../application/src/use-cases/content/common.ts";
import { OPENAI_MODERATION_BASE_URL, OPENAI_MODERATION_MODEL } from "./openai-text-moderation.ts";
import type { VideoSafetyFrameClaimInput } from "./video-safety-provider.ts";

export const MODERATED_DANCE_SAFETY_REVISION = "private-three-still-openai-contract-v1";

/** Supported endpoint contract, not a per-request deletion observation or a
 * universal preservation guarantee. Selection still requires a dated admitted
 * capture profile. The adapter uses inline images, never Files or Responses.
 * https://developers.openai.com/api/docs/guides/your-data */
export const MODERATED_DANCE_SAFETY_CONTRACT = Object.freeze({
  version: "private-dance-safety-retention-v1",
  provider: "openai",
  endpoint: `${OPENAI_MODERATION_BASE_URL}/moderations`,
  model: OPENAI_MODERATION_MODEL,
  input: "inline-jpeg-data-url",
  abuseMonitoring: "no-ordinary-content-retention",
  applicationState: "none",
  evidenceKind: "documented-endpoint-contract",
  preservation: "legal-or-provider-preservation-is-not-observed-absence",
  source: "https://developers.openai.com/api/docs/guides/your-data",
  observedOn: "2026-10-23",
});

type Call = (label: string, text: string, values: readonly unknown[]) => Promise<unknown>;

/** Every frame command carries the original provider contract in its hash and
 * durable SQL claim. A lost COMMIT acknowledgement escapes before dispatch;
 * this boundary never retries a request or manufactures another purpose. */
export function makeModeratedDanceSafetyProtocol(
  input: Readonly<{
    call: Call;
    uploadId: string;
    token: string;
  }>,
) {
  const invoke = (action: string, fields: Readonly<Record<string, unknown>>) =>
    input.call(
      `dance.media.safety.${action}`,
      "SELECT moderated_dance_safety_protocol_v1($1,$2,$3,$4::jsonb) AS packet",
      [
        input.uploadId,
        input.token,
        action,
        JSON.stringify({ ...fields, providerContract: MODERATED_DANCE_SAFETY_CONTRACT }),
      ],
    );
  return {
    evidence: (action: "load" | "save", fields: Readonly<Record<string, unknown>>) =>
      invoke(action, fields),
    async frame(
      action: "inspect" | "claim" | "succeed" | "fail",
      frame: VideoSafetyFrameClaimInput,
      fields: Readonly<Record<string, unknown>> = {},
    ) {
      const requestHash = await Effect.runPromise(
        canonicalBodyHash([
          "private-dance-safety-frame-v2",
          input.uploadId,
          frame,
          MODERATED_DANCE_SAFETY_CONTRACT,
        ]),
      );
      return invoke(action, { ...fields, frame, requestHash });
    },
  };
}
