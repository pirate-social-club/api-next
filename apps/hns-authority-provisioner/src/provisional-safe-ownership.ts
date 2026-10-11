import {
  type HnsChainObservationResultV1,
  hnsObservedResourceMatchesEncodedPlanV1,
  validateHnsRootResourceRecordsV1,
} from "@pirate/application/namespace-ownership";
import { canonicalJson, validCommunityRouteRoot } from "@pirate/domain";

export type HnsProvisionalOwnershipContext = Readonly<{
  root_import_session_id: string;
  namespace_session_id: string;
  root_label: string;
  challenge_txt_value: string;
  publish_plan_sha256: string;
  plan_encoded_resource_sha256: string;
  lifecycle_revision: number;
  generation: number;
}>;

export class HnsProvisionalOwnershipError extends Error {
  override readonly name = "HnsProvisionalOwnershipError";
  constructor(readonly code: "invalid_context" | "unavailable" | "resource_pending") {
    super(code);
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The observer is bound to the configured HSD network and genesis. Its typed
// observed outcome represents an active name read inside a stable bracket.
export async function observeProvisionalSafeOwnership(
  context: HnsProvisionalOwnershipContext,
  observeSafe: (root: string) => Promise<HnsChainObservationResultV1>,
  now?: number,
): Promise<Readonly<{ proof_bytes: Uint8Array; proof_sha256: string }>> {
  if (
    !validCommunityRouteRoot("hns", context.root_label) ||
    !context.root_import_session_id ||
    !context.namespace_session_id ||
    !context.challenge_txt_value.startsWith("pirate-verification=") ||
    !/^[0-9a-f]{64}$/u.test(context.publish_plan_sha256) ||
    !/^[0-9a-f]{64}$/u.test(context.plan_encoded_resource_sha256) ||
    !Number.isSafeInteger(context.lifecycle_revision) ||
    context.lifecycle_revision < 1 ||
    !Number.isSafeInteger(context.generation) ||
    context.generation < 1
  ) {
    throw new HnsProvisionalOwnershipError("invalid_context");
  }
  const result = await observeSafe(context.root_label);
  if (result.kind !== "observed") throw new HnsProvisionalOwnershipError("unavailable");
  const observation = result.observation;
  const checkedAt = now ?? Date.now();
  if (
    observation.view !== "safe" ||
    observation.commitment === null ||
    observation.network !== observation.anchor.network ||
    observation.genesis_block_hash !== observation.anchor.genesis_block_hash ||
    !Number.isFinite(observation.observed_at_epoch_ms) ||
    observation.observed_at_epoch_ms > checkedAt ||
    checkedAt - observation.observed_at_epoch_ms > 900_000
  ) {
    throw new HnsProvisionalOwnershipError("unavailable");
  }
  const records = validateHnsRootResourceRecordsV1(observation.records);
  const encoder = new TextEncoder();
  const resourceSha = await sha256(encoder.encode(canonicalJson(records)));
  if (resourceSha !== observation.resource_sha256) {
    throw new HnsProvisionalOwnershipError("unavailable");
  }
  if (
    !records.some(
      (record) =>
        record.type === "TXT" &&
        Array.isArray(record.txt) &&
        record.txt.every((chunk) => typeof chunk === "string") &&
        record.txt.join("") === context.challenge_txt_value,
    ) ||
    !(await hnsObservedResourceMatchesEncodedPlanV1(records, context.plan_encoded_resource_sha256))
  ) {
    throw new HnsProvisionalOwnershipError("resource_pending");
  }
  const { challenge_txt_value, ...binding } = context;
  const proof_bytes = encoder.encode(
    canonicalJson({
      version: "pirate-hns-provisional-safe-ownership-v1",
      ...binding,
      challenge_value_sha256: await sha256(encoder.encode(challenge_txt_value)),
      observation,
    }),
  );
  return { proof_bytes, proof_sha256: await sha256(proof_bytes) };
}
