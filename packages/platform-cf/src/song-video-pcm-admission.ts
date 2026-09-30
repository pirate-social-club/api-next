import {
  CloudConvertTransportError,
  makeSongVideoCloudConvertTransport,
} from "./song-video-cloudconvert-transport.ts";
import {
  type makeSongPcmAdmissionRepository,
  type SongPcmAdmission,
  songPcmOutputKey,
} from "./song-video-pcm-admission-repository.ts";
import { makeSongVideoPcmJob, SONG_VIDEO_PCM_DECODER_RECIPE } from "./song-video-pcm-job.ts";
import {
  readStoredSongVideoPcm,
  SongPcmTransferError,
  transferSongVideoPcm,
} from "./song-video-pcm-transfer.ts";
import { videoSourceCapabilityDigest } from "./video-source-capability.ts";
import { makeVideoSourceUrl } from "./video-source-gateway.ts";

export type SongPcmAdmissionDependencies = Readonly<{
  repository: ReturnType<typeof makeSongPcmAdmissionRepository>;
  bucket: Pick<R2Bucket, "head" | "get" | "put" | "delete">;
  apiKey: string;
  sourceGatewayOrigin: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}>;

/** One Queue delivery observes one durable attempt; a retry cannot resend creation. */
export async function consumeSongPcmAdmission(
  message: unknown,
  deps: SongPcmAdmissionDependencies,
): Promise<"ack" | "retry"> {
  if (
    typeof message !== "object" ||
    message === null ||
    Array.isArray(message) ||
    !("admission_id" in message) ||
    typeof message.admission_id !== "string" ||
    !/^song-pcm-[0-9a-f]{64}$/u.test(message.admission_id)
  )
    return "ack";
  const repo = deps.repository;
  // Called unbound: workerd rejects native fetch invoked as an object method.
  const send = deps.fetch;
  let a = await repo.claim(message.admission_id, crypto.randomUUID());
  if (a === null) return "ack"; // A scheduled scan will recover any expired claim.
  const transport = (deadlineMs?: number) =>
    makeSongVideoCloudConvertTransport({
      apiKey: deps.apiKey,
      fetch: send,
      exportKind: "pcm",
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
    });
  async function cleanup(current: SongPcmAdmission) {
    if (!["admitted", "refused", "reconciliation"].includes(current.state)) return false;
    await repo.revoke(current);
    const provider = transport();
    const found = await provider.findAllByTag(current.admission_id);
    const ids = new Set(found.map((j) => j.id));
    if (current.provider_job_id !== null) ids.add(current.provider_job_id);
    if (
      current.provider_create_started_at !== null &&
      ids.size === 0 &&
      current.failure_code !== "provider_rejected" &&
      current.failure_code !== "source_grant_refused"
    )
      return false;
    for (const id of ids) await provider.remove(id);
    if (current.state !== "admitted")
      await deps.bucket.delete(songPcmOutputKey(current.admission_id));
    await repo.cleaned(current);
    return true;
  }
  async function refuse(current: SongPcmAdmission, code: string, reconciliation = false) {
    if (!(await repo.refuse(current, code, reconciliation))) return "retry" as const;
    const saved = await repo.get(current.admission_id);
    if (!saved) return "retry" as const;
    console.error(
      JSON.stringify({
        event: "song_pcm_admission_refused",
        admission_id: current.admission_id,
        failure_class: code,
        reconciliation,
      }),
    );
    return (await cleanup(saved)) ? ("ack" as const) : ("retry" as const);
  }
  let phase = "resume";
  let httpStatus: number | undefined;
  try {
    if (a.state === "admitted" || a.state === "refused" || a.state === "reconciliation")
      return (await cleanup(a)) ? "ack" : "retry";
    if (a.provider_wait_deadline !== null && Date.now() >= a.provider_wait_deadline.getTime())
      return await refuse(a, "deadline_expired", true);
    if (a.provider_create_started_at === null) {
      phase = "source-admission";
      const source = await repo.source(a);
      if (source === null) return await refuse(a, "source_refused");
      const head = await deps.bucket.head(source.objectKey);
      if (
        head === null ||
        head.etag !== source.objectEtag ||
        head.size !== source.byteLength ||
        (source.identity === "upload_version" && head.version !== source.objectVersion)
      )
        return await refuse(a, "source_identity_changed");
      const origin = new URL(deps.sourceGatewayOrigin);
      if (
        origin.protocol !== "https:" ||
        origin.username !== "" ||
        origin.password !== "" ||
        origin.pathname !== "/" ||
        origin.search !== "" ||
        origin.hash !== ""
      )
        throw new Error("PCM source gateway invalid");
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const capability = btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/u, "");
      const sourceUrl = makeVideoSourceUrl(origin.origin, capability);
      const job = makeSongVideoPcmJob({
        admissionId: a.admission_id,
        sourceUrl,
        sourceByteLength: source.byteLength,
        sourceDurationMs: source.durationMs,
      });
      const started = await repo.beginCreate(a);
      if (started === null) return "retry";
      a = started;
      try {
        await repo.grant(
          a,
          source,
          await videoSourceCapabilityDigest(capability),
          Date.now() + 15 * 60_000 - 1000,
        );
      } catch {
        return await refuse(a, "source_grant_refused");
      }
      try {
        phase = "provider-create";
        const created = await transport(a.provider_wait_deadline?.getTime()).create(job);
        await repo.attachJob(a, created.id);
        a = { ...a, provider_job_id: created.id };
      } catch (error) {
        if (error instanceof CloudConvertTransportError && error.outcome === "rejected")
          return await refuse(a, "provider_rejected");
        // An uncertain acknowledgement is resolved by the exact tag below.
      }
    }
    const deadlineMs = a.provider_wait_deadline?.getTime();
    if (deadlineMs === undefined || Date.now() >= deadlineMs)
      return await refuse(a, "deadline_expired", true);
    phase = "provider-lookup";
    const provider = transport(deadlineMs);
    if (a.provider_job_id === null) {
      const found = await provider.findAllByTag(a.admission_id);
      if (found.length === 0) return "retry";
      if (found.length !== 1) return await refuse(a, "duplicate_provider_jobs", true);
      const recovered = found[0];
      if (!recovered) return "retry";
      await repo.attachJob(a, recovered.id);
      a = { ...a, provider_job_id: recovered.id };
    }
    if (Date.now() >= deadlineMs) return await refuse(a, "deadline_expired", true);
    // Recover a completed write without depending on the provider export's lifetime.
    phase = "stored-readback";
    let facts = await readStoredSongVideoPcm({
      bucket: deps.bucket,
      objectKey: songPcmOutputKey(a.admission_id),
      canonicalAudioSha256: a.canonical_audio_sha256,
      decoderRecipe: SONG_VIDEO_PCM_DECODER_RECIPE,
      deadlineMs,
    });
    if (facts === null) {
      const jobId = a.provider_job_id;
      if (jobId === null) return "retry";
      phase = "export-observation";
      const observation = await provider.show(jobId);
      if (observation.tag !== a.admission_id)
        return await refuse(a, "provider_identity_changed", true);
      if (observation.status === "waiting" || observation.status === "processing") return "retry";
      if (observation.status === "error") return await refuse(a, "provider_failed");
      if (observation.exportUrl === null) return await refuse(a, "provider_export_missing");
      const controller = new AbortController();
      const remaining = Math.min(120_000, deadlineMs - Date.now());
      if (remaining <= 0) return await refuse(a, "deadline_expired", true);
      const timer = setTimeout(() => controller.abort(), remaining);
      try {
        phase = "export-fetch";
        const response = await send(observation.exportUrl, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
        });
        httpStatus = response.status;
        phase = "pcm-transfer";
        facts = await transferSongVideoPcm({
          response,
          bucket: deps.bucket,
          objectKey: songPcmOutputKey(a.admission_id),
          canonicalAudioSha256: a.canonical_audio_sha256,
          decoderRecipe: SONG_VIDEO_PCM_DECODER_RECIPE,
          deadlineMs,
        });
      } finally {
        clearTimeout(timer);
      }
    }
    phase = "admission-commit";
    await repo.admit(a, facts);
    const admitted = await repo.get(a.admission_id);
    phase = "cleanup";
    return admitted !== null && (await cleanup(admitted)) ? "ack" : "retry";
  } catch (error) {
    // A lost database acknowledgement might already have committed admission.
    // Cleanup can never delete PCM until a fresh durable terminal state is read.
    const latest = await repo.get(a.admission_id).catch(() => null);
    if (latest !== null && ["admitted", "refused", "reconciliation"].includes(latest.state))
      return await cleanup(latest)
        .then((done) => (done ? ("ack" as const) : ("retry" as const)))
        .catch(() => "retry" as const);
    console.error(
      JSON.stringify({
        event: "song_pcm_admission_observation_failed",
        admission_id: a.admission_id,
        phase,
        ...(error instanceof SongPcmTransferError
          ? { transfer_phase: error.phase, pending_transfer_phases: error.pendingPhases }
          : {}),
        error_class:
          error instanceof SongPcmTransferError
            ? error.errorClass
            : error instanceof Error &&
                ["Error", "TypeError", "RangeError", "AbortError", "TimeoutError"].includes(
                  error.name,
                )
              ? error.name
              : "Error",
        ...(httpStatus === undefined ? {} : { http_status: httpStatus }),
      }),
    );
    return "retry";
  } finally {
    await repo.release(a).catch(() => undefined);
  }
}
