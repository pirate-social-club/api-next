/** Disabled-by-default ElevenLabs forced-alignment adapter. */

import { Predicate } from "effect";
import {
  encodeElevenLabsAlignmentMultipart,
  permanent,
  retryable,
  validateApiKey,
  validateInput,
  validateLimits,
} from "./elevenlabs-alignment-request.ts";
import { parseElevenLabsAlignmentResponse } from "./elevenlabs-alignment-response.ts";
import {
  ELEVENLABS_ALIGNMENT_ENDPOINT,
  ELEVENLABS_ALIGNMENT_HARD_MAX_REQUEST_BYTES,
  ELEVENLABS_ALIGNMENT_MULTIPART_BOUNDARY,
  type ElevenLabsAlignmentInput,
  type ElevenLabsAlignmentLimits,
  type ElevenLabsAlignmentOutcome,
  type ElevenLabsAlignmentTransport,
  type ElevenLabsAlignmentTransportRequest,
  type ElevenLabsAlignmentTransportResponse,
} from "./elevenlabs-alignment-types.ts";

export { encodeElevenLabsAlignmentMultipart } from "./elevenlabs-alignment-request.ts";
export * from "./elevenlabs-alignment-types.ts";

export type ElevenLabsAlignmentAdapterOptions = Readonly<{
  /** Explicit opt-in; the default is false and performs no transport call. */
  readonly enabled?: boolean;
  /** Opaque secret supplied by composition; never returned or logged. */
  readonly api_key?: string;
  readonly transport?: ElevenLabsAlignmentTransport;
  /** Reviewed request limits, not provider/product policy guessed by this module. */
  readonly limits?: ElevenLabsAlignmentLimits;
}>;

class AlignmentAbort extends Error {
  readonly reason: "timeout" | "cancelled";

  constructor(reason: "timeout" | "cancelled") {
    super(reason);
    this.name = "AlignmentAbort";
    this.reason = reason;
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (Predicate.isObject(error) && error.name === "AbortError")
  );
}

function cancellation(
  reason: "timeout" | "cancelled",
  context: Parameters<typeof parseElevenLabsAlignmentResponse>[0]["context"],
): ElevenLabsAlignmentOutcome {
  return reason === "timeout"
    ? {
        status: "unavailable",
        alignment: "unavailable",
        outcome: "timeout",
        reason: "timeout",
        context,
      }
    : {
        status: "unavailable",
        alignment: "unavailable",
        outcome: "cancelled",
        reason: "cancelled",
        context,
      };
}

function noSpeech(
  context: Parameters<typeof parseElevenLabsAlignmentResponse>[0]["context"],
): ElevenLabsAlignmentOutcome {
  return {
    status: "unavailable",
    alignment: "unavailable",
    outcome: "no_speech",
    reason: "no_speech",
    context,
  };
}

export class ElevenLabsAlignmentAdapter {
  private readonly enabled: boolean;
  #apiKey: string | undefined;
  private readonly transport: ElevenLabsAlignmentTransport | undefined;
  private readonly limits: ElevenLabsAlignmentLimits | undefined;

  constructor(options: ElevenLabsAlignmentAdapterOptions = {}) {
    this.enabled = options.enabled === true;
    this.#apiKey = options.api_key;
    this.transport = options.transport;
    this.limits = options.limits;
  }

  async align(input: ElevenLabsAlignmentInput): Promise<ElevenLabsAlignmentOutcome> {
    if (!this.enabled) {
      return {
        status: "unavailable",
        alignment: "unavailable",
        outcome: "disabled",
        reason: "disabled",
      };
    }
    const limits = this.limits;
    if (this.transport === undefined || !validateApiKey(this.#apiKey) || !validateLimits(limits)) {
      return permanent("configuration");
    }
    const validated = validateInput(input, limits);
    if (!("input" in validated)) return validated;
    if (validated.input.transcript.transcript.trim().length === 0) {
      return noSpeech(validated.context);
    }
    const body = await encodeElevenLabsAlignmentMultipart({
      audio: validated.input.audio,
      transcript: validated.input.transcript.transcript,
    });
    if (body === null || body.byteLength > ELEVENLABS_ALIGNMENT_HARD_MAX_REQUEST_BYTES) {
      return permanent("invalid_request", validated.context);
    }

    const externalSignal = validated.input.signal;
    if (externalSignal?.aborted) return cancellation("cancelled", validated.context);
    const controller = new AbortController();
    let abortReason: "timeout" | "cancelled" | undefined;
    const onAbort = () => {
      abortReason = "cancelled";
      controller.abort();
    };
    externalSignal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      abortReason = "timeout";
      controller.abort();
    }, limits.timeout_ms);

    const request: ElevenLabsAlignmentTransportRequest = {
      method: "POST",
      url: ELEVENLABS_ALIGNMENT_ENDPOINT,
      headers: {
        accept: "application/json",
        "content-type": `multipart/form-data; boundary=${ELEVENLABS_ALIGNMENT_MULTIPART_BOUNDARY}`,
        "content-length": String(body.byteLength),
        "xi-api-key": this.#apiKey,
      },
      body,
      signal: controller.signal,
    };
    let transportPromise: Promise<ElevenLabsAlignmentTransportResponse>;
    try {
      transportPromise = Promise.resolve(this.transport(request));
    } catch {
      transportPromise = Promise.reject(new Error("transport_failure"));
    }
    void transportPromise.catch(() => undefined);
    const abortPromise = new Promise<never>((_resolve, reject) => {
      const check = () => {
        if (abortReason !== undefined) reject(new AlignmentAbort(abortReason));
      };
      controller.signal.addEventListener("abort", check, { once: true });
      check();
    });
    try {
      const response = await Promise.race([transportPromise, abortPromise]);
      return parseElevenLabsAlignmentResponse({
        ...response,
        transcript: validated.input.transcript.transcript,
        context: validated.context,
        limits,
      });
    } catch (error) {
      if (error instanceof AlignmentAbort) return cancellation(error.reason, validated.context);
      if (abortReason === "timeout" || isAbortError(error)) {
        return cancellation("timeout", validated.context);
      }
      if (abortReason === "cancelled") return cancellation("cancelled", validated.context);
      return retryable("transport", validated.context);
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
    }
  }
}

export function makeElevenLabsAlignmentAdapter(
  options: ElevenLabsAlignmentAdapterOptions = {},
): ElevenLabsAlignmentAdapter {
  return new ElevenLabsAlignmentAdapter(options);
}
