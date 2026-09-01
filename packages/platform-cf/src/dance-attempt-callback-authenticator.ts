import {
  type DanceAttemptCallbackAuthenticator,
  danceAttemptCallbackSigningBytes,
} from "@pirate/application/dance/attempt-callback";

const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const KEY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function decodeSignature(value: string): Uint8Array | null {
  if (!SIGNATURE_PATTERN.test(value)) return null;
  try {
    const binary = atob(`${value}=`.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

export function makeDanceAttemptCallbackAuthenticator(input: {
  readonly keys: ReadonlyMap<string, Uint8Array>;
  readonly maxSkewMs: number;
  readonly nowMs: () => number;
}): DanceAttemptCallbackAuthenticator {
  if (!Number.isSafeInteger(input.maxSkewMs) || input.maxSkewMs < 1 || input.maxSkewMs > 300_000) {
    throw new Error("Invalid Dance callback skew policy");
  }
  const keys = new Map<string, Uint8Array>();
  for (const [version, key] of input.keys) {
    if (!KEY_VERSION_PATTERN.test(version) || key.length < 32) {
      throw new Error("Invalid Dance callback key registry");
    }
    keys.set(version, key.slice());
  }

  return {
    verify: async ({ keyVersion, timestamp, signature, rawBody }) => {
      if (!KEY_VERSION_PATTERN.test(keyVersion) || !/^[1-9][0-9]{0,15}$/u.test(timestamp)) {
        return false;
      }
      const receivedAt = Number(timestamp);
      const now = input.nowMs();
      if (
        !Number.isSafeInteger(receivedAt) ||
        !Number.isSafeInteger(now) ||
        Math.abs(now - receivedAt) > input.maxSkewMs
      ) {
        return false;
      }
      const signatureBytes = decodeSignature(signature);
      const keyBytes = keys.get(keyVersion);
      if (signatureBytes === null || keyBytes === undefined) return false;
      const key = await crypto.subtle.importKey(
        "raw",
        keyBytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      return crypto.subtle.verify(
        "HMAC",
        key,
        signatureBytes,
        danceAttemptCallbackSigningBytes({ keyVersion, timestamp, rawBody }),
      );
    },
  };
}
