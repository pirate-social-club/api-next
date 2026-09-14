import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { reconciliationDigest } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import {
  decodeReconciliation,
  ReconciliationDigest,
} from "../packages/platform-cf/src/karaoke-reconciliation-schema.ts";
import { runPostgresMigrations } from "./postgres-migrations.ts";
import { KaraokeIngressRestoration } from "./staging-karaoke-release-ingress.ts";
import {
  KaraokeReleasePlan,
  type KaraokeReleaseSurfaces,
} from "./staging-karaoke-release-operation.ts";
import { KaraokeReleasedSchedules } from "./staging-karaoke-release-producers.ts";
import { STAGING_FENCED_QUEUES } from "./staging-persona-cloudflare-producers.ts";
import { STAGING_PRODUCER_WORKERS } from "./staging-persona-deployment-collector.ts";
import { describeRehearsalFailure } from "./staging-persona-rehearsal-failure.ts";
import {
  applyStagingUpgradeInPhases,
  loadStagingUpgradeArtifacts,
  type StagingUpgradeReceipt,
} from "./staging-persona-upgrade-plan.ts";
import type { RefencedOutcomes, StagingRefence } from "./staging-reset-release-executor.ts";
import {
  reconstructAndReleaseStaging,
  type StagingResetAdmission,
  type StagingResetArtifacts,
  type StagingResetCompletion,
  type StagingResetDatabase,
  StagingResetRunUnresolved,
  StagingUpgradeFailedRestoreRequired,
} from "./staging-reset-release-runtime.ts";

const FULL_SHA = /^[0-9a-f]{40}$/u;
const ID = /^[a-f0-9-]{32,36}$/u;
const Sha = Schema.String.check(Schema.isPattern(FULL_SHA));
const Id = Schema.String.check(Schema.isPattern(ID));
const Worker = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));

/** The live window's reviewed identity. These are the only checkouts and
 * workers this binding will deploy or verify: the song recovery pair
 * (API `e9d6e6c7`, Solid `d023b0bc`) onto staging. The two commits
 * are read from immutable Git history by `assertReviewedStagingCheckouts`, never
 * from the executing checkout's mutable refs. */
export const STAGING_LIVE_RELEASE = Object.freeze({
  surfaceOrder: Object.freeze(["versions", "database", "ingress", "producers"] as const),
  checkouts: Object.freeze({
    api: Object.freeze({
      worker: "pirate-http-worker-staging",
      environment: "staging",
      configPath: "apps/http-worker/wrangler.jsonc",
      sourceSha: "e9d6e6c7495bb2b5e257c4e5cd3508d134c1c8aa",
    }),
    solid: Object.freeze({
      worker: "pirate-web-solid-staging",
      environment: "staging",
      configPath: "wrangler.jsonc",
      sourceSha: "d023b0bcd1d6c48ff36ada86b6bc69e537398de4",
    }),
  }),
  /** Failure is a disposition, not a retry. The binding writes its recovery
   * receipt into the marker directory, retains every fence and marker, and
   * leaves recovery to the governed capture restore. */
  recovery: "retain_marker_and_fences_capture_restore_owns_recovery",
} as const);

/** The fence state each composition step runs under. The executor enforces the
 * surface order; this declaration is the reviewable contract it must match:
 * the reset, versions activation and schema upgrade run with every fence held;
 * grants are restored while producers stay paused; ingress opens before the
 * pre-producer acceptance read; producers are released last. */
export const STAGING_LIVE_FENCE_TRANSITIONS = Object.freeze([
  Object.freeze({ step: "reset", ingress: "held", database: "held", producers: "held" }),
  Object.freeze({ step: "versions", ingress: "held", database: "held", producers: "held" }),
  Object.freeze({ step: "upgrade", ingress: "held", database: "held", producers: "held" }),
  Object.freeze({ step: "database", ingress: "held", database: "restored", producers: "held" }),
  Object.freeze({ step: "ingress", ingress: "open", database: "restored", producers: "held" }),
  Object.freeze({ step: "acceptance", ingress: "open", database: "restored", producers: "held" }),
  Object.freeze({ step: "producers", ingress: "open", database: "restored", producers: "open" }),
] as const);

const Budget = Schema.Struct({
  maxOwnLockRows: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  maxClusterLockRows: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  maxClosureObjects: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
const ReplayBudget = Schema.Struct({
  maxLockRows: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  maxClusterLockRows: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  statementTimeoutMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

const DeploymentInput = Schema.Struct({
  worker: Worker,
  sourceSha: Sha,
  versionId: Id,
});

/** The owner-held live-window inputs. Shape validation is not approval: every
 * cross-binding below must match the reviewed plan and the reviewed checkouts,
 * and the recorded owner approval must name the digest of the release plan and
 * destructive reset mode together. */
export const StagingResetReleaseLiveConfiguration = Schema.Struct({
  version: Schema.Literals(["staging-reset-release-live-v1", "staging-disposable-release-live-v1"]),
  executionAuthorized: Schema.Boolean,
  approvedPlanDigest: ReconciliationDigest,
  plan: KaraokeReleasePlan,
  deploymentInputs: Schema.Array(DeploymentInput).check(Schema.isLengthBetween(2, 2)),
  restoration: Schema.Struct({
    ingress: KaraokeIngressRestoration,
    database: Schema.Struct({
      targetBindingDigest: ReconciliationDigest,
      reviewedGrantDigest: ReconciliationDigest,
      /** The approved restoration intent. `makeKaraokeDatabaseRelease` refuses
       * at its first execute check without it, so it is an explicit reviewed
       * input rather than a default the binding supplies. */
      restoreRuntimeConnect: Schema.Literal(true),
      runtimeRole: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_]{1,63}$/u)),
      runtimeIdentityEvidence: ReconciliationDigest,
    }),
    producers: Schema.Struct({ schedules: KaraokeReleasedSchedules }),
  }),
  acceptance: Schema.optional(
    Schema.Struct({
      apiBaseUrl: Schema.String.check(Schema.isPattern(/^https:\/\/[a-z0-9][a-z0-9.-]*$/u)),
      communityId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
      privyAccessToken: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384)),
      expectedPersonaId: Schema.optional(
        Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
      ),
    }),
  ),
  /** Reviewed reset references: the measured shape of the reconstructed `0119`
   * schema and the pre-reset default-ACL digest the admission must observe. */
  reset: Schema.Struct({
    baselineDigest: ReconciliationDigest,
    defaultsDigest: ReconciliationDigest,
  }),
  /** The fresh fenced capture that is the only recovery copy, and the digest
   * of the evidence that established it. */
  recovery: Schema.Struct({
    captureId: Schema.String.check(Schema.isPattern(/^[a-z0-9]{6,32}$/u)),
    captureEvidenceDigest: ReconciliationDigest,
  }),
  markerDirectory: Schema.String.check(Schema.isMinLength(1)),
  validUntilMs: Schema.Int.check(Schema.isGreaterThan(0)),
  budgets: Schema.Struct({ removal: Budget, replay: ReplayBudget }),
  disposable: Schema.optional(
    Schema.Struct({
      mode: Schema.Literal("drop_schema_recreate"),
      roleName: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/u)),
      branchId: Schema.Literal("syu03e00w3ux"),
      roleTtlMinutes: Schema.Literal(30),
      /** The pre-producer product acceptance for the disposable release: the
       * reviewed community-creation journey through the real UI. The legacy
       * persona read is not accepted alongside it. */
      communityCreation: Schema.optional(
        Schema.Struct({
          baseUrl: Schema.String.check(Schema.isPattern(/^https:\/\/[a-z0-9][a-z0-9.-]*$/u)),
          timeoutMs: Schema.Int.check(
            Schema.isGreaterThan(0),
            Schema.isLessThanOrEqualTo(3_600_000),
          ),
        }),
      ),
    }),
  ),
});
export type StagingResetReleaseLiveConfiguration = typeof StagingResetReleaseLiveConfiguration.Type;

/** Validates the live configuration against the reviewed identity: the plan
 * digest is recomputed, the surface order and grant digest must match the
 * recorded approval, and the two deployment inputs must pair the reviewed
 * checkouts with the exact version IDs pinned in the plan. */
export function validateStagingResetReleaseLiveConfiguration(value: unknown) {
  const config = decodeReconciliation(StagingResetReleaseLiveConfiguration, value);
  if (
    (config.version === "staging-reset-release-live-v1" && config.disposable !== undefined) ||
    (config.version === "staging-disposable-release-live-v1" && config.disposable === undefined)
  ) {
    throw new Error("staging_live_reset_mode_unreviewed");
  }
  const communityCreation = config.disposable?.communityCreation;
  if (config.version === "staging-disposable-release-live-v1") {
    // The disposable release must run the reviewed community-creation journey
    // as its product acceptance; the persona read assumes identity that the
    // destructive reset removes and cannot be selected by accident.
    if (communityCreation === undefined)
      throw new Error("staging_live_community_creation_required");
    if (config.acceptance !== undefined) throw new Error("staging_live_acceptance_ambiguous");
  } else if (config.acceptance === undefined) {
    throw new Error("staging_live_acceptance_missing");
  }
  const approvedMaterial =
    config.version === "staging-disposable-release-live-v1"
      ? { plan: config.plan, disposable: config.disposable }
      : config.plan;
  if (config.approvedPlanDigest !== reconciliationDigest(JSON.stringify(approvedMaterial)))
    throw new Error("staging_live_release_plan_changed");
  if (
    JSON.stringify(config.plan.surfaceOrder) !== JSON.stringify(STAGING_LIVE_RELEASE.surfaceOrder)
  )
    throw new Error("staging_live_release_order_changed");
  if (config.plan.reviewedGrantDigest !== config.restoration.database.reviewedGrantDigest)
    throw new Error("staging_live_release_grant_digest_changed");
  if (config.plan.resumeQueues.length !== STAGING_FENCED_QUEUES.length)
    throw new Error("staging_live_release_queue_set_changed");
  const queueNames = config.plan.resumeQueues.map((queue) => queue.name).sort();
  if (JSON.stringify(queueNames) !== JSON.stringify([...STAGING_FENCED_QUEUES].sort()))
    throw new Error("staging_live_release_queue_set_changed");
  if (config.plan.servingWorkers.length !== STAGING_PRODUCER_WORKERS.length)
    throw new Error("staging_live_release_serving_set_changed");
  const servedWorkers = config.plan.servingWorkers.map((pin) => pin.worker).sort();
  if (JSON.stringify(servedWorkers) !== JSON.stringify([...STAGING_PRODUCER_WORKERS].sort()))
    throw new Error("staging_live_release_serving_set_changed");
  const inputs = [...config.deploymentInputs].sort((a, b) => a.worker.localeCompare(b.worker));
  if (new Set(inputs.map((input) => input.worker)).size !== 2)
    throw new Error("staging_live_deployment_input_duplicate");
  const apiInput = inputs.find(
    (input) => input.worker === STAGING_LIVE_RELEASE.checkouts.api.worker,
  );
  if (apiInput?.sourceSha !== STAGING_LIVE_RELEASE.checkouts.api.sourceSha)
    throw new Error("staging_live_deployment_input_unreviewed");
  if (
    !config.plan.servingWorkers.some(
      (pin) => pin.worker === apiInput.worker && pin.versionId === apiInput.versionId,
    )
  )
    throw new Error("staging_live_deployment_version_unpinned");
  // The Solid application is not one of the producer workers the release
  // plan activates; its reviewed checkout and deployed version are verified
  // by the launch binding before producers are released.
  const solidInput = inputs.find(
    (input) => input.worker === STAGING_LIVE_RELEASE.checkouts.solid.worker,
  );
  if (solidInput?.sourceSha !== STAGING_LIVE_RELEASE.checkouts.solid.sourceSha)
    throw new Error("staging_live_deployment_input_unreviewed");
  return Object.freeze(config);
}

function gitReader(repositoryRoot: string): GitRunner {
  return (args: readonly string[]): { stdout: string; status: number } => {
    try {
      const stdout = execFileSync("git", [...args], {
        cwd: repositoryRoot,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { stdout, status: 0 };
    } catch (error) {
      const status = (error as { status?: number }).status ?? 1;
      return { stdout: "", status };
    }
  };
}

export type GitRunner = (args: readonly string[]) => {
  readonly stdout: string;
  readonly status: number;
};

export function findSiblingRepository(apiRoot: string, name: string): string {
  let candidate = resolve(apiRoot, "..");
  for (let depth = 0; depth < 4; depth++) {
    const sibling = join(candidate, name);
    if (existsSync(join(sibling, ".git"))) return sibling;
    candidate = resolve(candidate, "..");
  }
  throw new Error("staging_live_checkout_root_unresolved");
}

/** The released pair spans two repositories: the API commit is checked in the
 * executing repository and the Solid commit in the sibling application
 * checkout. Both must exist and be reachable from their accepted main ref.
 * This is a local, read-only fact; the deployment command still proves the
 * tree it deploys. */
export function assertReviewedStagingCheckouts(options: {
  readonly api: { readonly root: string; readonly run?: GitRunner };
  readonly solid: { readonly root: string; readonly run?: GitRunner };
}): Readonly<{ api: string; solid: string }> {
  const verified: { api: string; solid: string } = { api: "", solid: "" };
  const targets = [
    ["api", STAGING_LIVE_RELEASE.checkouts.api, options.api],
    ["solid", STAGING_LIVE_RELEASE.checkouts.solid, options.solid],
  ] as const;
  for (const [kind, checkout, target] of targets) {
    const run = target.run ?? gitReader(target.root);
    if (run(["cat-file", "-e", `${checkout.sourceSha}^{commit}`]).status !== 0)
      throw new Error(`staging_live_checkout_missing:${kind}`);
    if (run(["merge-base", "--is-ancestor", checkout.sourceSha, "origin/main"]).status !== 0)
      throw new Error(`staging_live_checkout_unreviewed:${kind}`);
    verified[kind] = checkout.sourceSha;
  }
  return Object.freeze(verified);
}

/** The launch binding's checkout assertion over the executing API repository
 * and the sibling Solid application checkout. */
export function assertLiveStagingCheckouts(repositoryRoot: string) {
  return assertReviewedStagingCheckouts({
    api: { root: repositoryRoot },
    solid: { root: findSiblingRepository(repositoryRoot, "pirate-web-solid") },
  });
}

/** The live-window counterpart of `applyStagingUpgradeOnRehearsalBranch`. The
 * connection string is acquired by the live operator boundary and verified
 * against the provider before this applier is made, so it accepts no caller
 * target: the ordinary runner still enforces the exact reconstructed `0119`
 * ledger inside its apply transaction, before the first mutation. */
export function makeLiveStagingUpgradeApplier(
  connectionString: string,
  run: typeof runPostgresMigrations = runPostgresMigrations,
) {
  return async (): Promise<StagingUpgradeReceipt> =>
    applyStagingUpgradeInPhases(connectionString, async (input) => {
      const output = await run(input);
      if (output.dryRun) throw new Error("staging_live_upgrade_unexpected_dry_run");
      return output;
    });
}

const SESSION_COOKIE = "__Host-pirate_session";

function sessionCookie(headers: Headers): string | null {
  const listed = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  const values = listed.length === 0 ? [headers.get("set-cookie") ?? ""] : listed;
  for (const value of values) {
    const [pair] = value.split(";");
    if (pair?.startsWith(`${SESSION_COOKIE}=`)) return pair;
  }
  return null;
}

/** The pre-producer acceptance read, through the real HTTP boundary: the
 * configured account exchanges its Privy proof for a session, then reads its
 * private personas and the community binding the release must have restored.
 * Any non-200 or an unbound persona refuses the release before producers are
 * released. The token is never logged or placed in a receipt. */
export function makeLiveAcceptanceCheck(input: {
  readonly apiBaseUrl: string;
  readonly communityId: string;
  readonly privyAccessToken: string;
  readonly expectedPersonaId?: string;
  readonly fetch?: typeof globalThis.fetch;
}) {
  const base = input.apiBaseUrl.replace(/\/+$/u, "");
  return async (): Promise<{ readonly personaId: string }> => {
    const transport = input.fetch ?? globalThis.fetch;
    const exchange = await transport(`${base}/auth/session/exchange`, {
      method: "POST",
      redirect: "manual",
      headers: { accept: "application/json", "content-type": "application/json", origin: base },
      body: JSON.stringify({
        proof: { type: "privy_access_token", privy_access_token: input.privyAccessToken },
      }),
    });
    if (exchange.status !== 200) throw new Error("staging_live_acceptance_session_failed");
    const cookie = sessionCookie(exchange.headers);
    if (cookie === null) throw new Error("staging_live_acceptance_session_failed");
    const response = await transport(`${base}/personas`, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json", cookie },
    });
    if (response.status !== 200) throw new Error("staging_live_acceptance_persona_read_failed");
    const body = (await response.json()) as { personas?: unknown };
    if (!Array.isArray(body.personas))
      throw new Error("staging_live_acceptance_persona_read_failed");
    const bound = body.personas.find((persona) => {
      if (typeof persona !== "object" || persona === null) return false;
      const record = persona as {
        persona_id?: unknown;
        status?: unknown;
        community_binding?: { community_id?: unknown } | null;
      };
      return (
        record.status === "active" &&
        record.community_binding?.community_id === input.communityId &&
        (input.expectedPersonaId === undefined || record.persona_id === input.expectedPersonaId)
      );
    }) as { persona_id?: unknown } | undefined;
    if (bound === undefined || typeof bound.persona_id !== "string")
      throw new Error("staging_live_acceptance_persona_unbound");
    return { personaId: bound.persona_id };
  };
}

function recoveryReceiptPath(markerDirectory: string): string {
  return join(markerDirectory, "staging-reset-release-recovery.json");
}

/** The only failure line a live release CLI may print. The shared describer
 * states an allowlisted application reason, a fixed category, a SQLSTATE when
 * the driver supplied one, and the digest of anything withheld. Raw exception
 * messages, driver bodies, queries and credentials never reach output. */
export function formatLiveReleaseFailure(error: unknown): string {
  const described = describeRehearsalFailure(error);
  return JSON.stringify({
    reason: described.reason,
    category: described.category,
    sqlstate: described.sqlstate,
    message_sha256: described.message_sha256,
  });
}

/** Durable, redacted failure evidence. The composition already retains the
 * marker and fences; this receipt is what makes the failure readable after the
 * process exits. It carries reasons, surfaces, digests and the policy, never
 * credentials or provider payloads. */
export function makeLiveRecoveryReceipt(markerDirectory: string) {
  return async (refenced: RefencedOutcomes): Promise<void> => {
    const record = {
      schema_version: 1,
      policy: STAGING_LIVE_RELEASE.recovery,
      disposition: "unresolved",
      refenced,
      recorded_at: new Date().toISOString(),
    };
    await mkdir(markerDirectory, { recursive: true });
    const temporary = `${recoveryReceiptPath(markerDirectory)}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, recoveryReceiptPath(markerDirectory));
  };
}

/** Binds the reviewed live configuration and its ports to the paired
 * reset/release composition. The composition owns ordering, fence retention
 * and failure disposition; this binding owns the acceptance read, the
 * redacted recovery receipt and the refusal to run an unpinned deployment.
 *
 * `verifyDeployedPair` is the Solid half of the paired-deployment proof that
 * the release plan cannot carry: the plan activates only the four producer
 * workers, and the application Worker is verified here, after ingress opens
 * and before the acceptance read that gates producer release. */
export async function runLiveStagingResetReleaseComposition<
  Admission extends StagingResetAdmission,
>(input: {
  readonly configuration: StagingResetReleaseLiveConfiguration;
  readonly database: StagingResetDatabase;
  readonly artifacts: StagingResetArtifacts;
  readonly admission: Admission;
  readonly reset?: (
    database: StagingResetDatabase,
    artifacts: StagingResetArtifacts,
    admission: Admission,
  ) => Promise<StagingResetCompletion>;
  readonly surfaces: KaraokeReleaseSurfaces;
  readonly refence: StagingRefence;
  readonly upgrade: { apply: () => Promise<StagingUpgradeReceipt> };
  /** Proves the reviewed Solid target is the version serving before product
   * acceptance. A no-op or assertion is not evidence. */
  readonly verifyDeployedPair: () => Promise<void>;
  /** The disposable release's product acceptance: the reviewed community
   * creation journey. Required exactly when the configuration selects it. */
  readonly communityCreationAcceptance?: () => Promise<void>;
  /** Transport override for the acceptance read; the live launcher passes its
   * reviewed transport through so the composed path is testable without
   * reaching a network. */
  readonly acceptanceFetch?: typeof globalThis.fetch;
  readonly onAttempt?: Parameters<typeof reconstructAndReleaseStaging>[0]["release"]["onAttempt"];
  readonly now?: () => string;
}) {
  const configuration = validateStagingResetReleaseLiveConfiguration(input.configuration);
  const communityCreation = configuration.disposable?.communityCreation;
  let productAcceptance: () => Promise<unknown>;
  if (communityCreation !== undefined) {
    if (input.communityCreationAcceptance === undefined)
      throw new Error("staging_community_creation_acceptance_unbound");
    productAcceptance = input.communityCreationAcceptance;
  } else {
    const persona = configuration.acceptance;
    if (persona === undefined) throw new Error("staging_live_acceptance_missing");
    productAcceptance = makeLiveAcceptanceCheck({
      apiBaseUrl: persona.apiBaseUrl,
      communityId: persona.communityId,
      privyAccessToken: persona.privyAccessToken,
      ...(persona.expectedPersonaId === undefined
        ? {}
        : { expectedPersonaId: persona.expectedPersonaId }),
      ...(input.acceptanceFetch === undefined ? {} : { fetch: input.acceptanceFetch }),
    });
  }
  const onRecovery = makeLiveRecoveryReceipt(configuration.markerDirectory);
  try {
    return await reconstructAndReleaseStaging({
      database: input.database,
      artifacts: input.artifacts,
      admission: input.admission,
      ...(input.reset === undefined ? {} : { reset: input.reset }),
      release: {
        plan: configuration.plan,
        surfaces: input.surfaces,
        acceptance: async () => {
          await input.verifyDeployedPair();
          await productAcceptance();
        },
        refence: input.refence,
        onRecovery,
        ...(input.now === undefined ? {} : { now: input.now }),
        ...(input.onAttempt === undefined ? {} : { onAttempt: input.onAttempt }),
      },
      upgrade: input.upgrade,
    });
  } catch (error) {
    const outcome =
      error instanceof StagingResetRunUnresolved ||
      error instanceof StagingUpgradeFailedRestoreRequired
        ? error.outcome
        : undefined;
    const upgrade =
      error instanceof StagingResetRunUnresolved ||
      error instanceof StagingUpgradeFailedRestoreRequired
        ? error.upgrade
        : undefined;
    // The durable record uses the same exact-allowlist/category/digest boundary
    // as the CLI: an arbitrary exception message, driver body or credential
    // must never be written into recovery evidence.
    const failure = describeRehearsalFailure(error);
    const record = {
      schema_version: 1,
      policy: STAGING_LIVE_RELEASE.recovery,
      disposition: "unresolved",
      reason: failure.reason,
      category: failure.category,
      sqlstate: failure.sqlstate,
      message_sha256: failure.message_sha256,
      failed_surface: outcome?.failedSurface ?? null,
      receipts: outcome?.receipts ?? [],
      refenced: outcome?.refenced ?? null,
      upgrade: upgrade ?? null,
      recorded_at: new Date().toISOString(),
    };
    await mkdir(configuration.markerDirectory, { recursive: true });
    const path = recoveryReceiptPath(configuration.markerDirectory);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
    throw error;
  }
}

/** Offline verification for the approval package. It reads the configuration,
 * validates every cross-binding, and proves both checkouts are reachable from
 * accepted main. It opens no database or provider connection and performs no
 * mutation; `--execute` is deliberately not offered until the live launch
 * binding (operator fence ports) is authorized. */
export async function verifyLiveStagingRelease() {
  const path = process.env.STAGING_RESET_RELEASE_LIVE_CONFIG;
  if (!path) throw new Error("staging_live_configuration_missing");
  const raw = JSON.parse(await Bun.file(path).text()) as unknown;
  const configuration = validateStagingResetReleaseLiveConfiguration(raw);
  if (
    configuration.version !== "staging-disposable-release-live-v1" ||
    configuration.disposable === undefined
  ) {
    throw new Error("staging_disposable_release_required");
  }
  const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
  const checkouts = assertLiveStagingCheckouts(repositoryRoot);
  return {
    mode: "offline-live-release-plan",
    plan_digest: configuration.approvedPlanDigest,
    plan_version: configuration.plan.version,
    surface_order: configuration.plan.surfaceOrder,
    fence_transitions: STAGING_LIVE_FENCE_TRANSITIONS.map((transition) => transition.step),
    deployment_inputs: configuration.deploymentInputs.map((input) => ({
      worker: input.worker,
      source_sha: input.sourceSha,
      version_id: input.versionId,
    })),
    reviewed_checkouts: checkouts,
    execution_authorized: configuration.executionAuthorized,
    upgrade_source_sha: loadStagingUpgradeArtifacts().sourceSha,
    reset_mode: configuration.disposable.mode,
    temporary_role_name: configuration.disposable.roleName,
    database_connected: false,
    provider_contacted: false,
  };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length !== 1 || args[0] !== "--verify")
      throw new Error(
        "This binding accepts only --verify offline; the live launch binding is not authorized.",
      );
    console.log(JSON.stringify(await verifyLiveStagingRelease()));
  } catch (error) {
    console.error(formatLiveReleaseFailure(error));
    process.exitCode = 1;
  }
}
