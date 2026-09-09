import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import type {
  HnsRootDelegationDsV1,
  HnsRootResourceRecordV1,
} from "@pirate/application/namespace-ownership";
import { Client } from "pg";
import { runHnsAuthorityProvisionExecutorOnce } from "./executor.ts";
import { makeHsdRootResourceObserver } from "./hsd.ts";
import {
  type HnsRootReadinessAuthorityEndpointV1,
  makeLiveHnsRootReadinessObserverV1,
} from "./live-readiness.ts";
import { makePostgresHnsRootObservationQueue } from "./observation-queue.ts";
import {
  makePowerDnsRootInspector,
  makePowerDnsRootProvisioner,
  makePowerDnsRootReconciler,
  makePowerDnsRootTeardown,
  type PowerDnsRootProvisionConfig,
} from "./powerdns.ts";
import type { HnsZoneMutationLease } from "./provision-root.ts";
import { makePostgresHnsAuthorityProvisionQueue } from "./queue.ts";
import { withHnsRootZoneMutation } from "./zone-mutation.ts";

// Handshake publication is block-bound: the legacy bounded 20-attempt
// observation fence spans a one-hour owner session only when attempts are
// spaced by 180 seconds. The serve loop no longer sleeps globally; it waits
// for the earliest persisted job due time (lifecycle jobs are scheduled by
// due_at; the legacy observation class keeps its spacing) and keeps
// claiming while any class has work, so one waiting root never blocks
// unrelated provisioning or renewal.
export const HNS_ROOT_OBSERVATION_RETRY_DELAY_MS = 180_000;
export const HNS_ROOT_EXECUTOR_RECOVERY_SWEEP_MS = 15_000;

/**
 * Waits until the next persisted job due time, bounded by the recovery
 * sweep. An overdue job yields zero so the loop claims immediately; the
 * legacy observation class keeps its attempt spacing when it was the last
 * work attempted, so its bounded 20-attempt fence still spans the signed
 * owner session.
 */
export function nextHnsExecutorWaitMs(
  input: Readonly<{
    readonly now_epoch_ms: number;
    readonly next_lifecycle_due_epoch_ms: number | null;
    readonly observation_retry_spacing: boolean;
  }>,
): number {
  const ceiling = input.observation_retry_spacing
    ? HNS_ROOT_OBSERVATION_RETRY_DELAY_MS
    : HNS_ROOT_EXECUTOR_RECOVERY_SWEEP_MS;
  if (input.next_lifecycle_due_epoch_ms === null) {
    return Math.min(ceiling, HNS_ROOT_EXECUTOR_RECOVERY_SWEEP_MS);
  }
  const untilDue = input.next_lifecycle_due_epoch_ms - input.now_epoch_ms;
  if (untilDue <= 0) return 0;
  return Math.min(untilDue, HNS_ROOT_EXECUTOR_RECOVERY_SWEEP_MS);
}

async function nextLifecycleJobDueMs(connectionString: string): Promise<number | null> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query<{ due_at: Date | null }>(
      `SELECT MIN(due_at) AS due_at FROM hns_root_import_lifecycle_jobs
        WHERE state = 'queued'
           OR (state = 'leased' AND lease_expires_at <= clock_timestamp())`,
    );
    const dueAt = result.rows[0]?.due_at;
    return dueAt === null || dueAt === undefined ? null : dueAt.getTime();
  } finally {
    await client.end();
  }
}

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

function chainInteger(name: string, minimum: number, maximum: number): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error("HNS authority provisioner configuration is invalid");
  }
  return value;
}

async function main(serve: boolean): Promise<void> {
  const executorId = required("HNS_AUTHORITY_EXECUTOR_ID");
  const gatewayIpv4 = required("HNS_AUTHORITY_GATEWAY_IPV4");
  const sharedTlsa = tlsaAssociation();
  if (!boundedId(executorId) || isIP(gatewayIpv4) !== 4) {
    throw new Error("HNS authority provisioner configuration is invalid");
  }
  const connectionString = required("CONTROL_PLANE_POSTGRES_URL");
  /**
   * How recent a retention review's inspection must be to authorize deletion.
   * Thirty minutes: long enough for a review and the teardown that acts on it
   * to be separate jobs, short enough that the chain cannot have changed
   * meaningfully between them. It bounds evidence age and never substitutes
   * for the inspection.
   */
  const RETIREMENT_EVIDENCE_FRESHNESS_SECONDS = 1_800;
  async function withRetentionClient<A>(
    url: string,
    use: (client: Client) => Promise<A>,
  ): Promise<A> {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      return await use(client);
    } finally {
      await client.end().catch(() => undefined);
    }
  }
  const queue = makePostgresHnsAuthorityProvisionQueue(connectionString);

  const observeChain = makeHsdRootResourceObserver(
    {
      rpc_url: required("HNS_AUTHORITY_HSD_RPC_URL"),
      authorization: required("HNS_AUTHORITY_HSD_AUTHORIZATION"),
      chain_network: required("HNS_AUTHORITY_CHAIN_NETWORK"),
      genesis_block_hash: required("HNS_AUTHORITY_CHAIN_GENESIS_BLOCK_HASH"),
      // Handshake mainnet commits the Urkel tree every 36 blocks and HSD
      // treats a commitment with more than 12 confirmations as safe.
      tree_interval_blocks: chainInteger("HNS_AUTHORITY_TREE_INTERVAL_BLOCKS", 1, 2_000),
      safe_minimum_confirmations: chainInteger("HNS_AUTHORITY_SAFE_CONFIRMATIONS", 0, 1_000),
      maximum_tip_age_seconds: chainInteger("HNS_AUTHORITY_MAXIMUM_TIP_AGE_SECONDS", 60, 86_400),
      maximum_future_tip_seconds: chainInteger(
        "HNS_AUTHORITY_MAXIMUM_FUTURE_TIP_SECONDS",
        0,
        3_600,
      ),
    },
    fetch,
  );
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
  const ensureZone = (input: {
    readonly root_label: string;
    readonly challenge_txt_value: string;
    readonly current_records: readonly HnsRootResourceRecordV1[];
    readonly mutation_lease?: HnsZoneMutationLease;
  }) =>
    withHnsRootZoneMutation(connectionString, input, false, (signal) =>
      makePowerDnsRootProvisioner(powerDnsConfig, (url, init) =>
        fetch(url, {
          ...init,
          signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
        }),
      )(input),
    );
  const inspectZone = makePowerDnsRootInspector(powerDnsConfig);
  const reconcileZone = (input: {
    readonly root_label: string;
    readonly challenge_txt_value: string;
    readonly expected_ds_records: readonly HnsRootDelegationDsV1[];
    readonly mutation_lease?: HnsZoneMutationLease;
  }) =>
    withHnsRootZoneMutation(connectionString, input, false, (signal) =>
      makePowerDnsRootReconciler(powerDnsConfig, (url, init) =>
        fetch(url, {
          ...init,
          signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
        }),
      )(input),
    );
  const teardownZone = (input: {
    readonly root_label: string;
    readonly challenge_txt_value?: string;
    readonly mutation_lease?: HnsZoneMutationLease;
  }) => {
    if (input.challenge_txt_value === undefined)
      return makePowerDnsRootTeardown(powerDnsConfig)(input);
    return withHnsRootZoneMutation(
      connectionString,
      { ...input, challenge_txt_value: input.challenge_txt_value },
      true,
      (signal) =>
        makePowerDnsRootTeardown(powerDnsConfig, (url, init) =>
          fetch(url, {
            ...init,
            signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
          }),
        )(input),
    );
  };
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
      observe_current_resource: (rootLabel: string) => observeChain(rootLabel, "current"),
      ensure_zone: ensureZone,
    },
    observation: {
      queue: makePostgresHnsRootObservationQueue(connectionString),
      observe: {
        observe_current_resource: (rootLabel: string) => observeChain(rootLabel, "current"),
        reconcile_zone: reconcileZone,
        inspect_zone: inspectZone,
        observe_live: observeLive,
      },
      teardown_zone: teardownZone,
      retention: {
        observe_chain: (rootLabel: string, view: "current" | "safe") =>
          observeChain(rootLabel, view),
        // Authorization comes only from a recorded retention review or
        // supersession, validated in SQL against the operation's current
        // authority generation and a freshness bound on its evidence. No row
        // means retain, which is also what an absent lifecycle, a superseded
        // generation and stale evidence all produce.
        retirement_authorization: (rootImportSessionId: string) =>
          withRetentionClient(connectionString, async (client) => {
            const result = await client.query<{
              readonly kind: string;
              readonly recorded_at: Date;
              readonly evidence_ref: string;
            }>("SELECT * FROM authorize_hns_root_import_retirement_v1($1,$2)", [
              rootImportSessionId,
              RETIREMENT_EVIDENCE_FRESHNESS_SECONDS,
            ]);
            const row = result.rows[0];
            if (row === undefined) return null;
            return {
              kind:
                row.kind === "supersession"
                  ? ("supersession" as const)
                  : ("retention_review" as const),
              recorded_at_epoch_ms: row.recorded_at.getTime(),
              evidence_ref: row.evidence_ref,
            };
          }),
      },
      config: {
        environment: required("HNS_AUTHORITY_ENVIRONMENT"),
        valid_for_seconds: readinessValidForSeconds(),
      },
    },
  } as const;

  let stopping = false;
  let observationRetrySpacing = false;
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
      // Due-job scheduling replaces the global retry sleep: keep claiming
      // while any job class has work — a waiting root never blocks
      // unrelated provisioning or renewal — and wait only when idle, for
      // the earliest persisted due time, bounded by the recovery sweep.
      // Cron remains the recovery sweep of last resort.
      const observationRetry = result.outcome === "retry" && "observation_job_id" in result;
      if (serve && result.outcome === "idle" && !stopping) {
        const waitMs = nextHnsExecutorWaitMs({
          now_epoch_ms: Date.now(),
          next_lifecycle_due_epoch_ms: await nextLifecycleJobDueMs(connectionString).catch(
            () => null,
          ),
          observation_retry_spacing: observationRetrySpacing,
        });
        if (waitMs > 0) await Bun.sleep(waitMs);
        observationRetrySpacing = false;
      }
      observationRetrySpacing = observationRetry;
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
