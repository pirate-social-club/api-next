import { Schema } from "effect";

export type GoldenHttpOptions = Readonly<{
  apiOrigin: string;
  authorization?: string;
  cookie?: string;
  csrfToken?: string;
}>;
export type GoldenHttpDependencies = Readonly<{
  fetcher: (input: string, init?: RequestInit) => Promise<Response>;
}>;

export class MegapotBaseSepoliaGoldenFailed extends Error {
  readonly code: "invalid-auth" | "invalid-input" | "invalid-options" | "request-failed";

  constructor(code: MegapotBaseSepoliaGoldenFailed["code"], message: string) {
    super(message);
    this.name = "MegapotBaseSepoliaGoldenFailed";
    this.code = code;
  }
}

function decode<S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
  } catch {
    throw new MegapotBaseSepoliaGoldenFailed(
      "request-failed",
      "The staging API returned an invalid rewards contract.",
    );
  }
}

export function endpoint(origin: string, path: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new MegapotBaseSepoliaGoldenFailed(
      "invalid-options",
      "The staging API origin is invalid.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.host !== "api-next-staging.pirate.sc" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new MegapotBaseSepoliaGoldenFailed("invalid-options", "Staging API required.");
  }
  const target = new URL(path, url);
  if (target.origin !== url.origin)
    throw new MegapotBaseSepoliaGoldenFailed("invalid-options", "Staging API required.");
  return target.toString();
}

export function authHeaders(
  options: GoldenHttpOptions,
  write: boolean,
  contentType = "application/json",
) {
  const headers = new Headers({ accept: "application/json" });
  if (options.authorization !== undefined) {
    if (
      options.cookie !== undefined ||
      options.csrfToken !== undefined ||
      options.authorization.includes("\n") ||
      !options.authorization.startsWith("Bearer ")
    ) {
      throw new MegapotBaseSepoliaGoldenFailed("invalid-auth", "Staging authorization is invalid.");
    }
    headers.set("authorization", options.authorization);
  } else {
    const cookie = options.cookie;
    const csrf = options.csrfToken;
    if (
      cookie === undefined ||
      csrf === undefined ||
      cookie.includes("\n") ||
      csrf.includes("\n") ||
      !cookie.includes("__Host-pirate_session=") ||
      !cookie.includes(`__Host-pirate_csrf=${csrf}`)
    ) {
      throw new MegapotBaseSepoliaGoldenFailed("invalid-auth", "Session and CSRF required.");
    }
    headers.set("cookie", cookie);
    headers.set("origin", "https://web-next-staging.pirate.sc");
    if (write) headers.set("x-csrf-token", csrf);
  }
  if (write) headers.set("content-type", contentType);
  return headers;
}

export async function requestJson<S extends Schema.ConstraintDecoder<unknown>>(
  dependencies: GoldenHttpDependencies,
  options: GoldenHttpOptions,
  path: string,
  schema: S,
  request?: {
    readonly method: "POST";
    readonly body: unknown;
    readonly contentType?: string;
    readonly rawBody?: boolean;
    readonly headers?: Readonly<Record<string, string>>;
  },
): Promise<S["Type"]> {
  const headers = authHeaders(
    options,
    request !== undefined,
    request?.contentType ?? "application/json",
  );
  for (const [name, value] of Object.entries(request?.headers ?? {})) headers.set(name, value);
  const response = await dependencies.fetcher(endpoint(options.apiOrigin, path), {
    method: request?.method ?? "GET",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers,
    ...(request === undefined
      ? {}
      : {
          body:
            request.rawBody === true
              ? (request.body as Bun.BodyInit)
              : JSON.stringify(request.body),
        }),
  });
  if (!response.ok) {
    const requestId = response.headers.get("x-request-id") ?? "missing";
    throw new MegapotBaseSepoliaGoldenFailed(
      "request-failed",
      `Staging rewards request failed with HTTP ${response.status}; request id ${requestId}.`,
    );
  }
  let document: unknown;
  try {
    document = (await response.json()) as unknown;
  } catch {
    throw new MegapotBaseSepoliaGoldenFailed(
      "request-failed",
      "The staging rewards response was not JSON.",
    );
  }
  return decode(schema, document);
}
