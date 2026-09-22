import { canonicalJson, validCommunityRouteRoot } from "@pirate/domain";
import { Option, Schema } from "effect";
import { decodeStrictHnsJsonBytes } from "./hns-evidence.ts";

export const HNS_ROOT_IMPORT_NAME_PROOF_VERSION = "pirate-hns-root-import-name-proof-v1" as const;
export const HNS_COMMUNITY_ROOT_IMPORT_NAME_PROOF_VERSION =
  "pirate-hns-community-root-import-name-proof-v1" as const;
export const HNS_ROOT_IMPORT_NAME_PROOF_RESULT_VERSION =
  "pirate-hns-root-import-name-proof-result-v1" as const;
export const HNS_ROOT_IMPORT_NAME_PROOF_NETWORK = "main" as const;
export const HNS_ROOT_IMPORT_NAME_PROOF_MESSAGE_MAX_BYTES = 2_048 as const;
export const HNS_ROOT_IMPORT_NAME_SIGNATURE_MAX_BYTES = 512 as const;
export const HNS_ROOT_IMPORT_NAME_PROOF_RESULT_MAX_BYTES = 1_024 as const;

const encoder = new TextEncoder();
const canonicalBase64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const exactParseOptions = { onExcessProperty: "error" } as const;

function canonicalCompactSignature(value: string): boolean {
  try {
    const decoded = atob(value);
    return decoded.length === 64 && btoa(decoded) === value;
  } catch {
    return false;
  }
}

function controlFree(value: string): boolean {
  return [...value].every((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point >= 0x20 && !(point >= 0x7f && point <= 0x9f);
  });
}

function boundedText(maximumBytes: number, label: string) {
  return Schema.NonEmptyString.check(
    Schema.makeFilter((value) =>
      value.trim() === value &&
      controlFree(value) &&
      encoder.encode(value).byteLength <= maximumBytes
        ? undefined
        : `Expected bounded canonical ${label}`,
    ),
  );
}

export const HnsRootImportNameSignature = boundedText(
  HNS_ROOT_IMPORT_NAME_SIGNATURE_MAX_BYTES,
  "HNS name signature",
).check(
  Schema.makeFilter((value) =>
    canonicalBase64Pattern.test(value) && canonicalCompactSignature(value)
      ? undefined
      : "Expected a canonical compact HNS name signature",
  ),
);
export type HnsRootImportNameSignature = Schema.Schema.Type<typeof HnsRootImportNameSignature>;

export const HnsRootImportNameProofResultV1 = Schema.Struct({
  version: Schema.Literal(HNS_ROOT_IMPORT_NAME_PROOF_RESULT_VERSION),
  root_label: boundedText(63, "HNS root label").check(
    Schema.makeFilter((value) =>
      validCommunityRouteRoot("hns", value) ? undefined : "Expected a canonical HNS root label",
    ),
  ),
  message_sha256: Schema.String.check(
    Schema.makeFilter((value) =>
      sha256Pattern.test(value) ? undefined : "Expected a message SHA-256 digest",
    ),
  ),
  signature_sha256: Schema.String.check(
    Schema.makeFilter((value) =>
      sha256Pattern.test(value) ? undefined : "Expected a signature SHA-256 digest",
    ),
  ),
  safe: Schema.Literal(true),
  verified: Schema.Boolean,
});
export type HnsRootImportNameProofResultV1 = Schema.Schema.Type<
  typeof HnsRootImportNameProofResultV1
>;

export type HnsRootImportNameProofMessageInput = Readonly<{
  actor_id: string;
  creation_intent_id: string;
  ceremony_intent_id: string;
  root_import_session_id: string;
  namespace_session_id: string;
  root_label: string;
  challenge_txt_value: string;
  environment: string;
  expires_at: string;
}>;

export function hnsRootImportNameProofMessage(input: HnsRootImportNameProofMessageInput): string {
  if (!validCommunityRouteRoot("hns", input.root_label)) {
    throw new TypeError("HNS name-proof root is invalid");
  }
  const message = canonicalJson([
    HNS_ROOT_IMPORT_NAME_PROOF_VERSION,
    input.actor_id,
    input.creation_intent_id,
    input.ceremony_intent_id,
    input.root_import_session_id,
    input.namespace_session_id,
    input.root_label,
    HNS_ROOT_IMPORT_NAME_PROOF_NETWORK,
    input.environment,
    input.expires_at,
    input.challenge_txt_value,
  ]);
  if (
    message.length === 0 ||
    !controlFree(message) ||
    encoder.encode(message).byteLength > HNS_ROOT_IMPORT_NAME_PROOF_MESSAGE_MAX_BYTES
  ) {
    throw new TypeError("HNS name-proof message exceeds its bound");
  }
  return message;
}

export type HnsCommunityRootImportNameProofMessageInput = Readonly<{
  actor_id: string;
  community_id: string;
  attachment_intent_id: string;
  root_import_session_id: string;
  namespace_session_id: string;
  root_label: string;
  challenge_txt_value: string;
  environment: string;
  expires_at: string;
}>;

export function hnsCommunityRootImportNameProofMessage(
  input: HnsCommunityRootImportNameProofMessageInput,
): string {
  if (!validCommunityRouteRoot("hns", input.root_label)) {
    throw new TypeError("HNS community name-proof root is invalid");
  }
  const message = canonicalJson([
    HNS_COMMUNITY_ROOT_IMPORT_NAME_PROOF_VERSION,
    input.actor_id,
    input.community_id,
    input.attachment_intent_id,
    input.root_import_session_id,
    input.namespace_session_id,
    input.root_label,
    HNS_ROOT_IMPORT_NAME_PROOF_NETWORK,
    input.environment,
    input.expires_at,
    input.challenge_txt_value,
  ]);
  if (
    message.length === 0 ||
    !controlFree(message) ||
    encoder.encode(message).byteLength > HNS_ROOT_IMPORT_NAME_PROOF_MESSAGE_MAX_BYTES
  ) {
    throw new TypeError("HNS community name-proof message exceeds its bound");
  }
  return message;
}

export function encodeHnsRootImportNameProofResultV1(
  input: HnsRootImportNameProofResultV1,
): Uint8Array {
  const decoded = Schema.decodeUnknownOption(
    HnsRootImportNameProofResultV1,
    exactParseOptions,
  )(input);
  if (Option.isNone(decoded)) throw new TypeError("HNS name-proof result is invalid");
  const bytes = encoder.encode(JSON.stringify(decoded.value));
  if (bytes.byteLength === 0 || bytes.byteLength > HNS_ROOT_IMPORT_NAME_PROOF_RESULT_MAX_BYTES) {
    throw new TypeError("HNS name-proof result exceeds its bound");
  }
  return bytes;
}

export function decodeHnsRootImportNameProofResultV1(
  bytes: Uint8Array,
): HnsRootImportNameProofResultV1 {
  const value = decodeStrictHnsJsonBytes(bytes, HNS_ROOT_IMPORT_NAME_PROOF_RESULT_MAX_BYTES);
  const decoded = Schema.decodeUnknownOption(
    HnsRootImportNameProofResultV1,
    exactParseOptions,
  )(value);
  if (Option.isNone(decoded)) throw new TypeError("HNS name-proof result is invalid");
  return decoded.value;
}
