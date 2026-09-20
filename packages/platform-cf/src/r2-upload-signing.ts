const encoder = new TextEncoder();

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function encodeObjectPath(bucket: string, key: string): string {
  return `/${encodeRfc3986(bucket)}/${key.split("/").map(encodeRfc3986).join("/")}`;
}

export function canonicalQuery(entries: readonly (readonly [string, string])[]): string {
  return entries
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) => {
      if (leftName === rightName)
        return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
      return leftName < rightName ? -1 : 1;
    })
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

export async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(value).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hmac(key: Uint8Array, value: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(key).buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value)));
}

export async function signingKey(secret: string, date: string): Promise<Uint8Array> {
  const dated = await hmac(encoder.encode(`AWS4${secret}`), date);
  const regional = await hmac(dated, "auto");
  const service = await hmac(regional, "s3");
  return hmac(service, "aws4_request");
}

export function amzDate(now: Date): Readonly<{ short: string; full: string }> {
  const iso = now.toISOString();
  const short = iso.slice(0, 10).replaceAll("-", "");
  return { short, full: `${short}T${iso.slice(11, 19).replaceAll(":", "")}Z` };
}
