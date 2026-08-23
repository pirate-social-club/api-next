const encoder = new TextEncoder();

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export type StagingCredentials = Readonly<{
  accessKeyId: string;
  secretAccessKey: string;
}>;

export type SignRequestInput = Readonly<{
  accountId: string;
  bucket: string;
  key?: string;
  method: "GET" | "HEAD" | "PUT" | "POST" | "DELETE";
  query?: Readonly<Record<string, string>>;
  headers?: Readonly<Record<string, string>>;
  body?: Uint8Array;
  now?: Date;
  credentials: StagingCredentials;
}>;

export type SignedStagingRequest = Readonly<{
  method: SignRequestInput["method"];
  url: string;
  headers: Readonly<Record<string, string>>;
  body?: Uint8Array;
}>;

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function encodeR2PathSegment(value: string): string {
  return encodeRfc3986(value);
}

export function encodeR2Path(bucket: string, key?: string): string {
  const bucketPath = encodeR2PathSegment(bucket);
  if (key === undefined || key.length === 0) return `/${bucketPath}`;
  return `/${bucketPath}/${key.split("/").map(encodeR2PathSegment).join("/")}`;
}

export function encodeR2CopySource(bucket: string, key: string): string {
  return encodeR2Path(bucket, key);
}

function normalizeHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function canonicalHeaders(headers: Readonly<Record<string, string>>): {
  canonical: string;
  signed: string;
} {
  const normalized = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase().trim();
    if (lowerName.length === 0 || /[\r\n]/.test(lowerName)) {
      throw new Error("invalid signing header name");
    }
    if (/[\r\n]/.test(value)) throw new Error("invalid signing header value");
    normalized.set(lowerName, normalizeHeaderValue(value));
  }
  const entries = [...normalized.entries()].sort(([left], [right]) => left.localeCompare(right));
  return {
    canonical: entries.map(([name, value]) => `${name}:${value}\n`).join(""),
    signed: entries.map(([name]) => name).join(";"),
  };
}

function canonicalQuery(query: Readonly<Record<string, string>> | undefined): string {
  if (query === undefined) return "";
  return Object.entries(query)
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) => {
      if (leftName === rightName)
        return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
      return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
    })
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(key: Uint8Array, value: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value));
  return new Uint8Array(signature);
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signingKey(
  secret: string,
  date: string,
  region: string,
  service: string,
): Promise<Uint8Array> {
  const dateKey = await hmac(encoder.encode(`AWS4${secret}`), date);
  const regionKey = await hmac(dateKey, region);
  const serviceKey = await hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
}

function amzDate(now: Date): { short: string; full: string } {
  const iso = now.toISOString();
  return {
    short: iso.slice(0, 10).replaceAll("-", ""),
    full: `${iso.slice(0, 10).replaceAll("-", "")}${iso.slice(11, 19).replaceAll(":", "")}Z`,
  };
}

/** Build an AWS SigV4 request for the R2 S3-compatible endpoint. */
export async function signR2Request(input: SignRequestInput): Promise<SignedStagingRequest> {
  const body = input.body;
  const payloadHash = body === undefined ? EMPTY_SHA256 : await sha256Hex(body);
  const date = amzDate(input.now ?? new Date());
  const region = "auto";
  const service = "s3";
  const host = `${input.accountId}.r2.cloudflarestorage.com`;
  const path = encodeR2Path(input.bucket, input.key);
  const query = canonicalQuery(input.query);
  const headers: Record<string, string> = {
    ...(input.headers ?? {}),
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": date.full,
  };
  const canonical = canonicalHeaders(headers);
  const canonicalRequest = [
    input.method,
    path,
    query,
    canonical.canonical,
    canonical.signed,
    payloadHash,
  ].join("\n");
  const scope = `${date.short}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    date.full,
    scope,
    await sha256Hex(encoder.encode(canonicalRequest)),
  ].join("\n");
  const key = await signingKey(input.credentials.secretAccessKey, date.short, region, service);
  const signature = hex(await hmac(await key, stringToSign));
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${canonical.signed}, Signature=${signature}`;
  const url = `https://${host}${path}${query.length === 0 ? "" : `?${query}`}`;
  return {
    method: input.method,
    url,
    headers,
    ...(body === undefined ? {} : { body }),
  };
}
