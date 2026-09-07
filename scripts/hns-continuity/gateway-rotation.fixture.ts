import { createHash } from "node:crypto";

export function rotationFixture(
  state: {
    dns: { gateway_deployment_reference: string; gateway_certificate_spki_sha256: string };
    database_time: string;
  },
  suffix = "successor",
) {
  const manifest_json = JSON.stringify({
    schema: "pirate-hns-community-app-handle-gateway-deployment-v1",
    profile_sha256: "c4f4c07252ba10a25467f476cc5b56d50ef9cf02e25ad368a05551d19ba861ed",
    handle_profile_sha256: "b4440ab21ae73a73d3ab3549bcaaa66c1e27891e22cdd308d4377b0b6eb549dc",
    gateway_certificate_spki_sha256: state.dns.gateway_certificate_spki_sha256,
    fixture: suffix,
  });
  const manifest = JSON.parse(manifest_json);
  return {
    version: "hns-reviewed-gateway-rotation-v1",
    previous_gateway_reference: state.dns.gateway_deployment_reference,
    gateway_reference: `hns-community-app-handle-gateway-sha256:${createHash("sha256").update(manifest_json).digest("hex")}`,
    profile_sha256: manifest.profile_sha256,
    handle_profile_sha256: manifest.handle_profile_sha256,
    manifest_json,
    observed_at: state.database_time,
    readiness: "operator_attested_shadow_ready",
  };
}
