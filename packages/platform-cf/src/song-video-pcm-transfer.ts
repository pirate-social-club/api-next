/** Whole-song PCM remains streamed, with one backpressure path and no tee. */
export const SONG_VIDEO_PCM_MAX_SAMPLES = 240 * 48_000;
export const SONG_VIDEO_PCM_MAX_BYTES = SONG_VIDEO_PCM_MAX_SAMPLES * 4;

type TransferPhase =
  | "deadline"
  | "export-admission"
  | "stream"
  | "upload"
  | "hash-close"
  | "hash-digest"
  | "upload-identity"
  | "readback"
  | "readback-identity"
  | "readback-hash"
  | "readback-digest"
  | "digest-verification";

/** Only fixed stages and allowlisted classes survive a transfer failure. */
export class SongPcmTransferError extends Error {
  readonly errorClass: string;
  readonly pendingPhases: readonly TransferPhase[];

  constructor(
    readonly phase: TransferPhase,
    pending: Iterable<TransferPhase>,
    error: unknown,
  ) {
    const errorClass =
      error instanceof Error &&
      ["Error", "TypeError", "RangeError", "AbortError", "TimeoutError"].includes(error.name)
        ? error.name
        : "Error";
    const pendingPhases = Object.freeze([...pending].sort());
    super(
      `song PCM transfer failed (phase=${phase} error=${errorClass} pending=${pendingPhases.join(",")})`,
    );
    this.errorClass = errorClass;
    this.pendingPhases = pendingPhases;
  }
}

function transferDiagnostics() {
  let phase: TransferPhase = "export-admission";
  const pending = new Set<TransferPhase>();
  let failed: SongPcmTransferError | undefined;
  return {
    phase(next: TransferPhase) {
      phase = next;
    },
    async track<A>(next: TransferPhase, operation: Promise<A>): Promise<A> {
      phase = next;
      pending.add(next);
      try {
        return await operation;
      } catch (error) {
        failed ??= new SongPcmTransferError(next, pending, error);
        throw failed;
      } finally {
        pending.delete(next);
      }
    },
    failure(error: unknown) {
      return (
        failed ??
        new SongPcmTransferError(
          pending.size === 1
            ? (pending.values().next().value ?? phase)
            : error instanceof Error && error.name === "TimeoutError"
              ? "deadline"
              : phase,
          pending,
          error,
        )
      );
    },
  };
}

const hex = (digest: ArrayBuffer): string =>
  Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");

function streamingDigest() {
  const Digest = (crypto as Crypto & { DigestStream: typeof DigestStream }).DigestStream;
  return new Digest("SHA-256");
}

function countedStream(byteLength: number, now: () => number, deadlineMs: number) {
  let count = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (now() >= deadlineMs) throw new Error("song PCM transfer deadline expired");
      count += chunk.byteLength;
      if (count > byteLength || count > SONG_VIDEO_PCM_MAX_BYTES)
        throw new Error("song PCM transfer overflow");
      controller.enqueue(chunk);
    },
    flush() {
      if (count !== byteLength) throw new Error("song PCM transfer truncated");
      if (now() >= deadlineMs) throw new Error("song PCM transfer deadline expired");
    },
  });
}

function beforeAbort<A>(operation: Promise<A>, signal: AbortSignal): Promise<A> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new Error("song PCM transfer aborted"));
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        if (signal.aborted) aborted();
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

export async function transferSongVideoPcm(
  input: Readonly<{
    response: Response;
    bucket: Pick<R2Bucket, "put" | "get">;
    objectKey: string;
    canonicalAudioSha256: string;
    decoderRecipe: string;
    deadlineMs: number;
    now?: () => number;
  }>,
) {
  const diagnostics = transferDiagnostics();
  const now = input.now ?? Date.now;
  const length = input.response.headers.get("content-length");
  const byteLength = length !== null && /^[1-9][0-9]{0,8}$/u.test(length) ? Number(length) : 0;
  if (
    !input.response.ok ||
    input.response.body === null ||
    byteLength < 4 ||
    byteLength > SONG_VIDEO_PCM_MAX_BYTES ||
    byteLength % 4 !== 0 ||
    !input.objectKey.startsWith("song-video-pcm/") ||
    !/^[0-9a-f]{64}$/u.test(input.canonicalAudioSha256) ||
    input.decoderRecipe.trim().length === 0 ||
    !Number.isSafeInteger(input.deadlineMs) ||
    now() >= input.deadlineMs
  ) {
    await input.response.body?.cancel().catch(() => undefined);
    throw diagnostics.failure(new Error("song PCM export refused"));
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("song PCM transfer deadline expired", "TimeoutError")),
    Math.min(input.deadlineMs - now(), 2_147_483_647),
  );
  try {
    const digest = streamingDigest();
    const hashWriter = digest.getWriter();
    const fixed = new FixedLengthStream(byteLength);
    const digestResult = diagnostics.track("hash-digest", digest.digest.then(hex));
    const body = input.response.body
      .pipeThrough(countedStream(byteLength, now, input.deadlineMs))
      .pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          async transform(chunk, output) {
            await hashWriter.write(chunk);
            output.enqueue(chunk);
          },
          async flush() {
            await diagnostics.track("hash-close", hashWriter.close());
          },
        }),
      );
    const pump = diagnostics
      .track("stream", body.pipeTo(fixed.writable, { signal: controller.signal }))
      .catch(async (error: unknown) => {
        controller.abort(error);
        await hashWriter.abort(error).catch(() => undefined);
        throw error;
      });
    const put = diagnostics
      .track(
        "upload",
        input.bucket
          .put(input.objectKey, fixed.readable, {
            onlyIf: new Headers({ "if-none-match": "*" }),
            httpMetadata: { contentType: "application/octet-stream" },
            customMetadata: {
              canonicalAudioSha256: input.canonicalAudioSha256,
              decoderRecipe: input.decoderRecipe,
            },
          })
          .then((object) => {
            if (object === null) throw new Error("song PCM output address occupied");
            return object;
          }),
      )
      .catch((error: unknown) => {
        controller.abort(error);
        throw error;
      });
    const [object, , pcmSha256] = await beforeAbort(
      Promise.all([put, pump, digestResult]),
      controller.signal,
    );
    diagnostics.phase("upload-identity");
    if (object.size !== byteLength || object.version.length === 0 || object.etag.length === 0)
      throw new Error("song PCM output identity refused");
    const readbackRequest = input.bucket.get(input.objectKey, {
      onlyIf: { etagMatches: object.etag },
    });
    void readbackRequest
      .then((late) => {
        if (controller.signal.aborted && late !== null && "body" in late)
          void late.body.cancel().catch(() => undefined);
      })
      .catch(() => undefined);
    const reread = await beforeAbort(
      diagnostics.track("readback", readbackRequest),
      controller.signal,
    );
    diagnostics.phase("readback-identity");
    if (reread === null || !("body" in reread)) throw new Error("song PCM readback unavailable");
    if (
      reread.version !== object.version ||
      reread.etag !== object.etag ||
      reread.size !== byteLength ||
      reread.customMetadata?.canonicalAudioSha256 !== input.canonicalAudioSha256 ||
      reread.customMetadata?.decoderRecipe !== input.decoderRecipe
    ) {
      await reread.body.cancel().catch(() => undefined);
      throw new Error("song PCM readback identity changed");
    }
    const readbackDigest = streamingDigest();
    const readbackDigestResult = diagnostics.track(
      "readback-digest",
      readbackDigest.digest.then(hex),
    );
    const readback = diagnostics.track(
      "readback-hash",
      reread.body
        .pipeThrough(countedStream(byteLength, now, input.deadlineMs))
        .pipeTo(readbackDigest, { signal: controller.signal }),
    );
    const [, rereadSha256] = await beforeAbort(
      Promise.all([readback, readbackDigestResult]),
      controller.signal,
    );
    diagnostics.phase("digest-verification");
    if (rereadSha256 !== pcmSha256 || now() >= input.deadlineMs)
      throw new Error("song PCM readback changed or expired");
    return {
      objectKey: input.objectKey,
      objectVersion: object.version,
      objectEtag: object.etag,
      pcmSha256,
      byteLength,
      durationSamples: byteLength / 4,
      decoderRecipe: input.decoderRecipe,
    };
  } catch (error) {
    controller.abort(error);
    throw diagnostics.failure(error);
  } finally {
    clearTimeout(timer);
  }
}

/** Recover a completed immutable write after a lost admission acknowledgement. */
export async function readStoredSongVideoPcm(
  input: Readonly<{
    bucket: Pick<R2Bucket, "head" | "get">;
    objectKey: string;
    canonicalAudioSha256: string;
    decoderRecipe: string;
    deadlineMs: number;
  }>,
) {
  const controller = new AbortController();
  const remaining = input.deadlineMs - Date.now();
  if (remaining <= 0) throw new Error("song PCM recovery expired");
  const timer = setTimeout(
    () => controller.abort(new Error("song PCM recovery expired")),
    remaining,
  );
  try {
    const head = await beforeAbort(input.bucket.head(input.objectKey), controller.signal);
    if (head === null) return null;
    if (
      head.size < 4 ||
      head.size > SONG_VIDEO_PCM_MAX_BYTES ||
      head.size % 4 !== 0 ||
      head.customMetadata?.canonicalAudioSha256 !== input.canonicalAudioSha256 ||
      head.customMetadata?.decoderRecipe !== input.decoderRecipe
    )
      throw new Error("song PCM recovery identity refused");
    const get = input.bucket.get(input.objectKey, { onlyIf: { etagMatches: head.etag } });
    void get
      .then((late) => {
        if (controller.signal.aborted && late !== null && "body" in late)
          void late.body.cancel().catch(() => undefined);
      })
      .catch(() => undefined);
    const object = await beforeAbort(get, controller.signal);
    if (object === null || !("body" in object)) throw new Error("song PCM recovery unavailable");
    if (object.version !== head.version || object.etag !== head.etag || object.size !== head.size) {
      await object.body.cancel();
      throw new Error("song PCM recovery changed");
    }
    const digest = streamingDigest();
    const read = object.body
      .pipeThrough(countedStream(head.size, Date.now, input.deadlineMs))
      .pipeTo(digest, { signal: controller.signal });
    const [, pcmSha256] = await beforeAbort(
      Promise.all([read, digest.digest.then(hex)]),
      controller.signal,
    );
    return {
      objectKey: input.objectKey,
      objectVersion: head.version,
      objectEtag: head.etag,
      pcmSha256,
      byteLength: head.size,
      durationSamples: head.size / 4,
      decoderRecipe: input.decoderRecipe,
    };
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
