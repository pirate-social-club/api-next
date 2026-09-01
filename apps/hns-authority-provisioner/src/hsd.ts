import type { HnsRootResourceRecordV1 } from "@pirate/application/namespace-ownership";
import { validCommunityRouteRoot } from "@pirate/domain";

export type HsdFetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

const responseMaxBytes = 1_048_576;
const requestTimeoutMs = 5_000;

function validEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

async function readBounded(response: Response): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > responseMaxBytes) throw new Error("HSD response exceeded byte limit");
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("HSD returned an invalid response");
  }
  return value as Record<string, unknown>;
}

export function makeHsdRootResourceInspector(
  config: Readonly<{ readonly rpc_url: string; readonly authorization: string }>,
  fetcher: HsdFetch = fetch,
): (rootLabel: string) => Promise<readonly HnsRootResourceRecordV1[]> {
  if (!validEndpoint(config.rpc_url) || config.authorization.trim().length === 0) {
    throw new Error("HSD root inspector configuration is invalid");
  }
  const rpc = async (method: "getnameinfo" | "getnameresource", params: readonly unknown[]) => {
    const response = await fetcher(config.rpc_url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(requestTimeoutMs),
      headers: {
        accept: "application/json",
        authorization: config.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({ method, params }),
    });
    if (
      !response.ok ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
        response.headers.get("content-type") ?? "",
      )
    ) {
      throw new Error("HSD RPC transport failed");
    }
    const bytes = await readBounded(response);
    const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    const envelope = object(decoded);
    if (
      Object.keys(envelope).sort().join(",") !== "error,id,result" ||
      envelope.id !== null ||
      envelope.error !== null
    ) {
      throw new Error("HSD RPC returned an error");
    }
    return envelope.result;
  };
  return async (rootLabel) => {
    if (!validCommunityRouteRoot("hns", rootLabel)) {
      throw new Error("HSD root label is invalid");
    }
    const nameResult = object(await rpc("getnameinfo", [rootLabel, true]));
    const info = object(nameResult.info);
    if (info.state !== "CLOSED" || info.registered !== true || info.expired !== false) {
      throw new Error("HSD root is not active");
    }
    const resourceValue = await rpc("getnameresource", [rootLabel, true]);
    if (resourceValue === null) return [];
    const resource = object(resourceValue);
    if (Object.keys(resource).join(",") !== "records" || !Array.isArray(resource.records)) {
      throw new Error("HSD root resource is invalid");
    }
    return structuredClone(resource.records) as readonly HnsRootResourceRecordV1[];
  };
}
