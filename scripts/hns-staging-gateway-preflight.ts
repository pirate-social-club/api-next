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

export function verifyHnsStagingGatewayManifest(
  manifestBytes: string,
  pin: unknown,
): Readonly<{ gatewayReference: string; fingerprint: string }> {
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
  if (
    manifest.schema !== "pirate-hns-community-app-handle-gateway-staging-public-v1" ||
    manifest.mode !== "staging-public-tls" ||
    manifest.public_tls_listener !== "94.103.168.209:443" ||
    manifest.solid_origin !== "https://hns-community-ingress-staging.pirate.sc" ||
    typeof manifest.solid_ingress_composition_reference !== "string" ||
    expected.schema !== "pirate-hns-staging-gateway-deploy-pin-v1" ||
    expected.gateway_reference !== reference ||
    expected.solid_ingress_composition_reference !== manifest.solid_ingress_composition_reference
  ) {
    throw new Error("staging HNS gateway differs from the reviewed deploy pin");
  }
  return { gatewayReference: reference, fingerprint: manifest.solid_ingress_composition_reference };
}

export async function readHnsStagingGatewayPin(repositoryRoot: string): Promise<unknown> {
  return JSON.parse(
    await readFile(join(repositoryRoot, "scripts/hns-staging-gateway-pin.json"), "utf8"),
  ) as unknown;
}
