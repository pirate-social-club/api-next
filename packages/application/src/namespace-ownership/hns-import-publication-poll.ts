import { canonicalJson } from "@pirate/domain";
import { Option, Schema } from "effect";
import { RouteAttachmentOwnershipSession } from "./adapter.ts";
import { decodeStrictHnsJsonBytes } from "./hns-evidence.ts";

/**
 * hns-txt-import-v1: the ownership poll for a community root import whose
 * publication plan is exposed.
 *
 * The request carries the immutable hns-txt-v1 ownership session and the plan
 * binding, but no clock. The verifier reads the publication authorization from
 * the database itself, so nothing the HTTP Worker sends can extend validity.
 * The response echoes the binding with the verifier's authoritative
 * `valid_until`, and wraps the unchanged target observation bytes so evidence
 * keeps its existing format and chain-derived expiry.
 */

export const HNS_TXT_IMPORT_PROTOCOL_VERSION = "hns-txt-import-v1" as const;
export const HNS_IMPORT_PUBLICATION_POLL_RESULT_VERSION =
  "pirate-hns-txt-import-v1-result" as const;
export const HNS_IMPORT_PUBLICATION_POLL_REQUEST_MAX_BYTES = 32_768;
export const HNS_IMPORT_PUBLICATION_POLL_RESPONSE_MAX_BYTES = 1_441_792;

const Sha256Hex = Schema.String.check(
  Schema.makeFilter((value) =>
    /^[0-9a-f]{64}$/u.test(value) ? undefined : "Expected a lowercase SHA-256 digest",
  ),
);

const BoundedIdentifier = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.trim() === value &&
    new TextEncoder().encode(value).byteLength <= 256 &&
    [...value].every((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point >= 0x20 && !(point >= 0x7f && point <= 0x9f);
    })
      ? undefined
      : "Expected a bounded identifier",
  ),
);

const CanonicalInstant = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
      ? undefined
      : "Expected a canonical ISO instant";
  }),
);

export const HnsImportPublicationPollBindingV1 = Schema.Struct({
  root_import_session_id: BoundedIdentifier,
  root_label: BoundedIdentifier,
  publish_plan_sha256: Sha256Hex,
  challenge_value_sha256: Sha256Hex,
});
export type HnsImportPublicationPollBindingV1 = Schema.Schema.Type<
  typeof HnsImportPublicationPollBindingV1
>;

export const HnsImportPublicationPollRequestV1 = Schema.Struct({
  operation_kind: Schema.Literal("route_attachment_import"),
  protocol_version: Schema.Literal(HNS_TXT_IMPORT_PROTOCOL_VERSION),
  session: RouteAttachmentOwnershipSession,
  binding: HnsImportPublicationPollBindingV1,
  payload: Schema.Struct({}),
});
export type HnsImportPublicationPollRequestV1 = Schema.Schema.Type<
  typeof HnsImportPublicationPollRequestV1
>;

export const HnsImportPublicationPollResultV1 = Schema.Struct({
  version: Schema.Literal(HNS_IMPORT_PUBLICATION_POLL_RESULT_VERSION),
  root_import_session_id: BoundedIdentifier,
  root_label: BoundedIdentifier,
  publish_plan_sha256: Sha256Hex,
  challenge_value_sha256: Sha256Hex,
  upstream_session_ref: Schema.NonEmptyString,
  valid_until: CanonicalInstant,
  observation_base64: Schema.NonEmptyString,
});
export type HnsImportPublicationPollResultV1 = Schema.Schema.Type<
  typeof HnsImportPublicationPollResultV1
>;

export class HnsImportPublicationPollDecodeError extends Error {
  override readonly name = "HnsImportPublicationPollDecodeError";
}

const encoder = new TextEncoder();
const exact = { onExcessProperty: "error" } as const;

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 !== 0) {
    throw new HnsImportPublicationPollDecodeError("observation is not canonical base64");
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  if (base64(bytes) !== value) {
    throw new HnsImportPublicationPollDecodeError("observation is not canonical base64");
  }
  return bytes;
}

/** SHA-256 of a challenge TXT value, as the publication authorization stores it. */
export async function hnsImportChallengeValueSha256(challengeValue: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(challengeValue));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function encodeHnsImportPublicationPollRequestV1(
  request: HnsImportPublicationPollRequestV1,
): Uint8Array {
  return encoder.encode(canonicalJson(request));
}

export function decodeHnsImportPublicationPollRequestV1(
  bytes: Uint8Array,
): HnsImportPublicationPollRequestV1 {
  const document = decodeStrictHnsJsonBytes(bytes, HNS_IMPORT_PUBLICATION_POLL_REQUEST_MAX_BYTES);
  const decoded = Schema.decodeUnknownOption(HnsImportPublicationPollRequestV1, exact)(document);
  if (Option.isNone(decoded)) {
    throw new HnsImportPublicationPollDecodeError("import poll request is invalid");
  }
  return decoded.value;
}

export function encodeHnsImportPublicationPollResultV1(
  input: Omit<HnsImportPublicationPollResultV1, "version" | "observation_base64"> &
    Readonly<{ readonly observation_bytes: Uint8Array }>,
): Uint8Array {
  const { observation_bytes, ...binding } = input;
  return encoder.encode(
    canonicalJson({
      version: HNS_IMPORT_PUBLICATION_POLL_RESULT_VERSION,
      ...binding,
      observation_base64: base64(observation_bytes),
    }),
  );
}

export function decodeHnsImportPublicationPollResultV1(bytes: Uint8Array): Readonly<{
  readonly result: HnsImportPublicationPollResultV1;
  readonly observation_bytes: Uint8Array;
}> {
  const document = decodeStrictHnsJsonBytes(bytes, HNS_IMPORT_PUBLICATION_POLL_RESPONSE_MAX_BYTES);
  const decoded = Schema.decodeUnknownOption(HnsImportPublicationPollResultV1, exact)(document);
  if (Option.isNone(decoded)) {
    throw new HnsImportPublicationPollDecodeError("import poll result is invalid");
  }
  return { result: decoded.value, observation_bytes: fromBase64(decoded.value.observation_base64) };
}
