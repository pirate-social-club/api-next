import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { canonicalJson } from "@pirate/domain";
import { Schema } from "effect";
import { validateHnsRootResourceRecordsV1 } from "../../application/src/namespace-ownership/hns-root-import-plan.ts";
import { requireHnsReviewedGatewayRotation } from "./hns-gateway-rotation.ts";

const Review = Schema.Struct({
  version: Schema.Literal("hns-reviewed-staging-gateway-relocation-v1"),
  root_label: Schema.String,
  previous_generation: Schema.Number,
  previous_health_generation: Schema.Number,
  previous_gateway_ipv4: Schema.String,
  gateway_ipv4: Schema.Literal("94.103.168.209"),
  previous_chain_records: Schema.Array(Schema.Unknown),
  chain_records: Schema.Array(Schema.Unknown),
  gateway_rotation: Schema.Unknown,
});

export class HnsStagingRelocationRefusal extends Error {
  override readonly name = "HnsStagingRelocationRefusal";
}

const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

/** A staging successor may move address records and one ns1 glue record while
 * retaining every other chain record, signing identity and predecessor fence. */
export async function requireHnsStagingRelocationReview(input: {
  readonly review: unknown;
  readonly predecessor: {
    readonly environment: string;
    readonly root_label: string;
    readonly generation: number;
    readonly health_generation: number;
    readonly gateway_reference: string;
    readonly certificate_spki: string;
    readonly chain_reference: string;
  };
  readonly observed: {
    readonly root_label: string;
    readonly gateway_deployment_reference: string;
    readonly gateway_certificate_spki_sha256: string;
    readonly chain_resource_sha256: string;
  };
  readonly observed_at: string;
}) {
  let review: Schema.Schema.Type<typeof Review>;
  try {
    review = Schema.decodeUnknownSync(Review, { onExcessProperty: "error" })(input.review);
  } catch {
    throw new HnsStagingRelocationRefusal("the staging relocation review is malformed");
  }
  const state = input.predecessor;
  if (
    state.environment !== "staging" ||
    review.root_label !== state.root_label ||
    input.observed.root_label !== state.root_label ||
    !Number.isSafeInteger(review.previous_generation) ||
    review.previous_generation < 1 ||
    review.previous_generation !== state.generation ||
    !Number.isSafeInteger(review.previous_health_generation) ||
    review.previous_health_generation < 0 ||
    review.previous_health_generation !== state.health_generation ||
    isIP(review.previous_gateway_ipv4) !== 4 ||
    review.previous_gateway_ipv4 === review.gateway_ipv4 ||
    input.observed.gateway_certificate_spki_sha256 !== state.certificate_spki
  )
    throw new HnsStagingRelocationRefusal("the staging relocation predecessor fence changed");
  const records = (value: readonly unknown[]) => {
    try {
      return validateHnsRootResourceRecordsV1(value);
    } catch {
      throw new HnsStagingRelocationRefusal("the staging relocation chain records are malformed");
    }
  };
  const previous = records(review.previous_chain_records);
  const next = records(review.chain_records);
  let changedGlue = 0;
  const expected = previous.map((record) => {
    if (
      record.type === "GLUE4" &&
      String(record.ns).replace(/\.$/u, "") === "ns1.8s28" &&
      record.address === review.previous_gateway_ipv4
    ) {
      changedGlue += 1;
      return { ...record, address: review.gateway_ipv4 };
    }
    return record;
  });
  if (
    (state.root_label === "8s28" ? changedGlue !== 1 : changedGlue !== 0) ||
    canonicalJson(expected) !== canonicalJson(next) ||
    state.chain_reference !== `hns-root-chain:${hash(previous)}` ||
    input.observed.chain_resource_sha256 !== hash(next)
  )
    throw new HnsStagingRelocationRefusal(
      "the staging relocation changed unreviewed chain records",
    );
  const rotation = await requireHnsReviewedGatewayRotation({
    rotation: review.gateway_rotation,
    previousGatewayReference: state.gateway_reference,
    certificateSpki: state.certificate_spki,
    observedAt: input.observed_at,
    environment: state.environment,
  }).catch(() => {
    throw new HnsStagingRelocationRefusal("the staging relocation gateway review is invalid");
  });
  if (rotation.gateway_reference !== input.observed.gateway_deployment_reference)
    throw new HnsStagingRelocationRefusal("the staging relocation gateway is not the reviewed one");
  return {
    previous_gateway_ipv4: review.previous_gateway_ipv4,
    gateway_ipv4: review.gateway_ipv4,
    rotation: { reviewed: rotation, previousHealthGeneration: review.previous_health_generation },
  };
}
