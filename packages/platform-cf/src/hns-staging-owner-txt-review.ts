import { createHash } from "node:crypto";
import { canonicalJson } from "@pirate/domain";
import { Schema } from "effect";
import { validateHnsRootResourceRecordsV1 } from "../../application/src/namespace-ownership/hns-root-import-plan.ts";

const Review = Schema.Struct({
  version: Schema.Literal("hns-reviewed-staging-owner-txt-v1"),
  root_label: Schema.String,
  community_id: Schema.String,
  route_binding_id: Schema.String,
  binding_generation: Schema.Number,
  evidence_ref: Schema.String,
  recovery_attempt_id: Schema.String,
  dns_zone_activation_id: Schema.String,
  app_host_activation_id: Schema.String,
  app_generation: Schema.Number,
  sale_namespace_activation_id: Schema.String,
  sale_generation: Schema.Number,
  previous_generation: Schema.Number,
  previous_health_generation: Schema.Number,
  previous_chain_records: Schema.Array(Schema.Unknown),
  chain_records: Schema.Array(Schema.Unknown),
});

export class HnsStagingOwnerTxtRefusal extends Error {
  override readonly name = "HnsStagingOwnerTxtRefusal";
}

export function decodeHnsStagingOwnerTxtReview(review: unknown) {
  try {
    return Schema.decodeUnknownSync(Review, { onExcessProperty: "error" })(review);
  } catch {
    throw new HnsStagingOwnerTxtRefusal("the staging owner TXT review is malformed");
  }
}

export type HnsStagingOwnerTxtRecovery = Readonly<{
  community_id: string;
  route_binding_id: string;
  binding_generation: string;
  evidence_ref: string;
  recovery_attempt_id: string;
  dns_zone_activation_id: string;
  app_host_activation_id: string;
  app_generation: string;
  sale_namespace_activation_id: string;
  sale_generation: string;
  root_label: string;
  previous_txt_sha256: string;
  txt_sha256: string;
  expires_at: Date;
}>;

const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const txtHash = (record: { readonly type: string; readonly [key: string]: unknown }) => {
  if (record.type !== "TXT") return null;
  try {
    const chunks = Schema.decodeUnknownSync(Schema.Array(Schema.String))(record.txt);
    return createHash("sha256").update(chunks.join("")).digest("hex");
  } catch {
    return null;
  }
};

/** Replace one whole parent TXT record. All other records, order and chunks
 * remain exact; the database proof supplies both identities, never the operator. */
export function requireHnsStagingOwnerTxtReview(input: {
  readonly review: unknown;
  readonly recovery: HnsStagingOwnerTxtRecovery;
  readonly predecessor: {
    readonly environment: string;
    readonly root_label: string;
    readonly generation: number;
    readonly health_generation: number;
    readonly chain_reference: string;
  };
  readonly observed_chain_sha256: string;
  readonly database_time: number;
}) {
  const review = decodeHnsStagingOwnerTxtReview(input.review);
  const state = input.predecessor;
  const proof = input.recovery;
  if (
    state.environment !== "staging" ||
    state.root_label !== review.root_label ||
    proof.root_label !== review.root_label ||
    proof.community_id !== review.community_id ||
    proof.route_binding_id !== review.route_binding_id ||
    proof.evidence_ref !== review.evidence_ref ||
    proof.recovery_attempt_id !== review.recovery_attempt_id ||
    proof.dns_zone_activation_id !== review.dns_zone_activation_id ||
    proof.app_host_activation_id !== review.app_host_activation_id ||
    proof.sale_namespace_activation_id !== review.sale_namespace_activation_id ||
    !Number.isSafeInteger(review.app_generation) ||
    review.app_generation < 1 ||
    Number(proof.app_generation) !== review.app_generation ||
    !Number.isSafeInteger(review.sale_generation) ||
    review.sale_generation < 1 ||
    Number(proof.sale_generation) !== review.sale_generation ||
    Number(proof.binding_generation) !== review.binding_generation ||
    !Number.isSafeInteger(review.binding_generation) ||
    review.binding_generation < 3 ||
    !Number.isSafeInteger(review.previous_generation) ||
    review.previous_generation < 1 ||
    review.previous_generation !== state.generation ||
    !Number.isSafeInteger(review.previous_health_generation) ||
    review.previous_health_generation < 1 ||
    review.previous_health_generation !== state.health_generation ||
    !Number.isFinite(input.database_time) ||
    !(proof.expires_at.getTime() > input.database_time) ||
    !/^[0-9a-f]{64}$/u.test(proof.previous_txt_sha256) ||
    !/^[0-9a-f]{64}$/u.test(proof.txt_sha256) ||
    proof.previous_txt_sha256 === proof.txt_sha256
  )
    throw new HnsStagingOwnerTxtRefusal("the staging owner TXT recovery fence changed");
  const records = (values: readonly unknown[]) => {
    try {
      return validateHnsRootResourceRecordsV1(values);
    } catch {
      throw new HnsStagingOwnerTxtRefusal("the staging owner TXT chain records are malformed");
    }
  };
  const previous = records(review.previous_chain_records);
  const next = records(review.chain_records);
  const oldMatches = previous.filter((record) => txtHash(record) === proof.previous_txt_sha256);
  const newMatches = next.filter((record) => txtHash(record) === proof.txt_sha256);
  const replacement = newMatches[0];
  const expected = previous.map((record) =>
    txtHash(record) === proof.previous_txt_sha256 ? replacement : record,
  );
  if (
    oldMatches.length !== 1 ||
    newMatches.length !== 1 ||
    replacement === undefined ||
    previous.some((record) => txtHash(record) === proof.txt_sha256) ||
    next.some((record) => txtHash(record) === proof.previous_txt_sha256) ||
    canonicalJson(expected) !== canonicalJson(next) ||
    state.chain_reference !== `hns-root-chain:${hash(previous)}` ||
    input.observed_chain_sha256 !== hash(next)
  )
    throw new HnsStagingOwnerTxtRefusal(
      "the staging owner TXT review changed unreviewed chain records",
    );
}
