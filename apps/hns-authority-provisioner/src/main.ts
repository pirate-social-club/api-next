import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import type {
  HnsRootDelegationDsV1,
  HnsRootResourceRecordV1,
} from "@pirate/application/namespace-ownership";
import { makeHsdRootResourceObserver } from "@pirate/platform-cf/namespace-ownership-hns-root-resource-observer";
import { Client } from "pg";
import { runHnsAuthorityProvisionExecutorOnce } from "./executor.ts";
import { runHnsIncidentReportCommandV1 } from "./incident-command.ts";
import { makeHnsLifecycleObservePort } from "./lifecycle-evidence.ts";
import { runHnsRootImportLifecycleJobOnce } from "./lifecycle-executor.ts";
import {
  makePostgresHnsLifecycleReadinessPorts,
  makePostgresHnsRetentionReviewerPorts,
  makePostgresHnsRootImportLifecycleQueue,
  nextHnsLifecycleJobDueEpochMs,
} from "./lifecycle-queue.ts";
import { runHnsRootImportReadinessOnce } from "./lifecycle-readiness.ts";
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
import { runHnsRetentionReviewOnce } from "./retention-reviewer.ts";
import {
  HNS_AUTHORITY_SERVICE_VERSION,
  HNS_LIFECYCLE_JOB_ENVELOPE_VERSION,
  hnsLifecycleSchemaCutoverCheck,
  isBoundedVersion,
  runHnsLifecycleCutoverProbe,
} from "./schema-compatibility.ts";
import { type HnsExecutorRunnersV1, runHnsExecutorRoundV1 } from "./service-loop.ts";
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

/**
 * How long a lifecycle job's lease is held. Long enough for a chain read and
 * the transaction that applies it, short enough that a crashed executor's job
 * is reclaimable within one recovery sweep of its expiry.
 */
export const HNS_LIFECYCLE_LEASE_SECONDS = 60;

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

/**
 * The staged bundle digest this process must prove it is running. The
 * deployment sequence writes the digest into the deployment manifest; the
 * environment override exists for operators who stage the bundle by hand.
 * Missing or malformed identity is reported as absence, never guessed.
 */
async function cutoverBundleSha256(): Promise<string | null> {
  const direct = process.env.HNS_AUTHORITY_BUNDLE_SHA256;
  if (direct !== undefined && direct.trim() === direct && /^[0-9a-f]{64}$/u.test(direct)) {
    return direct;
  }
  const manifestPath = process.env.HNS_AUTHORITY_DEPLOYMENT_MANIFEST;
  if (manifestPath === undefined || !isAbsolute(manifestPath)) return null;
  try {
    const parsed = JSON.parse(await Bun.file(manifestPath).text()) as {
      readonly bundle_sha256?: unknown;
    };
    return typeof parsed.bundle_sha256 === "string" && /^[0-9a-f]{64}$/u.test(parsed.bundle_sha256)
      ? parsed.bundle_sha256
      : null;
  } catch {
    return null;
  }
}

async function main(serve: boolean): Promise<void> {
  const executorId = required("HNS_AUTHORITY_EXECUTOR_ID");
  const gatewayIpv4 = required("HNS_AUTHORITY_GATEWAY_IPV4");
  const sharedTlsa = tlsaAssociation();
  if (!boundedId(executorId) || isIP(gatewayIpv4) !== 4) {
    throw new Error("HNS authority provisioner configuration is invalid");
  }
  const connectionString = required("CONTROL_PLANE_POSTGRES_URL");
  // Fail closed before any claim when the deployed schema no longer admits
  // this service generation. The refusal is bounded, redacted and named; the
  // launch guard rejects an unsupported old bundle that cannot run this check.
  const cutover = await hnsLifecycleSchemaCutoverCheck({
    connection_string: connectionString,
    service_version: HNS_AUTHORITY_SERVICE_VERSION,
    job_envelope_version: HNS_LIFECYCLE_JOB_ENVELOPE_VERSION,
  });
  if (cutover.refusal !== null) {
    console.error(JSON.stringify({ command: serve ? "serve" : "run-once", ...cutover.refusal }));
    process.exitCode = 1;
    return;
  }
  // Past the cutover, serving requires proof that this staged artifact is the
  // running service and that its executor completed the controlled readiness
  // probe through the single-owner path. A schema check alone is not proof.
  if (cutover.post_cutover) {
    const bundleSha256 = await cutoverBundleSha256();
    if (bundleSha256 === null) {
      console.error(
        JSON.stringify({
          command: serve ? "serve" : "run-once",
          outcome: "bundle_identity_missing",
        }),
      );
      process.exitCode = 1;
      return;
    }
    const probeOutcome = await runHnsLifecycleCutoverProbe({
      connection_string: connectionString,
      executor_id: executorId,
      service_version: HNS_AUTHORITY_SERVICE_VERSION,
      bundle_sha256: bundleSha256,
    });
    if (probeOutcome !== "ready" && probeOutcome !== "replayed") {
      console.error(
        JSON.stringify({
          command: serve ? "serve" : "run-once",
          outcome: "cutover_probe_failed",
          reason: probeOutcome,
        }),
      );
      process.exitCode = 1;
      return;
    }
  }
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

  // The lifecycle runner's production ports: the same observer the composed
  // path proved, the persisted due-job claim, and the operation's own row for
  // identity. This is the dispatch that was missing — the runner existed and
  // was proven, but nothing in the service loop called it.
  const lifecyclePorts = makePostgresHnsRootImportLifecycleQueue(
    connectionString,
    makeHnsLifecycleObservePort({
      observe_chain: (rootLabel: string, view: "current" | "safe") => observeChain(rootLabel, view),
    }),
  );
  // Retention reviews are dispatched from the same claim as every other
  // lifecycle job, and reuse the runner's finalizer for the paths where the
  // fenced writer never ran.
  const reviewerPorts = makePostgresHnsRetentionReviewerPorts(
    connectionString,
    (rootLabel: string, view: "current" | "safe") => observeChain(rootLabel, view),
    lifecyclePorts.finalize,
  );
  // Readiness is the one lifecycle responsibility whose acceptance is its own
  // atomic statement. The performer runs the existing readiness probes and
  // the writer persists the result, the session readiness, the lifecycle
  // transition and the job completion together. It acts only when the
  // persisted ownership marker is enabled by the handover transaction.
  const readinessPorts = makePostgresHnsLifecycleReadinessPorts(
    connectionString,
    {
      observe_current_resource: (rootLabel: string) => observeChain(rootLabel, "current"),
      reconcile_zone: reconcileZone,
      inspect_zone: inspectZone,
      observe_live: observeLive,
    },
    {
      environment: required("HNS_AUTHORITY_ENVIRONMENT"),
      valid_for_seconds: readinessValidForSeconds(),
    },
    lifecyclePorts.finalize,
  );
  const lifecycleWithReview = {
    ...lifecyclePorts,
    review: (job: Parameters<typeof runHnsRetentionReviewOnce>[0], reviewExecutorId: string) =>
      runHnsRetentionReviewOnce(job, reviewExecutorId, reviewerPorts),
    readiness: (
      job: Parameters<typeof runHnsRootImportReadinessOnce>[0],
      readinessExecutorId: string,
    ) => runHnsRootImportReadinessOnce(job, readinessExecutorId, readinessPorts),
  } as const;

  const runners: HnsExecutorRunnersV1 = {
    lifecycle: async () => {
      const result = await runHnsRootImportLifecycleJobOnce(
        executorId,
        HNS_LIFECYCLE_LEASE_SECONDS,
        lifecycleWithReview,
      );
      return { claimed: result.claimed, outcome: result.outcome, detail: result };
    },
    provisioning: async () => {
      const result = await runHnsAuthorityProvisionExecutorOnce({
        ...execution,
        only: "provisioning",
      });
      return { claimed: result.outcome !== "idle", outcome: result.outcome, detail: result };
    },
    observation: async () => {
      const result = await runHnsAuthorityProvisionExecutorOnce({
        ...execution,
        only: "observation",
      });
      return { claimed: result.outcome !== "idle", outcome: result.outcome, detail: result };
    },
  };

  let stopping = false;
  let observationRetrySpacing = false;
  let cursor = 0;
  const stop = () => {
    stopping = true;
  };
  if (serve) {
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }
  try {
    do {
      const round = await runHnsExecutorRoundV1(cursor, runners);
      cursor = round.next_cursor;
      for (const turn of round.turns) {
        if (!serve || turn.result.claimed || turn.result.outcome === "error") {
          console.log(JSON.stringify({ executor_class: turn.executor_class, ...turn.result }));
        }
      }
      // Due-job scheduling replaces the global retry sleep: keep claiming
      // while any job class has work — a waiting root never blocks
      // unrelated provisioning or renewal — and wait only when idle, for
      // the earliest persisted due time, bounded by the recovery sweep.
      // Cron remains the recovery sweep of last resort.
      const observationRetry = round.turns.some(
        (turn) =>
          turn.executor_class === "observation" &&
          turn.result.outcome === "retry" &&
          typeof turn.result.detail === "object" &&
          turn.result.detail !== null &&
          "observation_job_id" in turn.result.detail,
      );
      if (serve && round.idle && !stopping) {
        const waitMs = nextHnsExecutorWaitMs({
          now_epoch_ms: Date.now(),
          next_lifecycle_due_epoch_ms: await nextHnsLifecycleJobDueEpochMs(connectionString).catch(
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

function schemaVerificationRefusal(outcome: string, detail: string): number {
  console.error(JSON.stringify({ command: "verify-schema", outcome, detail }));
  return 2;
}

/**
 * Launch guard entrypoint. The systemd launcher runs the staged bundle with
 * `--verify-schema` before exec'ing it as the service. An old bundle that
 * predates this flag fails with its invalid-arguments refusal, so an
 * unsupported bundle cannot be started after the cutover even though the old
 * bundle itself cannot know about the compatibility record. The new bundle
 * additionally verifies its deployment manifest and bundle digest.
 */
async function runSchemaVerification(arguments_: readonly string[]): Promise<number> {
  const manifestIndex = arguments_.indexOf("--manifest");
  const manifestPath = manifestIndex === -1 ? undefined : arguments_[manifestIndex + 1];
  if (manifestPath === undefined || manifestPath.startsWith("--")) {
    return schemaVerificationRefusal("manifest_invalid", "manifest path required");
  }
  const bundleIndex = arguments_.indexOf("--bundle");
  const bundlePath = bundleIndex === -1 ? undefined : arguments_[bundleIndex + 1];
  const connectionString = process.env.CONTROL_PLANE_POSTGRES_URL;
  if (
    connectionString === undefined ||
    connectionString.trim() !== connectionString ||
    connectionString.length === 0
  ) {
    return schemaVerificationRefusal("configuration_missing", "CONTROL_PLANE_POSTGRES_URL");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Bun.file(manifestPath).text());
  } catch {
    return schemaVerificationRefusal("manifest_invalid", "manifest unreadable");
  }
  if (typeof parsed !== "object" || parsed === null) {
    return schemaVerificationRefusal("manifest_invalid", "manifest shape");
  }
  const manifest = parsed as {
    readonly bundle_sha256?: unknown;
    readonly service_version?: unknown;
    readonly job_envelope_version?: unknown;
  };
  if (
    typeof manifest.bundle_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(manifest.bundle_sha256) ||
    !isBoundedVersion(manifest.service_version) ||
    !isBoundedVersion(manifest.job_envelope_version)
  ) {
    return schemaVerificationRefusal("manifest_invalid", "manifest fields");
  }
  if (bundlePath !== undefined) {
    try {
      const bytes = await Bun.file(bundlePath).arrayBuffer();
      const digest = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
      if (digest !== manifest.bundle_sha256) {
        return schemaVerificationRefusal("bundle_mismatch", "bundle digest");
      }
    } catch {
      return schemaVerificationRefusal("bundle_mismatch", "bundle unreadable");
    }
  }
  const refusal = (
    await hnsLifecycleSchemaCutoverCheck({
      connection_string: connectionString,
      service_version: manifest.service_version,
      job_envelope_version: manifest.job_envelope_version,
    })
  ).refusal;
  if (refusal !== null) {
    console.error(JSON.stringify({ command: "verify-schema", ...refusal }));
    return 2;
  }
  console.log(
    JSON.stringify({
      command: "verify-schema",
      outcome: "compatible",
      service_version: manifest.service_version,
      job_envelope_version: manifest.job_envelope_version,
    }),
  );
  return 0;
}

if (import.meta.main) {
  const arguments_ = Bun.argv.slice(2);
  if (arguments_[0] === "--verify-schema") {
    runSchemaVerification(arguments_)
      .then((code) => {
        if (code !== 0) process.exitCode = code;
      })
      .catch((error: unknown) => {
        console.error(
          JSON.stringify({
            command: "verify-schema",
            outcome: "failed",
            detail: error instanceof Error ? error.message.slice(0, 128) : "verification failed",
          }),
        );
        process.exitCode = 2;
      });
  } else if (arguments_[0] === "--incident-report") {
    // The read-only incident command reuses the same HSD and PowerDNS
    // configuration as the serving path. It accepts either an exact root-import
    // session id or a community plus root label, and it reports missing
    // prerequisites by name instead of failing with a fixed sentence.
    const connectionString = process.env.CONTROL_PLANE_POSTGRES_URL;
    if (
      connectionString === undefined ||
      connectionString.trim() !== connectionString ||
      connectionString.length === 0
    ) {
      console.error(
        JSON.stringify({
          command: "incident-report",
          outcome: "configuration_missing",
          missing: ["CONTROL_PLANE_POSTGRES_URL"],
        }),
      );
      process.exitCode = 1;
    } else {
      const client = new Client({ connectionString });
      void (async () => {
        await client.connect();
        try {
          process.exitCode = await runHnsIncidentReportCommandV1(arguments_.slice(1), {
            env: process.env,
            query: ((text: string, values?: readonly unknown[]) =>
              client.query(text, values as never)) as never,
            fetch,
            write: (line) => console.log(line),
          });
        } finally {
          await client.end().catch(() => undefined);
        }
      })().catch((error: unknown) => {
        console.error(
          JSON.stringify({
            command: "incident-report",
            outcome: "failed",
            detail: error instanceof Error ? error.message : "incident report failed",
          }),
        );
        process.exitCode = 1;
      });
    }
  } else {
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
}
