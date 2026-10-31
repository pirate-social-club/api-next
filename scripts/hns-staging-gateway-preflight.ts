import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const manifestHost = "ubuntu@94.103.168.209";
const manifestPath = "/srv/pirate-hns-staging/public-gateway/current/deployment-manifest.json";
const gatewayPrefix = "hns-community-app-handle-gateway-sha256:";

export const HNS_STAGING_MANIFEST_COMMAND = [
  "timeout",
  "15s",
  "ssh",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=8",
  "-o",
  "StrictHostKeyChecking=yes",
  manifestHost,
  "cat",
  manifestPath,
] as const;

/** The post-deploy check while a cutover is pending: Solid's release check
 * pairs with the live gateway first, which a pending cutover cannot pass. */
export const HNS_STAGING_DIRECT_CHECK_COMMAND = [
  "node",
  "--input-type=module",
  "-e",
  "const check = await import('./scripts/staging-release-check.mjs'); console.log(JSON.stringify(await check.checkDirectStaging()));",
] as const;

function pinnedPairMatches(pair: unknown, reference: string, fingerprint: unknown): boolean {
  if (typeof pair !== "object" || pair === null || Array.isArray(pair)) return false;
  const expected = pair as Record<string, unknown>;
  return (
    expected.gateway_reference === reference &&
    expected.solid_ingress_composition_reference === fingerprint
  );
}

/**
 * `pending_cutover_from` names the exact live pair that may stand in while the
 * pin already holds a reviewed rotation that needs a recovered namespace. The
 * cutover removes the field in the same reviewed release as the rotation.
 */
export function verifyHnsStagingGatewayManifest(
  manifestBytes: string,
  pin: unknown,
): Readonly<{ gatewayReference: string; fingerprint: string; pendingCutoverTo: string | null }> {
  if (manifestBytes.length === 0 || manifestBytes.length > 65_536) {
    throw new Error("staging HNS gateway manifest has invalid size");
  }
  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(manifestBytes) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    manifest = parsed as Record<string, unknown>;
  } catch {
    throw new Error("staging HNS gateway manifest is invalid");
  }
  if (typeof pin !== "object" || pin === null || Array.isArray(pin)) {
    throw new Error("staging HNS gateway pin is invalid");
  }
  const expected = pin as Record<string, unknown>;
  const reference = `${gatewayPrefix}${createHash("sha256").update(manifestBytes).digest("hex")}`;
  const fingerprint = manifest.solid_ingress_composition_reference;
  const target = expected.solid_ingress_composition_reference;
  const current = pinnedPairMatches(expected, reference, fingerprint);
  const pending =
    !current &&
    typeof target === "string" &&
    pinnedPairMatches(expected.pending_cutover_from, reference, fingerprint);
  if (
    manifest.schema !== "pirate-hns-community-app-handle-gateway-staging-public-v1" ||
    manifest.mode !== "staging-public-tls" ||
    manifest.public_tls_listener !== "94.103.168.209:443" ||
    manifest.solid_origin !== "https://hns-community-ingress-staging.pirate.sc" ||
    typeof fingerprint !== "string" ||
    expected.schema !== "pirate-hns-staging-gateway-deploy-pin-v1" ||
    (!current && !pending)
  ) {
    throw new Error("staging HNS gateway differs from the reviewed deploy pin");
  }
  return {
    gatewayReference: reference,
    fingerprint,
    pendingCutoverTo: pending ? (target as string) : null,
  };
}

export async function readHnsStagingGatewayPin(repositoryRoot: string): Promise<unknown> {
  return JSON.parse(
    await readFile(join(repositoryRoot, "scripts/hns-staging-gateway-pin.json"), "utf8"),
  ) as unknown;
}
