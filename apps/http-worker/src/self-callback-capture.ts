import type {
  SelfCallbackCaptureReplay,
  SelfCallbackCaptureStatus,
} from "./self-callback-capture-do.ts";

export type SelfCallbackCaptureNamespace = {
  readonly idFromName: (name: string) => unknown;
  readonly get: (id: unknown) => {
    readonly fetch: (request: Request | string, init?: RequestInit) => Promise<Response>;
  };
};

export type SelfCallbackCaptureService = {
  readonly capture: (
    providerId: string,
    rawBody: string,
    headers: Readonly<Record<string, string>>,
  ) => Promise<SelfCallbackCaptureStatus>;
  readonly status: () => Promise<SelfCallbackCaptureStatus>;
  readonly replay: () => Promise<SelfCallbackCaptureReplay>;
  readonly clear: () => Promise<{ readonly cleared: boolean }>;
};

const INSTANCE_NAME = "physical-ceremony-callback";
const INTERNAL_ORIGIN = "https://self-callback-capture.invalid";

const serviceResponse = async (response: Response): Promise<unknown> => {
  if (!response.ok) throw new Error("Self callback capture unavailable");
  return response.json();
};

export const makeSelfCallbackCaptureService = (
  namespace: SelfCallbackCaptureNamespace,
): SelfCallbackCaptureService => {
  const stub = namespace.get(namespace.idFromName(INSTANCE_NAME));
  const request = (path: string, init?: RequestInit): Promise<Response> =>
    stub.fetch(`${INTERNAL_ORIGIN}${path}`, init);
  return {
    capture: async (providerId, rawBody, headers) => {
      const response = await request("/capture", {
        method: "POST",
        body: new TextEncoder().encode(rawBody),
        headers: {
          "x-callback-provider": providerId,
          "x-callback-headers": JSON.stringify(headers),
        },
      });
      return (await serviceResponse(response)) as SelfCallbackCaptureStatus;
    },
    status: async () =>
      (await serviceResponse(await request("/status"))) as SelfCallbackCaptureStatus,
    replay: async () => {
      const response = await request("/replay", { method: "POST" });
      if (!response.ok) throw new Error("Self callback capture unavailable");
      const body = new Uint8Array(await response.arrayBuffer());
      const rawBody = new TextDecoder("utf-8", { fatal: true }).decode(body);
      const providerId = response.headers.get("x-callback-provider");
      const digest = response.headers.get("x-callback-digest");
      const length = Number(response.headers.get("x-callback-length"));
      const headerJson = response.headers.get("x-callback-headers");
      if (
        providerId === null ||
        digest === null ||
        headerJson === null ||
        !Number.isSafeInteger(length) ||
        length !== body.byteLength
      ) {
        throw new Error("Self callback capture unavailable");
      }
      let headers: unknown;
      try {
        headers = JSON.parse(headerJson);
      } catch {
        throw new Error("Self callback capture unavailable");
      }
      if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
        throw new Error("Self callback capture unavailable");
      }
      return {
        provider_id: providerId,
        raw_body: rawBody,
        headers: headers as Readonly<Record<string, string>>,
        digest,
        length,
      };
    },
    clear: async () =>
      (await serviceResponse(await request("/capture", { method: "DELETE" }))) as {
        cleared: boolean;
      },
  };
};
