import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { runHnsAuthorityProvisionExecutorOnce } from "./executor.ts";
import { makeHsdRootResourceInspector } from "./hsd.ts";
import {
  type HnsRootReadinessAuthorityEndpointV1,
  makeLiveHnsRootReadinessObserverV1,
} from "./live-readiness.ts";
import { makePostgresHnsRootObservationQueue } from "./observation-queue.ts";
import {
  makePowerDnsRootInspector,
  makePowerDnsRootProvisioner,
  type PowerDnsRootProvisionConfig,
} from "./powerdns.ts";
import { makePostgresHnsAuthorityProvisionQueue } from "./queue.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() !== value || value.length === 0) {
    throw new Error("HNS authority provisioner configuration is incomplete");
  }
  return value;
}

function boundedId(value: string): boolean {
  return (
    new TextEncoder().encode(value).byteLength <= 256 &&
    [...value].every((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point >= 0x20 && !(point >= 0x7f && point <= 0x9f);
    })
  );
}

function ttlSeconds(): number {
  const raw = required("HNS_AUTHORITY_TTL_SECONDS");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 60 || value > 86_400) {
    throw new Error("HNS authority provisioner configuration is invalid");
  }
  return value;
}

function readinessValidForSeconds(): number {
  const raw = required("HNS_AUTHORITY_READINESS_VALID_FOR_SECONDS");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 60 || value > 7 * 86_400) {
    throw new Error("HNS authority provisioner configuration is invalid");
  }
  return value;
}

function readinessTimeoutMs(): number {
  const value = Number(required("HNS_AUTHORITY_READINESS_TIMEOUT_MS"));
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 12_000) {
    throw new Error("HNS authority provisioner configuration is invalid");
  }
  return value;
}

function authorityEndpoint(ordinal: 1 | 2): HnsRootReadinessAuthorityEndpointV1 {
  const authorityNameserver = required(`HNS_AUTHORITY_NS${ordinal}_NAME`);
  const authorityAddress = required(`HNS_AUTHORITY_NS${ordinal}_ADDRESS`);
  const family = isIP(authorityAddress);
  if (family !== 4 && family !== 6) {
    throw new Error("HNS authority provisioner configuration is invalid");
  }
  const localAddress = required(
    family === 4 ? "HNS_AUTHORITY_DNS_LOCAL_IPV4" : "HNS_AUTHORITY_DNS_LOCAL_IPV6",
  );
  if (isIP(localAddress) !== family) {
    throw new Error("HNS authority provisioner configuration is invalid");
  }
  return {
    authority_nameserver: authorityNameserver,
    authority_address_family: family === 4 ? "GLUE4" : "GLUE6",
    authority_address: authorityAddress,
    local_address: localAddress,
  };
}

async function axfrSecret(): Promise<Uint8Array> {
  const path = required("HNS_AUTHORITY_AXFR_TSIG_SECRET_FILE");
  if (!isAbsolute(path)) throw new Error("HNS authority provisioner configuration is invalid");
  const file = Bun.file(path);
  if ((await file.exists()) !== true || file.size > 2_048) {
    throw new Error("HNS authority provisioner configuration is invalid");
  }
  const encoded = (await file.text()).trim();
  if (
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)
  ) {
    throw new Error("HNS authority provisioner configuration is invalid");
  }
  const secret = Uint8Array.from(Buffer.from(encoded, "base64"));
  if (secret.byteLength < 16 || secret.byteLength > 512) {
    throw new Error("HNS authority provisioner configuration is invalid");
  }
  return secret;
}

function tlsaAssociation(): Readonly<{ association: string; spki_sha256: string }> {
  const raw = required("HNS_AUTHORITY_SHARED_TLSA");
  const match = raw.match(/^3\s+1\s+1\s+([0-9a-f]{64})$/iu);
  if (match?.[1] === undefined) {
    throw new Error("HNS authority provisioner configuration is invalid");
  }
  return {
    association: `3 1 1 ${match[1].toUpperCase()}`,
    spki_sha256: match[1].toLowerCase(),
  };
}

async function main(serve: boolean): Promise<void> {
  const executorId = required("HNS_AUTHORITY_EXECUTOR_ID");
  const gatewayIpv4 = required("HNS_AUTHORITY_GATEWAY_IPV4");
  const sharedTlsa = tlsaAssociation();
  if (!boundedId(executorId) || isIP(gatewayIpv4) !== 4) {
    throw new Error("HNS authority provisioner configuration is invalid");
  }
  const connectionString = required("CONTROL_PLANE_POSTGRES_URL");
  const queue = makePostgresHnsAuthorityProvisionQueue(connectionString);
  const inspectCurrentResource = makeHsdRootResourceInspector({
    rpc_url: required("HNS_AUTHORITY_HSD_RPC_URL"),
    authorization: required("HNS_AUTHORITY_HSD_AUTHORIZATION"),
  });
  const powerDnsConfig: PowerDnsRootProvisionConfig = {
    api_url: required("HNS_AUTHORITY_PDNS_API_URL"),
    api_key: required("HNS_AUTHORITY_PDNS_API_KEY"),
    server_id: required("HNS_AUTHORITY_PDNS_SERVER_ID"),
    soa_content: required("HNS_AUTHORITY_PDNS_SOA_CONTENT"),
    axfr_tsig_key_name: required("HNS_AUTHORITY_AXFR_TSIG_KEY_NAME"),
    gateway_ipv4: gatewayIpv4,
    shared_tlsa_association: sharedTlsa.association,
    gateway_deployment_reference: required("HNS_AUTHORITY_GATEWAY_DEPLOYMENT_REFERENCE"),
    gateway_certificate_spki_sha256: sharedTlsa.spki_sha256,
    ttl_seconds: ttlSeconds(),
  };
  const ensureZone = makePowerDnsRootProvisioner(powerDnsConfig);
  const inspectZone = makePowerDnsRootInspector(powerDnsConfig);
  const observeLive = makeLiveHnsRootReadinessObserverV1({
    chain_network: required("HNS_AUTHORITY_CHAIN_NETWORK"),
    chain_genesis_block_hash: required("HNS_AUTHORITY_CHAIN_GENESIS_BLOCK_HASH"),
    authorities: [authorityEndpoint(1), authorityEndpoint(2)],
    axfr_credential: {
      key_name: powerDnsConfig.axfr_tsig_key_name,
      algorithm: "hmac-sha256",
      secret_bytes: await axfrSecret(),
    },
    gateway_address: gatewayIpv4,
    gateway_local_address: required("HNS_AUTHORITY_GATEWAY_LOCAL_IPV4"),
    expected_gateway_certificate_spki_sha256: sharedTlsa.spki_sha256,
    timeout_ms: readinessTimeoutMs(),
  });
  const execution = {
    executor_id: executorId,
    queue,
    provision: {
      inspect_current_resource: inspectCurrentResource,
      ensure_zone: ensureZone,
    },
    observation: {
      queue: makePostgresHnsRootObservationQueue(connectionString),
      observe: {
        inspect_current_resource: inspectCurrentResource,
        inspect_zone: inspectZone,
        observe_live: observeLive,
      },
      config: {
        environment: required("HNS_AUTHORITY_ENVIRONMENT"),
        valid_for_seconds: readinessValidForSeconds(),
      },
    },
  } as const;

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  if (serve) {
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }
  try {
    do {
      const result = await runHnsAuthorityProvisionExecutorOnce(execution);
      if (!serve || result.outcome !== "idle") console.log(JSON.stringify(result));
      if (serve && (result.outcome === "idle" || result.outcome === "retry") && !stopping) {
        const retryDelay =
          result.outcome === "retry" && "observation_job_id" in result ? 30_000 : 2_000;
        await Bun.sleep(retryDelay);
      }
    } while (serve && !stopping);
  } finally {
    if (serve) {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  }
}

if (import.meta.main) {
  const arguments_ = Bun.argv.slice(2);
  const serve = arguments_.length === 1 && arguments_[0] === "--serve";
  if (arguments_.length > (serve ? 1 : 0)) {
    console.error("HNS authority provisioner arguments are invalid");
    process.exitCode = 1;
  } else {
    main(serve).catch(() => {
      console.error("HNS authority provisioner failed");
      process.exitCode = 1;
    });
  }
}
