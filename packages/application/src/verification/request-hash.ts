import { Sha256Hex, type Sha256Hex as Sha256HexValue } from "@pirate/domain/verification";
import { Schema } from "effect";
import type { VerificationProviderStartInput } from "./adapter.ts";

export type VerificationRequestHashInput = Omit<
  VerificationProviderStartInput,
  "request_hash" | "requested_claim_ids"
>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/**
 * Hash the complete provider-neutral ceremony request. Provider query/flow
 * selection must derive from these same canonical fields; claim identifiers
 * are omitted because they are an exact projection of the requirements.
 */
export async function computeVerificationRequestHash(
  provider_id: string,
  input: VerificationRequestHashInput,
): Promise<Sha256HexValue> {
  const material = canonicalJson({
    hash_version: "verification-request-v1",
    actor_id: input.actor_id,
    intent_id: input.intent_id,
    provider_id,
    method: input.method,
    scope: input.scope,
    request_mode: input.request_mode,
    requested_requirements: input.requested_requirements,
    subject_binding_intent: input.subject_binding_intent,
    protocol_version: input.protocol_version,
    environment: input.environment,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return Schema.decodeUnknownSync(Sha256Hex)(hex);
}
