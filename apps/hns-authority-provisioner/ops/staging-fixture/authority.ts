import { randomUUID } from "node:crypto";
import {
  makePowerDnsRootInspector,
  makePowerDnsRootProvisioner,
  makePowerDnsRootTeardown,
} from "../../src/powerdns.ts";
import { provisionHnsAuthorityRootV1 } from "../../src/provision-root.ts";
import { publishFixtureResource } from "./chain.ts";
import { validateFixtureDnssec } from "./dnssec.ts";
import { acquireAuthorityFixtureLease } from "./lease.ts";

export const authorityImage =
  "powerdns/pdns-auth-51@sha256:f976e753a1de8ec62636203ecb12ae5fa3d1055601be167de53f1f673e0abe59";
export const authorityAddresses = ["127.0.0.21", "127.0.0.22"] as const;
const fixtureKey = "isolated-hns-authority-fixture-only";
const transferKey = Buffer.from("isolated-regtest-transfer-key-not-a-live-secret").toString(
  "base64",
);

export function requireLocalFixtureExecution(args: readonly string[]): void {
  if (
    args[0] !== "--execute-local" ||
    (args.length !== 1 && !(args.length === 2 && args[1] === "--with-chain"))
  ) {
    throw new Error(
      "Use --execute-local to create disposable loopback DNS fixtures; no remote mode exists",
    );
  }
}

async function command(args: readonly string[]): Promise<string> {
  const child = Bun.spawn([...args], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (status !== 0)
    throw new Error(`Local fixture command failed: ${args[0]} ${args[1]} (${status})`);
  return (args[1] === "logs" ? stdout + stderr : stdout).trim();
}

async function api(
  address: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  if (!authorityAddresses.some((candidate) => candidate === address))
    throw new Error("Non-fixture authority refused");
  const response = await fetch(`http://${address}:8081/api/v1/servers/localhost${path}`, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(3000),
    headers: { "x-api-key": fixtureKey, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Local authority API failed (${response.status})`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function eventually(action: () => Promise<void>): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await action();
      return;
    } catch (error) {
      last = error;
    }
    await Bun.sleep(250);
  }
  throw last;
}

/** Real DNS provisioning, not complete onboarding or public staging serving. */
export async function runLocalAuthorityFixture(
  withChain: boolean,
  startGateway?: (root: string) => Promise<{
    spki: string;
    verify: () => Promise<void>;
    stop: () => Promise<void>;
  }>,
): Promise<void> {
  const releaseLease = await acquireAuthorityFixtureLease();
  const run = randomUUID().replaceAll("-", "");
  const root = `e2e${run.slice(0, 12)}`;
  const challenge = `pirate-verification=${run}`;
  const owned: string[] = [];
  const failures: unknown[] = [];
  let gateway: Awaited<ReturnType<NonNullable<typeof startGateway>>> | undefined;
  let chainReceipt: Awaited<ReturnType<typeof publishFixtureResource>>["receipt"] | null = null;
  const config = {
    api_url: `http://${authorityAddresses[0]}:8081`,
    api_key: fixtureKey,
    server_id: "localhost",
    soa_content: "ns1.pirate. hostmaster.pirate. 0 60 30 3600 60",
    axfr_tsig_key_name: "fixture-transfer.",
    gateway_ipv4: "127.0.0.23",
    shared_tlsa_association: `3 1 1 ${"a".repeat(64)}`,
    gateway_deployment_reference: "local-fixture-no-gateway-acceptance",
    gateway_certificate_spki_sha256: "a".repeat(64),
    ttl_seconds: 60,
  };
  try {
    gateway = await startGateway?.(root);
    if (gateway) {
      config.shared_tlsa_association = `3 1 1 ${gateway.spki}`;
      config.gateway_certificate_spki_sha256 = gateway.spki;
      config.gateway_deployment_reference = "isolated-gateway-fixture";
    }
    for (const [index, address] of authorityAddresses.entries()) {
      const name = `pirate-hns-staging-fixture-${run}-${index}`;
      // Claim by successful create, never remove a pre-existing named container.
      await command([
        "docker",
        "create",
        "--name",
        name,
        "--pull=never",
        "--user=0:0",
        "--cap-drop=ALL",
        "--cap-add=NET_BIND_SERVICE",
        "--cap-add=DAC_OVERRIDE",
        "--add-host=ns1.pirate:127.0.0.21",
        "--add-host=ns2.pirate:127.0.0.22",
        "--network",
        "host",
        "--label",
        `pirate.hns.fixture=${run}`,
        authorityImage,
        `--local-address=${address}`,
        "--local-port=53",
        "--api=yes",
        `--api-key=${fixtureKey}`,
        "--webserver=yes",
        `--webserver-address=${address}`,
        "--webserver-port=8081",
        "--webserver-allow-from=127.0.0.0/8",
        "--security-poll-suffix=",
        "--resolver=127.0.0.21:53",
        "--version-string=anonymous",
        `--primary=${index === 0 ? "yes" : "no"}`,
        `--secondary=${index === 1 ? "yes" : "no"}`,
        `--autosecondary=${index === 1 ? "yes" : "no"}`,
        "--allow-unsigned-autoprimary=no",
        "--allow-unsigned-notify=no",
        "--send-signed-notify=yes",
        "--allow-notify-from=127.0.0.21",
        "--allow-axfr-ips=",
        "--only-notify=127.0.0.0/8",
        "--also-notify=127.0.0.22",
        "--query-local-address=127.0.0.21",
        "--setuid=",
        "--setgid=",
      ]);
      owned.push(name);
      await command(["docker", "start", name]);
      await eventually(async () => {
        await api(address, "GET", "/zones");
      });
      if ((await command(["docker", "inspect", "--format={{.State.Running}}", name])) !== "true") {
        throw new Error("Fixture container does not own a running authority");
      }
      await api(address, "POST", "/tsigkeys", {
        name: "fixture-transfer.",
        algorithm: "hmac-sha256",
        key: transferKey,
      });
      if (index === 1) {
        await command([
          "docker",
          "exec",
          name,
          "pdnsutil",
          "autoprimary",
          "add",
          authorityAddresses[0],
          "ns2.pirate",
          "isolated-staging-fixture",
        ]);
      }
    }
    const provision = makePowerDnsRootProvisioner(config);
    const result = await provision({
      root_label: root,
      challenge_txt_value: challenge,
      current_records: [],
    });
    if (!result.dnssec || result.ds_records.length === 0)
      throw new Error("Missing real DNSSEC delegation");
    // Signed NOTIFY admits the secondary and its AXFR key without per-zone orchestration.
    const query = (address: string, name: string, type: string) =>
      command(["dig", `@${address}`, name, type, "+tcp", "+short", "+time=2", "+tries=1"]);
    await eventually(async () => {
      for (const address of authorityAddresses) {
        if (!(await query(address, `_pirate.${root}`, "TXT")).includes(challenge))
          throw new Error("Challenge not transferred");
      }
    });
    const transferMetadata = await api(
      authorityAddresses[1],
      "GET",
      `/zones/${root}./metadata/AXFR-MASTER-TSIG`,
    );
    if (
      transferMetadata === null ||
      typeof transferMetadata !== "object" ||
      !("metadata" in transferMetadata) ||
      !Array.isArray(transferMetadata.metadata) ||
      transferMetadata.metadata.length !== 1 ||
      transferMetadata.metadata[0] !== "fixture-transfer"
    )
      throw new Error("Secondary did not retain the signed notification's transfer key");
    for (const [name, type] of [
      [root, "DNSKEY"],
      [root, "NS"],
      [`app.${root}`, "A"],
      [`_443._tcp.app.${root}`, "TLSA"],
    ] as const) {
      const first = (await query(authorityAddresses[0], name, type)).split("\n").sort().join("\n");
      const second = (await query(authorityAddresses[1], name, type)).split("\n").sort().join("\n");
      if (!first || first !== second) throw new Error(`Authority agreement failed for ${type}`);
    }
    const inspected = await makePowerDnsRootInspector(config)({
      root_label: root,
      challenge_txt_value: challenge,
    });
    if (inspected.managed_rrset_sha256 !== result.managed_rrset_sha256)
      throw new Error("Managed resource readback drift");
    if (withChain) {
      const observed = await publishFixtureResource(root, challenge, result.ds_records, (observe) =>
        provisionHnsAuthorityRootV1(
          {
            version: "pirate-hns-authority-provision-request-v1",
            root_import_session_id: `import-${run}`,
            namespace_session_id: `namespace-${run}`,
            root_label: root,
            challenge_txt_value: challenge,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
          {
            observe_current_resource: observe,
            ensure_zone: provision,
          },
        ),
      );
      chainReceipt = observed.receipt;
      await validateFixtureDnssec(root, observed.ds);
    } else {
      await validateFixtureDnssec(root, result.ds_records);
    }
    if (gateway) {
      for (const address of authorityAddresses) {
        const tlsa = (await query(address, `_443._tcp.app.${root}`, "TLSA"))
          .replaceAll(/\s/g, "")
          .toLowerCase();
        if (tlsa !== `311${gateway.spki}`)
          throw new Error("Served TLSA differs from certificate pin");
      }
      await gateway.verify();
    }
    await makePowerDnsRootTeardown(config)({ root_label: root, challenge_txt_value: challenge });
  } catch (error) {
    failures.push(error);
    for (const name of owned) {
      const logs = await command(["docker", "logs", "--tail", "12", name]).catch(
        () => "logs unavailable",
      );
      console.error(
        logs
          .replaceAll(fixtureKey, "[fixture-key]")
          .replaceAll(transferKey, "[fixture-transfer-key]"),
      );
    }
  } finally {
    let cleanupFailed = false;
    try {
      await gateway?.stop();
    } catch {
      cleanupFailed = true;
      failures.push(new Error("Gateway fixture cleanup failed"));
    }
    for (const name of owned.reverse()) {
      try {
        await command(["docker", "rm", "-f", "-v", name]);
      } catch {
        cleanupFailed = true;
        failures.push(new Error(`Fixture cleanup failed: ${name}`));
      }
    }
    if (!cleanupFailed) await releaseLease();
  }
  if (failures.length) throw new AggregateError(failures, "Local authority fixture failed");
  console.log(
    JSON.stringify({
      version: "hns-local-authority-fixture-v1",
      image: authorityImage,
      provisioned: true,
      dnssec_keys: true,
      dnssec_validation: true,
      signed_zone_transfer: true,
      authority_agreement: true,
      reservation_teardown: true,
      containers_removed: true,
      chain_resource_binding: chainReceipt,
      certificate_acceptance: gateway !== undefined,
      gateway_component_acceptance: gateway !== undefined,
      browser_acceptance: false,
    }),
  );
}

if (import.meta.main) {
  requireLocalFixtureExecution(process.argv.slice(2));
  await runLocalAuthorityFixture(process.argv.includes("--with-chain"));
}
