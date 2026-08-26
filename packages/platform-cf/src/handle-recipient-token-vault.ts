import {
  HandleRecipientTokenCryptoFailed,
  type HandleRecipientTokenVault,
} from "@pirate/application";
import { Effect } from "effect";

type KeyEntry = Readonly<{ version: string; bytes: Uint8Array }>;

export type HandleRecipientTokenVaultOptions = Readonly<{
  /** Ordered newest first: `version:base64url-32-bytes,...`. */
  hmacKeys: string;
  /** Ordered newest first: `version:base64url-32-bytes,...`. */
  envelopeKeys: string;
}>;

const failed = (
  reason: HandleRecipientTokenCryptoFailed["reason"],
): HandleRecipientTokenCryptoFailed => new HandleRecipientTokenCryptoFailed({ reason });

const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const base64UrlDecode = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid base64url");
  const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat(
    (4 - (value.length % 4)) % 4,
  )}`;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const parseKeys = (encoded: string): readonly KeyEntry[] => {
  if (encoded.length === 0 || encoded.trim() !== encoded) throw new Error("missing key ring");
  const versions = new Set<string>();
  const values = encoded.split(",").map((entry) => {
    const separator = entry.indexOf(":");
    if (separator < 1) throw new Error("invalid key ring");
    const version = entry.slice(0, separator);
    const material = entry.slice(separator + 1);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u.test(version) || versions.has(version)) {
      throw new Error("invalid key version");
    }
    versions.add(version);
    const bytes = base64UrlDecode(material);
    if (bytes.byteLength !== 32 || base64UrlEncode(bytes) !== material) {
      throw new Error("invalid key material");
    }
    return { version, bytes };
  });
  if (values.length === 0 || values.length > 4) throw new Error("invalid key ring size");
  return values;
};

const configured = (
  options: HandleRecipientTokenVaultOptions,
): Readonly<{ hmac: readonly KeyEntry[]; envelope: readonly KeyEntry[] }> => {
  const hmac = parseKeys(options.hmacKeys);
  const envelope = parseKeys(options.envelopeKeys);
  const hmacMaterial = new Set(hmac.map(({ bytes }) => base64UrlEncode(bytes)));
  if (envelope.some(({ bytes }) => hmacMaterial.has(base64UrlEncode(bytes)))) {
    throw new Error("handle token key purposes must be independent");
  }
  return { hmac, envelope };
};

const hmacHex = async (keyBytes: Uint8Array, value: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const aesKey = (bytes: Uint8Array) =>
  crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

export function makeHandleRecipientTokenVault(
  options: HandleRecipientTokenVaultOptions,
): HandleRecipientTokenVault["Service"] {
  const load = (): ReturnType<typeof configured> => configured(options);
  return {
    mint: Effect.try({
      try: () => {
        load();
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        return `hgrt_${base64UrlEncode(bytes)}`;
      },
      catch: () => failed("configuration"),
    }),
    lookupCandidates: (token) =>
      Effect.tryPromise({
        try: async () => {
          if (!/^hgrt_[A-Za-z0-9_-]{43}$/u.test(token)) throw new Error("invalid token");
          return Promise.all(
            load().hmac.map(async ({ version, bytes }) => ({
              keyVersion: version,
              digest: await hmacHex(bytes, token),
            })),
          );
        },
        catch: (error) =>
          failed(
            error instanceof Error && error.message === "invalid token"
              ? "crypto"
              : "configuration",
          ),
      }),
    seal: (token, associatedData) =>
      Effect.tryPromise({
        try: async () => {
          const current = load().envelope[0];
          if (current === undefined) throw new Error("missing envelope key");
          const nonce = crypto.getRandomValues(new Uint8Array(12));
          const ciphertext = new Uint8Array(
            await crypto.subtle.encrypt(
              {
                name: "AES-GCM",
                iv: nonce,
                additionalData: new TextEncoder().encode(associatedData),
              },
              await aesKey(current.bytes),
              new TextEncoder().encode(token),
            ),
          );
          const combined = new Uint8Array(nonce.byteLength + ciphertext.byteLength);
          combined.set(nonce);
          combined.set(ciphertext, nonce.byteLength);
          return { keyVersion: current.version, ciphertext: combined };
        },
        catch: () => failed("crypto"),
      }),
    reveal: (sealed, associatedData) =>
      Effect.tryPromise({
        try: async () => {
          const key = load().envelope.find(({ version }) => version === sealed.keyVersion);
          if (key === undefined || sealed.ciphertext.byteLength < 29) {
            throw new Error("invalid ciphertext");
          }
          const plaintext = await crypto.subtle.decrypt(
            {
              name: "AES-GCM",
              iv: sealed.ciphertext.slice(0, 12),
              additionalData: new TextEncoder().encode(associatedData),
            },
            await aesKey(key.bytes),
            sealed.ciphertext.slice(12),
          );
          const token = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
          if (!/^hgrt_[A-Za-z0-9_-]{43}$/u.test(token)) throw new Error("invalid ciphertext");
          return token;
        },
        catch: () => failed("invalid-ciphertext"),
      }),
  };
}
