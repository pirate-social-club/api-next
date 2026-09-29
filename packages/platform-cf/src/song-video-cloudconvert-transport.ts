/** A deliberately small CloudConvert boundary. POST is never retried here. */
export type CloudConvertJob = Readonly<{
  id: string;
  tag: string;
  status: "waiting" | "processing" | "finished" | "error";
}>;

export type CloudConvertJobObservation = CloudConvertJob & Readonly<{ exportUrl: string | null }>;

export class CloudConvertTransportError extends Error {
  constructor(
    readonly outcome: "rejected" | "uncertain",
    readonly status?: number,
  ) {
    super(`CloudConvert request ${outcome}`);
    this.name = "CloudConvertTransportError";
  }
}

const API = "https://api.cloudconvert.com/v2";
const MAX_RESPONSE_BYTES = 262_144;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,191}$/u;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;

function parseJob(value: unknown): CloudConvertJob {
  if (typeof value !== "object" || value === null)
    throw new CloudConvertTransportError("uncertain");
  const job = value as Record<string, unknown>;
  if (
    typeof job.id !== "string" ||
    !ID.test(job.id) ||
    typeof job.tag !== "string" ||
    !TAG.test(job.tag) ||
    !["waiting", "processing", "finished", "error"].includes(String(job.status))
  ) {
    throw new CloudConvertTransportError("uncertain");
  }
  return {
    id: job.id,
    tag: job.tag,
    status: job.status as CloudConvertJob["status"],
  };
}

function parseObservation(value: unknown, exportKind: "video" | "pcm"): CloudConvertJobObservation {
  const job = parseJob(value);
  if (job.status !== "finished") return { ...job, exportUrl: null };
  const tasks = record(value).tasks;
  if (!Array.isArray(tasks)) throw new CloudConvertTransportError("uncertain");
  const exports = tasks.filter(
    (task) =>
      typeof task === "object" &&
      task !== null &&
      (task as Record<string, unknown>).name ===
        (exportKind === "pcm" ? "export-pcm" : "export-master"),
  );
  if (exports.length !== 1) throw new CloudConvertTransportError("uncertain");
  const task = record(exports[0]);
  if (task.operation !== "export/url" || task.status !== "finished")
    throw new CloudConvertTransportError("uncertain");
  const files = record(task.result).files;
  if (!Array.isArray(files) || files.length !== 1)
    throw new CloudConvertTransportError("uncertain");
  const file = record(files[0]);
  if (
    file.filename !== (exportKind === "pcm" ? "song.pcm" : "master.mp4") ||
    typeof file.url !== "string"
  )
    throw new CloudConvertTransportError("uncertain");
  let url: URL;
  try {
    url = new URL(file.url);
  } catch {
    throw new CloudConvertTransportError("uncertain");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "storage.cloudconvert.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new CloudConvertTransportError("uncertain");
  }
  return { ...job, exportUrl: file.url };
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel();
    throw new Error("oversized response");
  }
  if (!response.body) throw new Error("missing response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("oversized response");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new CloudConvertTransportError("uncertain");
  return value as Record<string, unknown>;
}

/** Returns at most one matching job. More than one is an operator reconciliation event. */
export function makeSongVideoCloudConvertTransport(
  input: Readonly<{
    apiKey: string;
    deadlineMs?: number;
    now?: () => number;
    exportKind?: "video" | "pcm";
    fetch: (url: string, init: RequestInit) => Promise<Response>;
  }>,
) {
  if (!/^\S+$/u.test(input.apiKey)) throw new Error("missing CloudConvert credential");
  const send = input.fetch;

  async function request(
    path: string,
    method: "GET" | "POST" | "DELETE",
    body?: unknown,
  ): Promise<unknown> {
    const controller = new AbortController();
    const remaining =
      input.deadlineMs === undefined ? 30_000 : input.deadlineMs - (input.now ?? Date.now)();
    if (!Number.isFinite(remaining) || remaining <= 0)
      throw new CloudConvertTransportError("uncertain");
    const timer = setTimeout(() => controller.abort(), Math.min(30_000, remaining));
    try {
      const response = await send(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "manual",
        signal: controller.signal,
      });
      if (method === "DELETE" && response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new CloudConvertTransportError(
          response.status >= 500 ? "uncertain" : "rejected",
          response.status,
        );
      }
      if (method === "DELETE" && response.status === 204) {
        await response.body?.cancel();
        return null;
      }
      return await boundedJson(response);
    } catch (error) {
      if (error instanceof CloudConvertTransportError) throw error;
      // A lost response to POST might mean the job exists. No second POST is safe.
      throw new CloudConvertTransportError("uncertain");
    } finally {
      clearTimeout(timer);
    }
  }

  const findAllByTag = async (tag: string): Promise<CloudConvertJob[]> => {
    if (!TAG.test(tag)) throw new TypeError("invalid CloudConvert job tag");
    const found = new Map<string, CloudConvertJob>();
    for (let page = 1; page <= 10; page++) {
      const payload = record(
        await request(
          `/jobs?filter%5Btag%5D=${encodeURIComponent(tag)}&per_page=100&page=${page}`,
          "GET",
        ),
      );
      if (!Array.isArray(payload.data) || payload.data.length > 100)
        throw new CloudConvertTransportError("uncertain");
      for (const candidate of payload.data) {
        const job = parseJob(candidate);
        if (job.tag === tag) found.set(job.id, job);
      }
      if (payload.data.length < 100) return [...found.values()];
    }
    throw new CloudConvertTransportError("uncertain");
  };
  return {
    findAllByTag,
    async create(job: Readonly<{ tag: string; tasks: unknown }>): Promise<CloudConvertJob> {
      if (!TAG.test(job.tag)) throw new TypeError("invalid CloudConvert job tag");
      const payload = record(await request("/jobs", "POST", job));
      const created = parseJob(payload.data);
      if (created.tag !== job.tag) throw new CloudConvertTransportError("uncertain");
      return created;
    },
    /** Null is inconclusive and must never authorize another create request. */
    async findByTag(tag: string): Promise<CloudConvertJob | null> {
      const found = await findAllByTag(tag);
      if (found.length > 1) throw new CloudConvertTransportError("uncertain");
      return found[0] ?? null;
    },
    async show(id: string): Promise<CloudConvertJobObservation> {
      if (!ID.test(id)) throw new TypeError("invalid CloudConvert job id");
      return parseObservation(
        record(await request(`/jobs/${id}`, "GET")).data,
        input.exportKind ?? "video",
      );
    },
    async remove(id: string): Promise<void> {
      if (!ID.test(id)) throw new TypeError("invalid CloudConvert job id");
      const result = await request(`/jobs/${id}`, "DELETE");
      if (result !== null) throw new CloudConvertTransportError("uncertain");
    },
  };
}
