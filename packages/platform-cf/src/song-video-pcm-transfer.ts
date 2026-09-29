/** Whole-song PCM remains streamed, with one backpressure path and no tee. */
export const SONG_VIDEO_PCM_MAX_SAMPLES = 240 * 48_000;
export const SONG_VIDEO_PCM_MAX_BYTES = SONG_VIDEO_PCM_MAX_SAMPLES * 4;

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
    throw new Error("song PCM export refused");
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("song PCM transfer deadline expired")),
    Math.min(input.deadlineMs - now(), 2_147_483_647),
  );
  try {
    const digest = streamingDigest();
    const hashWriter = digest.getWriter();
    const fixed = new FixedLengthStream(byteLength);
    const body = input.response.body
      .pipeThrough(countedStream(byteLength, now, input.deadlineMs))
      .pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          async transform(chunk, output) {
            await hashWriter.write(chunk);
            output.enqueue(chunk);
          },
          async flush() {
            await hashWriter.close();
          },
        }),
      );
    const pump = body
      .pipeTo(fixed.writable, { signal: controller.signal })
      .catch(async (error: unknown) => {
        controller.abort(error);
        await hashWriter.abort(error).catch(() => undefined);
        throw error;
      });
    const put = input.bucket
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
      })
      .catch((error: unknown) => {
        controller.abort(error);
        throw error;
      });
    const [object, , pcmSha256] = await beforeAbort(
      Promise.all([put, pump, digest.digest.then(hex)]),
      controller.signal,
    );
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
    const reread = await beforeAbort(readbackRequest, controller.signal);
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
    const readback = reread.body
      .pipeThrough(countedStream(byteLength, now, input.deadlineMs))
      .pipeTo(readbackDigest, { signal: controller.signal });
    const [, rereadSha256] = await beforeAbort(
      Promise.all([readback, readbackDigest.digest.then(hex)]),
      controller.signal,
    );
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
    throw error;
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
