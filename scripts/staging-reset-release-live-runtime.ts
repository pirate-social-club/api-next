import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Client } from "pg";
import { reconciliationDigest } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import { normalizePostgresConnectionString } from "./postgres-migrations.ts";
import { makeKaraokeDatabaseRelease } from "./staging-karaoke-release-database.ts";
import { makeKaraokeReleaseHttp } from "./staging-karaoke-release-http.ts";
import { makeKaraokeIngressRelease } from "./staging-karaoke-release-ingress.ts";
import type { KaraokeReleaseSurfaces } from "./staging-karaoke-release-operation.ts";
import {
  makeKaraokeProducerRelease,
  makeKaraokeVersionRelease,
} from "./staging-karaoke-release-producers.ts";
import { compileApprovedStagingPrivileges } from "./staging-persona-approved-privileges.ts";
import { collectStagingCloudflareProducers } from "./staging-persona-cloudflare-producers.ts";
import { STAGING_PRODUCER_WORKERS } from "./staging-persona-deployment-collector.ts";
import {
  withPlanetScaleDatabaseCreate,
  writeDisposableCapabilityRecovery,
} from "./staging-persona-disposable-capability.ts";
import { reconstructDisposableStaging } from "./staging-persona-disposable-reset.ts";
import { readResetGrantCatalog } from "./staging-persona-grant-catalog.ts";
import { collectStagingIngressFence } from "./staging-persona-ingress-collector.ts";
import { allowlistedReason } from "./staging-persona-rehearsal-failure.ts";
import {
  STAGING_MAIN_BRANCH_ID,
  STAGING_MAIN_BRANCH_NAME,
} from "./staging-persona-rehearsal-target.ts";
import { denyReplayedRuntimeGrants } from "./staging-persona-reset-denied-grants.ts";
import {
  assertStagingResetLedger,
  loadStagingResetArtifacts,
  STAGING_RESET_RELEASE,
  validateStagingResetArtifacts,
} from "./staging-persona-reset-plan.ts";
import {
  observeSessionDrain,
  observeSessionDrainInTransaction,
} from "./staging-persona-session-drain.ts";
import type { StagingRefence } from "./staging-reset-release-executor.ts";
import {
  makeLiveIngressRefence,
  STAGING_LIVE_CLOUDFLARE_ACCOUNT_ID,
} from "./staging-reset-release-ingress-refence.ts";
import {
  assertLiveStagingCheckouts,
  formatLiveReleaseFailure,
  makeLiveStagingUpgradeApplier,
  runLiveStagingResetReleaseComposition,
  STAGING_LIVE_RELEASE,
  type StagingResetReleaseLiveConfiguration,
  validateStagingResetReleaseLiveConfiguration,
  verifyLiveStagingRelease,
} from "./staging-reset-release-live.ts";

const execute = promisify(execFile);
/** Reviewed live staging identity: database `pirate-staging`, branch `main`. */
export const STAGING_LIVE_DATABASE_ID = "mvydkmmwh5x4";
const CLOUDFLARE_ACCOUNT_ID = STAGING_LIVE_CLOUDFLARE_ACCOUNT_ID;
const base = "organizations/{org}/databases/pirate-staging";

async function readProvider(path: string): Promise<unknown> {
  const { stdout } = await execute(
    "pscale",
    ["api", path, "--method", "GET", "--api-url", "https://api.planetscale.com/"],
    { timeout: 30_000, maxBuffer: 1_048_576, encoding: "utf8" },
  );
  return JSON.parse(stdout) as unknown;
}

/** The provider's own account of the live target. Any restored branch, a
 * non-main branch, a non-ready branch or a non-default access binding refuses
 * before a connection string is considered. */
export function assertLiveBranchIdentity(observed: {
  readonly database: { readonly id?: unknown; readonly kind?: unknown };
  readonly branch: {
    readonly id?: unknown;
    readonly name?: unknown;
    readonly ready?: unknown;
    readonly state?: unknown;
    readonly restored_from_branch?: unknown;
  };
  readonly access: {
    readonly branch?: { readonly id?: unknown } | null;
    readonly default?: unknown;
    readonly access_host_url?: unknown;
  };
}): string {
  const { database, branch, access } = observed;
  if (database.id !== STAGING_LIVE_DATABASE_ID || database.kind !== "postgresql")
    throw new Error("staging_live_database_mismatch");
  if (branch.id !== STAGING_MAIN_BRANCH_ID || branch.name !== STAGING_MAIN_BRANCH_NAME)
    throw new Error("staging_live_branch_mismatch");
  if (branch.ready !== true || branch.state !== "ready")
    throw new Error("staging_live_branch_not_ready");
  if (branch.restored_from_branch !== undefined && branch.restored_from_branch !== null)
    throw new Error("staging_live_branch_restored");
  if (
    access.branch?.id !== STAGING_MAIN_BRANCH_ID ||
    access.default !== true ||
    typeof access.access_host_url !== "string"
  )
    throw new Error("staging_live_access_mismatch");
  return access.access_host_url;
}

/** Derives the live connection target from one credential and the verified
 * access host. The host is rewritten to the provider-verified one, a branch
 * suffix must name the live branch, and a rehearsal-shaped URL cannot pass. */
export function liveConnectionTarget(raw: string, accessHost: string, branchId: string) {
  if (raw.length === 0 || !/^[a-zA-Z0-9.-]+$/u.test(accessHost))
    throw new Error("staging_live_connection_unproven");
  const url = new URL(raw);
  const username = decodeURIComponent(url.username);
  const entries = [...url.searchParams];
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hash ||
    decodeURIComponent(url.pathname) !== "/postgres" ||
    (url.port || "5432") !== "5432" ||
    url.searchParams.get("sslmode") !== "verify-full" ||
    new Set(entries.map(([key]) => key)).size !== entries.length ||
    entries.some(([key, value]) =>
      key === "sslmode" ? value !== "verify-full" : key !== "sslrootcert" || value !== "system",
    ) ||
    !username
  )
    throw new Error("staging_live_connection_unproven");
  const separator = username.lastIndexOf(".");
  const suffix = separator > 0 ? username.slice(separator + 1) : null;
  if (suffix !== null && suffix !== branchId)
    throw new Error("staging_live_branch_suffix_mismatch");
  const role = suffix === null ? username : username.slice(0, separator);
  if (!role || role.includes(".")) throw new Error("staging_live_connection_unproven");
  url.username = encodeURIComponent(username);
  url.hostname = accessHost;
  return {
    connectionString: normalizePostgresConnectionString(url.toString()),
    role,
    branchSuffixed: suffix !== null,
  };
}

/** Acquires the live operator connection through the provider-verified target.
 * The connection is closed on every path. The callback receives the operator
 * identity, the runtime role derived from the reviewed runtime credential, and
 * the operator connection string.
 *
 * No runtime SQL connection is opened here, and that is a contract rather than
 * an omission. The database CONNECT fence is held for the whole window, so a
 * correctly fenced database refuses exactly this connection; opening a probe
 * would either fail against the fence or leave a session the admission drain
 * must count as "other". The runtime identity evidence is the pre-fence SQL
 * observation pinned in the reviewed configuration, carried into the release
 * receipt by the database surface, and rechecked through the runtime
 * connection only after CONNECT is restored. */
export async function withProviderLiveStagingOperator<T>(
  use: (
    admin: Client,
    operatorRole: string,
    runtimeRole: string,
    connectionString: string,
  ) => Promise<T>,
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly provider?: (path: string) => Promise<unknown>;
    readonly connect?: (connectionString: string) => Client;
  } = {},
): Promise<T> {
  const env = options.env ?? process.env;
  const provider = options.provider ?? readProvider;
  const { Client: PgClient } = await import("pg");
  const connect =
    options.connect ??
    ((connectionString: string) =>
      new PgClient({ connectionString, connectionTimeoutMillis: 10_000 }));
  let operator: Client | undefined;
  let operatorRole: string;
  let runtimeRole: string;
  let operatorConnectionString: string;
  try {
    const database = await provider(base);
    const branch = await provider(`${base}/branches/${STAGING_MAIN_BRANCH_NAME}`);
    const access = await provider(`${base}/branches/${STAGING_MAIN_BRANCH_NAME}/roles/default`);
    const accessHost = assertLiveBranchIdentity({
      database: database as never,
      branch: branch as never,
      access: access as never,
    });
    const operatorTarget = liveConnectionTarget(
      env.CONTROL_PLANE_POSTGRES_ADMIN_URL ?? "",
      accessHost,
      STAGING_MAIN_BRANCH_ID,
    );
    const runtimeTarget = liveConnectionTarget(
      env.CONTROL_PLANE_POSTGRES_RUNTIME_URL ?? "",
      accessHost,
      STAGING_MAIN_BRANCH_ID,
    );
    if (operatorTarget.role === runtimeTarget.role)
      throw new Error("staging_live_roles_not_distinct");
    operatorRole = operatorTarget.role;
    runtimeRole = runtimeTarget.role;
    operatorConnectionString = operatorTarget.connectionString;
    operator = connect(operatorTarget.connectionString);
    await operator.connect();
    const operatorIdentity = (
      await operator.query(
        "SELECT session_user AS login,current_user AS active,current_database() AS database",
      )
    ).rows[0];
    if (
      operatorIdentity?.login !== operatorTarget.role ||
      operatorIdentity.active !== operatorTarget.role ||
      operatorIdentity.database !== "postgres"
    )
      throw new Error("staging_live_operator_identity_unproven");
  } catch (error) {
    await operator?.end().catch(() => undefined);
    // Exact allowlist, never a prefix shape: only this module's own verified
    // literals (with their finite suffixes) are preserved; everything else is
    // flattened so a driver body or credential-bearing message cannot survive.
    if (error instanceof Error && allowlistedReason(error.message) !== null) throw error;
    throw new Error("staging_live_provider_unproven");
  }
  // The callback's failures are the composition's own named outcomes; they are
  // never reclassified as provider failures. Cleanup runs on every path.
  try {
    return await use(operator as Client, operatorRole, runtimeRole, operatorConnectionString);
  } finally {
    await operator?.end().catch(() => undefined);
  }
}

/** Read-only Cloudflare fence observations. The transport is scoped to the
 * reviewed staging account and to queue/worker/access paths only. */
export function makeLiveFencePorts(input: {
  readonly accountId: string;
  readonly apiToken: string;
  readonly queuePins: readonly { readonly name: string; readonly id: string }[];
  readonly ingressApplicationId: string;
  readonly fetch?: typeof globalThis.fetch;
}) {
  if (input.accountId !== CLOUDFLARE_ACCOUNT_ID || !input.apiToken)
    throw new Error("staging_live_transport_scope_denied");
  return {
    observeProducers: () =>
      collectStagingCloudflareProducers({
        accountId: input.accountId,
        apiToken: input.apiToken,
        queues: input.queuePins as never,
        ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      }),
    observeIngress: () =>
      collectStagingIngressFence({
        accountId: input.accountId,
        apiToken: input.apiToken,
        applicationId: input.ingressApplicationId,
        ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      }),
  };
}

function stableFence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableFence);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "verifiedAt")
        .map(([key, child]) => [key, stableFence(child)]),
    );
  return value;
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Canonical fence digest. Volatile provider timestamps are stripped so the
 * digest is a fact about the fenced state, not about when it was observed. */
export function liveFenceDigest(facts: {
  readonly database: string;
  readonly schemaOid: number;
  readonly operatorRole: string;
  readonly runtimeRole: string;
  readonly sourceLedgerCount: number;
  readonly defaults: string;
  readonly producers: unknown;
  readonly ingress: unknown;
  readonly drain: unknown;
  readonly recoveryDigest: string;
}): string {
  return hash({
    database: facts.database,
    schemaOid: facts.schemaOid,
    operatorRole: facts.operatorRole,
    runtimeRole: facts.runtimeRole,
    sourceLedgerCount: facts.sourceLedgerCount,
    defaults: facts.defaults,
    producers: stableFence(facts.producers),
    ingress: stableFence(facts.ingress),
    drain: stableFence(facts.drain),
    recoveryDigest: facts.recoveryDigest,
  });
}

/** The reviewed baseline reference is a pin, not a measurement: the reset pin
 * and the recorded reconstructed-shape digest must both match. */
export function assertLiveBaselineReference(
  configuration: StagingResetReleaseLiveConfiguration,
  sourceSha: string,
  digest: string,
): void {
  if (
    sourceSha !== STAGING_RESET_RELEASE.sourceSha ||
    digest !== configuration.reset.baselineDigest
  )
    throw new Error("staging_live_baseline_reference_changed");
}

/** Measures the live admission from the verified connection and the read-only
 * fence observations, then returns the reset's admission ports. The fence
 * digest is recomputed on every assertion, so a fence that moved after
 * measurement refuses before the reset can mutate anything. */
export async function measureStagingLiveAdmission(input: {
  readonly admin: Client;
  readonly configuration: StagingResetReleaseLiveConfiguration;
  readonly operatorRole: string;
  readonly runtimeRole: string;
  readonly fences: {
    readonly observeProducers: () => Promise<unknown>;
    readonly observeIngress: () => Promise<unknown>;
  };
  /** The provider serves the live target as `postgres`. The override exists
   * only so disposable-PostgreSQL fixtures, which cannot rename their database,
   * can exercise this exact admission path. Live callers never pass it. */
  readonly expectedDatabase?: string;
  readonly withDatabaseCreate?: Parameters<
    typeof reconstructDisposableStaging
  >[2]["withDatabaseCreate"];
}) {
  const plan = validateStagingResetArtifacts(loadStagingResetArtifacts());
  const target = (
    await input.admin.query(
      `SELECT current_database() AS database,session_user AS login,current_user AS active,
      'api_next'::regnamespace::oid AS oid`,
    )
  ).rows[0];
  if (
    target === undefined ||
    target.database !== (input.expectedDatabase ?? "postgres") ||
    target.login !== input.operatorRole ||
    target.active !== input.operatorRole
  )
    throw new Error("staging_live_operator_target_changed");
  const ledger = (
    await input.admin.query(
      "SELECT version,checksum FROM api_next.schema_migrations ORDER BY version",
    )
  ).rows;
  assertStagingResetLedger(plan, ledger);
  const grants = await readResetGrantCatalog(input.admin);
  if (grants.defaults_sha256 !== input.configuration.reset.defaultsDigest)
    throw new Error("staging_live_defaults_unreviewed");
  const approved = await compileApprovedStagingPrivileges(input.admin, input.runtimeRole);
  const recoveryDigest = reconciliationDigest(
    JSON.stringify({
      captureId: input.configuration.recovery.captureId,
      captureEvidenceDigest: input.configuration.recovery.captureEvidenceDigest,
    }),
  );
  // The drain observation is transaction-aware because the reset calls this
  // fence from two very different contexts. Outside a transaction the idle
  // helper may begin, read and roll back its own read-only wrapper. Inside the
  // executor's batch transaction it must not: observeSessionDrain ends its own
  // transaction with ROLLBACK, which would silently discard the batch before
  // the executor commits it. When the admitted executor supplies its
  // transaction id, the in-transaction helper verifies that identity and
  // reads the drain without beginning, ending or changing anything.
  const observeDrain = (transactionId: string | null) =>
    transactionId === null
      ? observeSessionDrain(input.admin, input.operatorRole)
      : observeSessionDrainInTransaction(input.admin, input.operatorRole, transactionId);
  const fenceDigest = async (transactionId: string | null) =>
    liveFenceDigest({
      database: target.database,
      schemaOid: target.oid,
      operatorRole: input.operatorRole,
      runtimeRole: input.runtimeRole,
      sourceLedgerCount: ledger.length,
      defaults: grants.defaults_sha256,
      producers: await input.fences.observeProducers(),
      ingress: await input.fences.observeIngress(),
      drain: await observeDrain(transactionId),
      recoveryDigest,
    });
  const measuredFenceDigest = await fenceDigest(null);
  const assertFenceAndRecovery = async () => {
    if ((await fenceDigest(null)) !== measuredFenceDigest)
      throw new Error("staging_live_fence_changed_restore_required");
  };
  const assertFreshFence = async (context: {
    readonly transactionId: string | null;
    readonly privilegeMode: "revoked";
  }) => {
    if ((await fenceDigest(context.transactionId)) !== measuredFenceDigest)
      throw new Error("staging_live_fence_changed_restore_required");
  };
  const baselineDigest = input.configuration.reset.baselineDigest;
  return {
    markerDirectory: input.configuration.markerDirectory,
    recoveryDigest,
    targetAndFenceDigest: measuredFenceDigest,
    validUntilMs: input.configuration.validUntilMs,
    database: target.database,
    role: input.operatorRole,
    runtimeRole: input.runtimeRole,
    schemaOid: target.oid,
    defaultsDigest: grants.defaults_sha256,
    baselineDigest,
    reviewedGrants: approved.reviewed,
    grantPolicy: approved.policy,
    removalBudget: input.configuration.budgets.removal,
    replayBudget: input.configuration.budgets.replay,
    assertFenceAndRecovery,
    async assertBaselineReference(sourceSha: string, digest: string) {
      assertLiveBaselineReference(input.configuration, sourceSha, digest);
    },
    assertFreshFence,
    ...(input.withDatabaseCreate === undefined
      ? {}
      : { withDatabaseCreate: input.withDatabaseCreate }),
  } as const;
}

/** The four release surfaces from the reviewed configuration and the scoped
 * staging transport. The database factory is injectable only so a test can
 * prove what the live binding passes to the real interface; production
 * callers omit it and get the real component. */
export function makeStagingLiveReleaseSurfaces(
  configuration: StagingResetReleaseLiveConfiguration,
  transport: {
    readonly accountId: string;
    readonly apiToken: string;
    readonly fetch?: typeof globalThis.fetch;
  },
  dependencies: {
    readonly makeDatabaseRelease?: typeof makeKaraokeDatabaseRelease;
  } = {},
): KaraokeReleaseSurfaces {
  const database = (dependencies.makeDatabaseRelease ?? makeKaraokeDatabaseRelease)(
    configuration.restoration.database,
  );
  const versions = makeKaraokeVersionRelease({ ...transport, plan: configuration.plan });
  const producers = makeKaraokeProducerRelease({
    ...transport,
    plan: configuration.plan,
    schedules: configuration.restoration.producers.schedules,
  });
  const ingress = makeKaraokeIngressRelease({
    ...transport,
    applicationId: configuration.plan.ingressApplicationId,
    restoration: configuration.restoration.ingress,
  });
  return {
    versions: versions.execute,
    database: database.execute,
    ingress: ingress.execute,
    producers: producers.execute,
  };
}

/** Fixed-target re-fencing for the executor's failure recovery. The database
 * fence re-denies the reviewed runtime grants, the producer fence re-pauses
 * every queue and clears every schedule, and the ingress fence is the
 * production reversal bound by the launcher before the first mutation. A
 * callback is still optional at this seam so tests can drive it, but the
 * launcher always supplies one and an absent binding refuses by name. */
export function makeStagingLiveRefence(input: {
  readonly admin: Client;
  readonly runtimeRole: string;
  readonly accountId: string;
  readonly apiToken: string;
  readonly queuePins: readonly { readonly id: string }[];
  readonly refenceIngress?: () => Promise<void>;
  readonly fetch?: typeof globalThis.fetch;
}): StagingRefence {
  if (input.accountId !== CLOUDFLARE_ACCOUNT_ID || !input.apiToken)
    throw new Error("staging_live_transport_scope_denied");
  const http = makeKaraokeReleaseHttp({
    accountId: input.accountId,
    apiToken: input.apiToken,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });
  return {
    async database() {
      await input.admin.query("BEGIN");
      try {
        // Force xid assignment so the denial helper's transaction guard holds.
        await input.admin.query("SELECT pg_current_xact_id()");
        await denyReplayedRuntimeGrants(input.admin, input.runtimeRole);
        await input.admin.query("COMMIT");
      } catch (error) {
        await input.admin.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    },
    async producers() {
      for (const pin of input.queuePins)
        await http(`/queues/${pin.id}`, "PATCH", { settings: { delivery_paused: true } });
      for (const worker of STAGING_PRODUCER_WORKERS)
        await http(`/workers/scripts/${worker}/schedules`, "PUT", []);
    },
    async ingress() {
      if (input.refenceIngress === undefined)
        throw new Error("staging_live_ingress_refence_unavailable");
      await input.refenceIngress();
    },
  };
}

/** Proves the reviewed Solid version is the one serving before product
 * acceptance. The deployment pin and source SHA were recorded at deploy time;
 * this read establishes that the active deployment is that version. */
export function makeSolidServingVerifier(input: {
  readonly accountId: string;
  readonly apiToken: string;
  readonly worker: string;
  readonly versionId: string;
  readonly fetch?: typeof globalThis.fetch;
}) {
  const http = makeKaraokeReleaseHttp({
    accountId: input.accountId,
    apiToken: input.apiToken,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });
  return async () => {
    const result = (await http(`/workers/scripts/${input.worker}/deployments`, "GET")) as {
      readonly deployments?: readonly {
        readonly versions?: readonly {
          readonly version_id?: unknown;
          readonly percentage?: unknown;
        }[];
      }[];
    };
    const active = result?.deployments?.[0];
    const version = active?.versions?.[0];
    if (
      active === undefined ||
      active.versions?.length !== 1 ||
      version?.version_id !== input.versionId ||
      version.percentage !== 100
    )
      throw new Error("staging_live_solid_not_serving");
  };
}

/** The launch binding. It refuses before any mutation unless the configuration
 * is authorized, both reviewed checkouts are reachable from accepted main and
 * the Cloudflare token is present, then acquires the live target, measures the
 * admission, wires the release surfaces, re-fence and upgrade applier, and
 * runs the composed reset/release in one process. The dependencies seam exists
 * so the composed path can be exercised against isolated fixtures; production
 * callers omit it. */
export interface StagingLiveLaunchDependencies {
  readonly assertCheckouts: typeof assertLiveStagingCheckouts;
  readonly measureAdmission: typeof measureStagingLiveAdmission;
  readonly makeSurfaces: typeof makeStagingLiveReleaseSurfaces;
  readonly makeRefence: typeof makeStagingLiveRefence;
  readonly makeIngressRefence: typeof makeLiveIngressRefence;
  readonly makeVerifier: typeof makeSolidServingVerifier;
  readonly makeApplier: typeof makeLiveStagingUpgradeApplier;
  readonly reset: typeof reconstructDisposableStaging;
}

export async function runStagingResetReleaseLive(
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly fetch?: typeof globalThis.fetch;
    readonly provider?: (path: string) => Promise<unknown>;
    readonly connect?: (connectionString: string) => Client;
    readonly refenceIngress?: () => Promise<void>;
    readonly now?: () => string;
    readonly dependencies?: Partial<StagingLiveLaunchDependencies>;
  } = {},
) {
  const env = options.env ?? process.env;
  const configPath = env.STAGING_RESET_RELEASE_LIVE_CONFIG;
  if (!configPath) throw new Error("staging_live_configuration_missing");
  const configuration = validateStagingResetReleaseLiveConfiguration(
    JSON.parse(await Bun.file(configPath).text()) as unknown,
  );
  if (!configuration.executionAuthorized) throw new Error("staging_live_execution_unauthorized");
  if (
    configuration.version !== "staging-disposable-release-live-v1" ||
    configuration.disposable === undefined
  ) {
    throw new Error("staging_disposable_release_required");
  }
  const disposable = configuration.disposable;
  const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
  const assertCheckouts = options.dependencies?.assertCheckouts ?? assertLiveStagingCheckouts;
  assertCheckouts(repositoryRoot);
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  if (!apiToken) throw new Error("staging_live_cloudflare_token_missing");
  const measureAdmission = options.dependencies?.measureAdmission ?? measureStagingLiveAdmission;
  const makeSurfaces = options.dependencies?.makeSurfaces ?? makeStagingLiveReleaseSurfaces;
  const makeRefence = options.dependencies?.makeRefence ?? makeStagingLiveRefence;
  const makeIngressRefence = options.dependencies?.makeIngressRefence ?? makeLiveIngressRefence;
  const makeVerifier = options.dependencies?.makeVerifier ?? makeSolidServingVerifier;
  const makeApplier = options.dependencies?.makeApplier ?? makeLiveStagingUpgradeApplier;
  const reset = options.dependencies?.reset ?? reconstructDisposableStaging;
  const checkouts = STAGING_LIVE_RELEASE.checkouts;
  const solidInput = configuration.deploymentInputs.find(
    (input) => input.worker === checkouts.solid.worker,
  );
  if (solidInput === undefined) throw new Error("staging_live_deployment_input_unreviewed");
  // Recovery capability is established before the first mutation. The
  // production reversal is constructed and proven reachable here; an injected
  // test callback bypasses the provider read but is still bound as the port.
  const ingressRefence =
    options.refenceIngress === undefined
      ? makeIngressRefence({
          accountId: CLOUDFLARE_ACCOUNT_ID,
          apiToken,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        })
      : { assertAvailable: async () => {}, run: options.refenceIngress };
  try {
    await ingressRefence.assertAvailable();
  } catch {
    throw new Error("staging_live_ingress_refence_unavailable");
  }
  return withProviderLiveStagingOperator(
    async (admin, operatorRole, runtimeRole, connectionString) => {
      // The runtime role derived from the reviewed credential must match the
      // pinned role. The identity evidence is the pre-fence SQL observation
      // pinned in the configuration and is carried by the database surface; a
      // run-time runtime connection is refused by the held CONNECT fence and is
      // deliberately not attempted.
      if (configuration.restoration.database.runtimeRole !== runtimeRole)
        throw new Error("staging_live_runtime_identity_changed");
      const fences = makeLiveFencePorts({
        accountId: CLOUDFLARE_ACCOUNT_ID,
        apiToken,
        queuePins: configuration.plan.resumeQueues,
        ingressApplicationId: configuration.plan.ingressApplicationId,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      const admission = await measureAdmission({
        admin,
        configuration,
        operatorRole,
        runtimeRole,
        fences,
        withDatabaseCreate: ({ database, ownerRole, execute }) => {
          if (database !== "postgres" || ownerRole !== operatorRole) {
            throw new Error("staging_disposable_target_changed");
          }
          return withPlanetScaleDatabaseCreate({
            ownerRole,
            roleName: disposable.roleName,
            accessHost: new URL(connectionString).hostname,
            branchId: disposable.branchId,
            execute,
            recordRecovery: (evidence) =>
              writeDisposableCapabilityRecovery(configuration.markerDirectory, evidence),
          });
        },
      });
      const databaseCreate = admission.withDatabaseCreate;
      if (databaseCreate === undefined) {
        throw new Error("staging_disposable_capability_unbound");
      }
      const disposableAdmission = { ...admission, withDatabaseCreate: databaseCreate };
      const surfaces = makeSurfaces(configuration, {
        accountId: CLOUDFLARE_ACCOUNT_ID,
        apiToken,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      const refence = makeRefence({
        admin,
        runtimeRole,
        accountId: CLOUDFLARE_ACCOUNT_ID,
        apiToken,
        queuePins: configuration.plan.resumeQueues,
        refenceIngress: ingressRefence.run,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      return runLiveStagingResetReleaseComposition({
        configuration,
        database: admin,
        artifacts: loadStagingResetArtifacts(),
        admission: disposableAdmission,
        reset,
        surfaces,
        refence,
        // The composition requires an object with `apply`. A bare function
        // would only appear to work through Function.prototype.apply, which is
        // an accident of JavaScript, not a correctly typed adapter.
        upgrade: { apply: makeApplier(connectionString) },
        verifyDeployedPair: makeVerifier({
          accountId: CLOUDFLARE_ACCOUNT_ID,
          apiToken,
          worker: checkouts.solid.worker,
          versionId: solidInput.versionId,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        }),
        ...(options.fetch === undefined ? {} : { acceptanceFetch: options.fetch }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    },
    {
      env,
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.connect === undefined ? {} : { connect: options.connect }),
    },
  );
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length === 1 && args[0] === "--verify") {
      console.log(JSON.stringify(await verifyLiveStagingRelease()));
    } else if (args.includes("--execute") && args.includes("--confirm-staging")) {
      console.log(JSON.stringify(await runStagingResetReleaseLive()));
    } else {
      throw new Error(
        "Use --verify offline, or --execute --confirm-staging with an authorized live configuration.",
      );
    }
  } catch (error) {
    console.error(formatLiveReleaseFailure(error));
    process.exitCode = 1;
  }
}
