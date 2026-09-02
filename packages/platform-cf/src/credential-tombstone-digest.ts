const encoder = new TextEncoder();
const DOMAIN = "pirate.account-erasure.credential-tombstone.v1";

export type CredentialTombstoneIdentity = Readonly<{
  provider: string;
  application: string;
  subject: string;
}>;

export type CredentialTombstoneKey = Readonly<{
  version: string;
  bytes: Uint8Array;
}>;

export type CredentialTombstoneDigest = Readonly<{
  keyVersion: string;
  digest: string;
}>;

const field = (value: string): Uint8Array => {
  const encoded = encoder.encode(value);
  if (encoded.byteLength === 0 || encoded.byteLength > 4_096) {
    throw new Error("Credential tombstone field is empty or too long");
  }
  const framed = new Uint8Array(4 + encoded.byteLength);
  new DataView(framed.buffer).setUint32(0, encoded.byteLength, false);
  framed.set(encoded, 4);
  return framed;
};

export const credentialTombstonePreimage = (identity: CredentialTombstoneIdentity): Uint8Array => {
  const parts = [
    field(DOMAIN),
    field(identity.provider),
    field(identity.application),
    field(identity.subject),
  ];
  const result = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
};

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const digest = async (
  key: CredentialTombstoneKey,
  identity: CredentialTombstoneIdentity,
): Promise<CredentialTombstoneDigest> => {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key.bytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    credentialTombstonePreimage(identity),
  );
  return { keyVersion: key.version, digest: hex(new Uint8Array(signature)) };
};

export const makeCredentialTombstoneDigester = (keys: readonly CredentialTombstoneKey[]) => {
  if (keys.length === 0) throw new Error("Credential tombstone key registry is empty");
  const versions = new Set<string>();
  for (const key of keys) {
    if (
      !/^[a-z0-9_-]{1,32}$/.test(key.version) ||
      versions.has(key.version) ||
      key.bytes.byteLength < 32
    ) {
      throw new Error("Credential tombstone key registry is invalid");
    }
    versions.add(key.version);
  }

  return {
    current: (identity: CredentialTombstoneIdentity) =>
      digest(keys[0] as CredentialTombstoneKey, identity),
    candidates: (identity: CredentialTombstoneIdentity) =>
      Promise.all(keys.map((key) => digest(key, identity))),
  };
};
