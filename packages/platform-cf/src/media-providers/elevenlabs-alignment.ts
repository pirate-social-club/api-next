/** Disabled-by-default ElevenLabs forced-alignment adapter. */

import { Predicate } from "effect";
import {
  ElevenLabsAlignmentBodyError,
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
  type ElevenLabsAlignmentInput,
  type ElevenLabsAlignmentLimits,
  type ElevenLabsAlignmentOutcome,
  type ElevenLabsAlignmentRandomBytes,
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
  /** Test-only entropy injection; production uses platform cryptographic randomness. */
  readonly random_bytes?: ElevenLabsAlignmentRandomBytes;
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

function disposeLateResponse(response: ElevenLabsAlignmentTransportResponse): void {
  try {
    void Promise.resolve(response.body.cancel("late_transport_response")).catch(() => undefined);
  } catch {
    // A late transport response must never alter the already-selected outcome.
  }
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
  private readonly randomBytes: ElevenLabsAlignmentRandomBytes | undefined;

  constructor(options: ElevenLabsAlignmentAdapterOptions = {}) {
    this.enabled = options.enabled === true;
    this.#apiKey = options.api_key;
    this.transport = options.transport;
    this.limits = options.limits === undefined ? undefined : Object.freeze({ ...options.limits });
    this.randomBytes = options.random_bytes;
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
    const transport = this.transport;
    const apiKey = this.#apiKey;
    const randomBytes = this.randomBytes;
    if (transport === undefined || !validateApiKey(apiKey) || !validateLimits(limits)) {
      return permanent("configuration");
    }
    const validated = validateInput(input, limits);
    if (!("input" in validated)) return validated;
    const context = Object.freeze({ ...validated.context });
    const requestInput = Object.freeze({
      request_id: validated.input.request_id,
      operation_id: validated.input.operation_id,
      post_id: validated.input.post_id,
      audio: Object.freeze({
        audio_revision: validated.input.audio.audio_revision,
        canonical_audio_sha256: validated.input.audio.canonical_audio_sha256,
        source: Object.freeze({
          byteLength: validated.input.audio.source.byteLength,
          open: validated.input.audio.source.open,
        }),
        mime_type: validated.input.audio.mime_type,
        ...(validated.input.audio.filename === undefined
          ? {}
          : { filename: validated.input.audio.filename }),
      }),
      transcript: Object.freeze({
        artifact_ref: validated.input.transcript.artifact_ref,
        operation_id: validated.input.transcript.operation_id,
        audio_revision: validated.input.transcript.audio_revision,
        analysis_revision: validated.input.transcript.analysis_revision,
        canonical_audio_sha256: validated.input.transcript.canonical_audio_sha256,
        transcript: validated.input.transcript.transcript,
      }),
      ...(validated.input.signal === undefined ? {} : { signal: validated.input.signal }),
    });
    if (requestInput.transcript.transcript.length === 0) {
      return noSpeech(context);
    }
    const body = encodeElevenLabsAlignmentMultipart(
      randomBytes === undefined
        ? {
            audio: requestInput.audio,
            transcript: requestInput.transcript.transcript,
          }
        : {
            audio: requestInput.audio,
            transcript: requestInput.transcript.transcript,
            random_bytes: randomBytes,
          },
    );
    if (body === null || body.byteLength > ELEVENLABS_ALIGNMENT_HARD_MAX_REQUEST_BYTES) {
      return permanent("invalid_request", context);
    }

    const externalSignal = requestInput.signal;
    if (externalSignal?.aborted) return cancellation("cancelled", context);
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
        "content-type": body.contentType,
        "content-length": String(body.byteLength),
        "xi-api-key": apiKey,
      },
      body,
      signal: controller.signal,
    };
    let transportPromise: Promise<ElevenLabsAlignmentTransportResponse>;
    try {
      transportPromise = Promise.resolve(transport(request));
    } catch {
      transportPromise = Promise.reject(new Error("transport_failure"));
    }
    let abortWon = false;
    let responseClaimed = false;
    let operationFinished = false;
    const guardedTransportPromise = transportPromise.then(
      (response) => {
        if (abortWon || operationFinished) {
          disposeLateResponse(response);
          return new Promise<never>(() => undefined);
        }
        responseClaimed = true;
        return response;
      },
      (error: unknown) => Promise.reject(error),
    );
    void guardedTransportPromise.catch(() => undefined);
    const abortPromise = new Promise<never>((_resolve, reject) => {
      const check = () => {
        if (abortReason !== undefined) {
          abortWon = true;
          reject(new AlignmentAbort(abortReason));
        }
      };
      controller.signal.addEventListener("abort", check, { once: true });
      check();
    });
    try {
      const response = await Promise.race([guardedTransportPromise, abortPromise]);
      return await parseElevenLabsAlignmentResponse({
        ...response,
        transcript: requestInput.transcript.transcript,
        context,
        limits,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof AlignmentAbort) return cancellation(error.reason, context);
      if (abortReason === "timeout") {
        return cancellation("timeout", context);
      }
      if (abortReason === "cancelled") return cancellation("cancelled", context);
      if (isAbortError(error)) return cancellation("timeout", context);
      if (error instanceof ElevenLabsAlignmentBodyError) {
        return permanent("invalid_request", context);
      }
      return retryable("transport", context);
    } finally {
      operationFinished = true;
      if (!responseClaimed && abortReason !== undefined) abortWon = true;
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
    }
  }
}
