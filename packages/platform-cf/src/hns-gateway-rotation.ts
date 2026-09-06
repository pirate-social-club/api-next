import { Schema } from "effect";
import type { Client } from "pg";

const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const Reference = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u));
const Rotation = Schema.Struct({
  version: Schema.Literal("hns-reviewed-gateway-rotation-v1"),
  previous_gateway_reference: Reference,
  gateway_reference: Reference,
  profile_sha256: Digest,
  handle_profile_sha256: Digest,
  manifest_json: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65536)),
  observed_at: Schema.String,
  readiness: Schema.Literal("operator_attested_shadow_ready"),
});
const ManifestBinding = Schema.Struct({
  schema: Schema.Literal("pirate-hns-community-app-handle-gateway-deployment-v1"),
  profile_sha256: Digest,
  handle_profile_sha256: Digest,
  gateway_certificate_spki_sha256: Digest,
});
export type HnsReviewedGatewayRotation = Schema.Schema.Type<typeof Rotation>;

/** This binds reviewed operator evidence, not a substitute for runtime manifest
 * validation or a claim that the shadow can serve a root before its fence moves.
 * Historical manifests are permitted for reviewed restoring successors. */
export async function requireHnsReviewedGatewayRotation(input: {
  readonly rotation: unknown;
  readonly previousGatewayReference: string;
  readonly certificateSpki: string;
  readonly observedAt: string;
}): Promise<HnsReviewedGatewayRotation> {
  const rotation = Schema.decodeUnknownSync(Rotation, { onExcessProperty: "error" })(
    input.rotation,
  );
  const bytes = new TextEncoder().encode(rotation.manifest_json);
  const raw: unknown = JSON.parse(rotation.manifest_json);
  const manifest = Schema.decodeUnknownSync(ManifestBinding)(raw);
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const observed = Date.parse(rotation.observed_at);
  const snapshot = Date.parse(input.observedAt);
  if (
    bytes.length > 65536 ||
    JSON.stringify(raw) !== rotation.manifest_json ||
    rotation.previous_gateway_reference !== input.previousGatewayReference ||
    rotation.gateway_reference === input.previousGatewayReference ||
    rotation.gateway_reference !== `hns-community-app-handle-gateway-sha256:${digest}` ||
    rotation.profile_sha256 !== manifest.profile_sha256 ||
    rotation.handle_profile_sha256 !== manifest.handle_profile_sha256 ||
    manifest.gateway_certificate_spki_sha256 !== input.certificateSpki ||
    !Number.isFinite(observed) ||
    !Number.isFinite(snapshot) ||
    Math.abs(observed - snapshot) > 3600000
  )
    throw new Error("Reviewed gateway rotation binding mismatch");
  return rotation;
}

/** The caller holds DNS/app/sale locks in its serializable promotion transaction.
 * A read-only preflight uses the same predicate without claiming those locks. */
export async function requireHnsGatewayRotationFence(input: {
  readonly client: Client;
  readonly dnsActivationId: string;
  readonly successorGeneration: number;
  readonly successorGatewayReference: string;
  readonly certificateSpki: string;
  readonly rotation?:
    | { readonly reviewed: unknown; readonly previousHealthGeneration: number }
    | undefined;
}) {
  const result = await input.client.query({
    text: `SELECT current.current_generation, revision.gateway_deployment_reference,
      revision.gateway_certificate_spki_sha256,
      COALESCE((SELECT max(health_generation) FROM hns_dns_zone_health_observations
        WHERE dns_zone_activation_id=current.dns_zone_activation_id
          AND activation_generation=current.current_generation),0) AS health_generation,
      to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at
      FROM hns_dns_zone_activation_current AS current
      JOIN hns_dns_zone_activation_revisions AS revision
        ON revision.dns_zone_activation_id=current.dns_zone_activation_id
        AND revision.dns_zone_activation_generation=current.current_generation
      WHERE current.dns_zone_activation_id=$1`,
    values: [input.dnsActivationId],
  });
  const row = result.rows[0];
  if (result.rows.length !== 1 || row === undefined)
    throw new Error("Gateway predecessor is unavailable");
  if (input.rotation === undefined) {
    if (row.gateway_deployment_reference !== input.successorGatewayReference)
      throw new Error("Gateway change requires reviewed rotation evidence");
    return;
  }
  const reviewed = await requireHnsReviewedGatewayRotation({
    rotation: input.rotation.reviewed,
    previousGatewayReference: String(row.gateway_deployment_reference),
    certificateSpki: String(row.gateway_certificate_spki_sha256),
    observedAt: String(row.observed_at),
  });
  if (
    Number(row.current_generation) + 1 !== input.successorGeneration ||
    reviewed.gateway_reference !== input.successorGatewayReference ||
    row.gateway_certificate_spki_sha256 !== input.certificateSpki ||
    !Number.isSafeInteger(input.rotation.previousHealthGeneration) ||
    Number(row.health_generation) !== input.rotation.previousHealthGeneration
  )
    throw new Error("Gateway rotation generation or identity fence changed");
}
