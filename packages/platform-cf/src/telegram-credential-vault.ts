import type { CredentialVault } from "@pirate/application/telegram";

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid credential envelope");
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (character) =>
    character.charCodeAt(0),
  );
}

/** Versioned key ring permits rotation while existing envelopes remain readable. */
export async function makeTelegramCredentialVault(input: {
  activeVersion: string;
  keys: Readonly<Record<string, string>>;
}): Promise<CredentialVault> {
  if (!/^[A-Za-z0-9_-]{1,32}$/u.test(input.activeVersion))
    throw new Error("Invalid credential key version");
  const keys = new Map<string, CryptoKey>();
  for (const [version, encoded] of Object.entries(input.keys)) {
    const bytes = decode(encoded);
    if (bytes.byteLength !== 32) throw new Error("Credential wrapping keys require 256 bits");
    keys.set(
      version,
      await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]),
    );
  }
  const active = keys.get(input.activeVersion);
  if (!active) throw new Error("Active credential wrapping key unavailable");
  const encoder = new TextEncoder();
  return {
    async seal(value, context) {
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: nonce,
          additionalData: encoder.encode(`${input.activeVersion}:${context}`),
        },
        active,
        encoder.encode(value),
      );
      return `${input.activeVersion}.${encode(nonce)}.${encode(new Uint8Array(ciphertext))}`;
    },
    async open(value, context) {
      try {
        const [version, nonce, ciphertext, extra] = value.split(".");
        if (!version || !nonce || !ciphertext || extra !== undefined) throw new Error();
        const key = keys.get(version);
        const iv = decode(nonce);
        if (!key || iv.byteLength !== 12) throw new Error();
        const plaintext = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: encoder.encode(`${version}:${context}`) },
          key,
          decode(ciphertext),
        );
        return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
      } catch {
        // Never retain provider input or crypto errors in logs or API failures.
        throw new Error("Credential envelope could not be opened");
      }
    },
    async hash(value) {
      return encode(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
    },
    token() {
      return encode(crypto.getRandomValues(new Uint8Array(32)));
    },
  };
}
