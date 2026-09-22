import { randomUUID } from "node:crypto";
import { makePowerDnsRootProvisioner, makePowerDnsRootTeardown } from "../../src/powerdns.ts";
import { validateFixtureDnssec } from "../staging-fixture/dnssec.ts";

const apiKey = "isolated-hns-authority-fixture-only";
const addresses = ["127.0.0.21", "127.0.0.22"] as const;

export function requireSmokeExecution(args: readonly string[]): void {
  if (args.length !== 1 || args[0] !== "--execute-host") {
    throw new Error("Requires --execute-host on the isolated staging authority host");
  }
}

export function requireOwnedSecondary(value: unknown, root: string, challenge: string): void {
  if (value === null || typeof value !== "object") throw new Error("Secondary absent");
  const zone = value as Record<string, unknown>;
  if (
    !/^e2e[0-9a-f]{24}$/u.test(root) ||
    zone.name !== `${root}.` ||
    zone.kind !== "Slave" ||
    zone.account !== "isolated-staging-fixture" ||
    JSON.stringify(zone.masters) !== JSON.stringify([addresses[0]]) ||
    !Array.isArray(zone.rrsets) ||
    !zone.rrsets.some(
      (rr) =>
        rr.name === `_pirate.${root}.` &&
        rr.type === "TXT" &&
        Array.isArray(rr.records) &&
        rr.records.length === 1 &&
        rr.records[0]?.content === JSON.stringify(challenge) &&
        rr.records[0]?.disabled === false,
    )
  )
    throw new Error("Secondary ownership drift; retained for reconciliation");
}

async function api(address: (typeof addresses)[number], method: string, root: string) {
  const response = await fetch(`http://${address}:8081/api/v1/servers/localhost/zones/${root}.`, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(3000),
    headers: { "X-API-Key": apiKey },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Authority request refused");
  const body = await response.text();
  if (body.length > 1_048_576) throw new Error("Authority response too large");
  return body ? (JSON.parse(body) as unknown) : null;
}

async function runAuthoritySmoke(): Promise<void> {
  const root = `e2e${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const challenge = `pirate-verification=${randomUUID()}`;
  const config = {
    api_url: `http://${addresses[0]}:8081`,
    api_key: apiKey,
    server_id: "localhost",
    soa_content: "ns1.pirate. hostmaster.pirate. 0 60 30 3600 60",
    axfr_tsig_key_name: "fixture-transfer.",
    gateway_ipv4: "127.0.0.23",
    shared_tlsa_association: `3 1 1 ${"a".repeat(64)}`,
    gateway_deployment_reference: "isolated-authority-smoke-no-gateway-proof",
    gateway_certificate_spki_sha256: "a".repeat(64),
    ttl_seconds: 60,
  };
  for (const address of addresses) {
    if ((await api(address, "GET", root)) !== null) throw new Error("Fixture name collision");
  }
  // Emit the exact recovery target before the first write. Never print provider errors.
  console.log(JSON.stringify({ event: "authority_smoke_started", root }));
  const result = await makePowerDnsRootProvisioner(config)({
    root_label: root,
    challenge_txt_value: challenge,
    current_records: [],
  });
  let transferred = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const secondary = await api(addresses[1], "GET", root);
    try {
      requireOwnedSecondary(secondary, root, challenge);
      transferred = true;
      break;
    } catch {
      await Bun.sleep(250);
    }
  }
  if (!transferred) throw new Error("Secondary did not converge; preserve for diagnosis");
  await validateFixtureDnssec(root, result.ds_records);
  await makePowerDnsRootTeardown(config)({ root_label: root, challenge_txt_value: challenge });
  // Primary deletion does not remove a secondary. Recheck its exact fixture identity.
  requireOwnedSecondary(await api(addresses[1], "GET", root), root, challenge);
  await api(addresses[1], "DELETE", root);
  for (const address of addresses) {
    if ((await api(address, "GET", root)) !== null) throw new Error("Cleanup readback failed");
  }
  console.log(
    JSON.stringify({
      event: "authority_smoke_passed",
      root,
      automatic_secondary: true,
      dnssec: true,
      tampered_dns_rejected: true,
      both_zones_removed: true,
      chain_binding: false,
      gateway_acceptance: false,
    }),
  );
}

if (import.meta.main) {
  try {
    requireSmokeExecution(Bun.argv.slice(2));
    await runAuthoritySmoke();
  } catch {
    console.error(
      "Staging authority smoke failed; inspect the emitted fixture root before retrying",
    );
    process.exitCode = 1;
  }
}
