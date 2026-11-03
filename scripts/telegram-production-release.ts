import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { superviseProductionTimeout } from "./production-release/production-bounded-process.ts";
import { checkBoundProcess } from "./production-release/production-linux-process-bound.ts";
import { injectedProductionUrls } from "./production-release/production-managed-environment.ts";
import {
  directoryIdentity,
  exclusiveRecord,
} from "./production-release/production-operation-evidence.ts";
import { sha256 } from "./public-post-http-release-core.ts";
import { fileHash, publicPostExecutionTools } from "./public-post-http-release-source.ts";
import {
  admitTelegram,
  resolveTelegramPhase,
  type TelegramAdmission,
  type TelegramFile,
  type TelegramReview,
  telegramJournal,
  telegramJson,
  telegramPhase,
} from "./telegram-production-release-admission.ts";
import {
  appendTelegramCanary,
  catalogueAcceptance,
  telegramCorpus,
  telegramDecision,
  telegramPracticeReadiness,
} from "./telegram-production-release-catalogue.ts";
import {
  createTelegramWrappingKey,
  credentialContract,
  managedTelegramVault,
} from "./telegram-production-release-credentials.ts";
import {
  applyTelegramGrants,
  applyTelegramMigration,
  assertTelegramFunctions,
  assertTelegramLedger,
  assertTelegramMatrix,
  pauseTelegramStudyIntent,
  telegramRecoveryWork as recoveryWork,
  telegramDatabase,
  telegramGlobalInventory,
  telegramPrivileges,
  telegramRowLocks,
} from "./telegram-production-release-database.ts";
import {
  TELEGRAM_RELEASE as policy,
  requireTelegram,
  TELEGRAM_PHASES,
  type TelegramPhase,
  TelegramReleaseRefused,
  type TelegramWorker,
} from "./telegram-production-release-policy.ts";
import {
  publishedTelegramSources,
  publishedTelegramTooling,
  qualifiedTelegramApplication,
  telegramDependencyInventory,
} from "./telegram-production-release-source.ts";
import {
  assertTelegramDisabledTarget,
  assertTelegramRecoveryVersion,
  collectTelegramWorker,
  rollbackTelegramWorker,
  type TelegramWorkerSnapshot,
  telegramPhaseConfig,
  telegramServingOrigins,
  telegramWorkerState,
  uploadTelegramWorker,
} from "./telegram-production-release-workers.ts";
import { digest } from "./worker-binding-drift.ts";

const self = fileURLToPath(import.meta.url),
  journal = resolve(policy.paths.operation, "journal");
const isRecovery = (phase: TelegramPhase) =>
  phase.startsWith("pause-") || phase.startsWith("recover-");
const phaseWorker = (phase: TelegramPhase): TelegramWorker =>
  phase.endsWith("jobs") ? "jobs" : "http";
function argumentsFor(args: readonly string[]) {
  const mode = args[0] ?? "preview";
  requireTelegram(
    [
      "preview",
      "dependency-preview",
      "initialize",
      "observe",
      "execute",
      "observe-child",
      "execute-child",
      "resolve",
      "resolve-child",
      "probe",
      "probe-child",
    ].includes(mode),
    "unknown-telegram-operation",
  );
  const options: Record<string, string> = {};
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    requireTelegram(
      key &&
        [
          "--phase",
          "--review",
          "--review-sha",
          "--admission",
          "--admission-sha",
          "--request",
          "--request-sha",
        ].includes(key) &&
        value &&
        !value.startsWith("--") &&
        options[key] === undefined,
      "invalid-telegram-operation-arguments",
    );
    options[key] = value;
  }
  if (["preview", "dependency-preview", "probe", "probe-child"].includes(mode))
    requireTelegram(Object.keys(options).length === 0, "operation-takes-no-options");
  return { mode, options };
}
async function boundChild(
  mode: string,
  reviewSha: string,
  admissionSha: string,
  tools: ReturnType<typeof publicPostExecutionTools>,
) {
  const path = process.env.PIRATE_RELEASE_OUTER_START_PATH ?? "";
  requireTelegram(
    path.startsWith(`${mode === "probe" ? policy.paths.processQualification : journal}/outer-`) &&
      /outer-[a-f0-9-]+-start\.json$/u.test(path),
    "bounded-parent-handshake-required",
  );
  const childPath = path.replace(/-start\.json$/u, "-child.json");
  const until = Date.now() + 1_500;
  while (!existsSync(childPath) && Date.now() < until) await delay(5);
  return () => {
    const start = JSON.parse(readFileSync(path, "utf8")),
      child = JSON.parse(readFileSync(childPath, "utf8"));
    requireTelegram(
      start.mode === mode &&
        start.executor_sha256 === fileHash(self) &&
        start.wrapper_sha256 === fileHash(self) &&
        start.review_sha256 === reviewSha &&
        start.admission_sha256 === admissionSha &&
        child.start_sha256 === fileHash(path),
      "bounded-operation-tuple-differs",
    );
    checkBoundProcess(start, child, self, { execution_tools: tools });
  };
}
async function restoreDisabled(
  worker: TelegramWorker,
  reference: TelegramFile,
  review: TelegramReview,
  assertBound: () => void,
) {
  const target = telegramJson<TelegramWorkerSnapshot>(reference);
  assertTelegramDisabledTarget(target, worker);
  // Both pause phases must already be verified. Candidate acceptance is not required for this recovery.
  const current = await collectTelegramWorker(worker);
  for (const snapshot of [
    await collectTelegramWorker("http"),
    await collectTelegramWorker("jobs"),
  ]) {
    const mode = JSON.parse(
      String(snapshot.bindings.find((r) => r.name === "TELEGRAM_CONFIG_JSON")?.text),
    );
    requireTelegram(
      mode.enabled === false &&
        mode.linking_enabled === false &&
        mode.practice_enabled === false &&
        !mode.community_practice_enabled,
      "both-workers-must-be-paused-before-traffic-restore",
    );
  }
  assertBound();
  exclusiveRecord(policy.paths.operation, `recover-${worker}-traffic-attempt.json`, {
    target_version: target.version,
    current_version: current.version,
    target_sha256: reference.sha256,
  });
  const result = await rollbackTelegramWorker(worker, target.version, review, assertBound);
  requireTelegram(result.exitCode === 0, "recovery-traffic-acknowledgement-unresolved");
  const after = await collectTelegramWorker(worker);
  requireTelegram(
    after.version === target.version &&
      after.latest === current.latest &&
      digest(telegramWorkerState(after, true)) === digest(telegramWorkerState(target, true)),
    "recovery-serving-state-unverified",
  );
}
async function liveIo(
  phase: TelegramPhase,
  review: TelegramReview,
  reviewSha: string,
  admission: TelegramAdmission,
  bound: () => void,
  resolving = false,
) {
  const assertBound = () => {
    admitTelegram(review, reviewSha, admission, phase, admission.access, Date.now());
    bound();
  };
  assertBound();
  if (!isRecovery(phase)) credentialContract(review.credential_contract);
  if (isRecovery(phase)) publishedTelegramTooling(review);
  else publishedTelegramSources(review);
  const urls = injectedProductionUrls();
  const vault = () => managedTelegramVault(review.credential_contract, assertBound);
  const owner = <T>(readOnly: boolean, action: Parameters<typeof telegramDatabase<T>>[3]) =>
    telegramDatabase(urls.owner, policy.database.owner, readOnly, action);
  const observePhase = async () => {
    assertBound();
    if (phase === "pause-intent") return owner(true, recoveryWork);
    if (phase === "migration") {
      const ledger = await owner(true, async (db) => {
        const count = Number(
          (await db.query("SELECT count(*) AS count FROM api_next.schema_migrations")).rows[0]
            .count,
        );
        requireTelegram(count === 333 || count === 334, "migration-prefix-count-refused");
        return assertTelegramLedger(db, count);
      });
      const privileges = await telegramDatabase(
        urls.runtime,
        policy.database.runtime,
        true,
        async (db) => {
          const rows = await telegramPrivileges(db);
          assertTelegramMatrix(rows, false, ledger.count === 333);
          return rows;
        },
      );
      const workers = [];
      for (const worker of ["http", "jobs"] as const) {
        const snapshot = await collectTelegramWorker(worker);
        const binding = snapshot.bindings.find((row) => row.name === "CONTROL_PLANE");
        requireTelegram(
          binding?.type === "hyperdrive" &&
            binding.id === policy.database.hyperdrive &&
            snapshot.version === policy.workers[worker].baseline &&
            snapshot.module_sha256 === policy.workers[worker].baselineModule,
          "serving-consumer-origin-or-baseline-changed",
        );
        workers.push({ worker, version: snapshot.version, hyperdrive: binding.id });
      }
      return { ledger, privileges, workers };
    }
    if (phase === "grants")
      return telegramDatabase(urls.runtime, policy.database.runtime, true, async (db) => ({
        privileges: await telegramPrivileges(db),
        functions: await assertTelegramFunctions(db),
        row_lock_authority: await telegramRowLocks(db, false),
      }));
    if (phase === "vault")
      return (await vault().list())
        .filter((r) => r.name === policy.vault.name)
        .map(({ name, version, operation }) => ({ name, version, operation }));
    if (phase === "catalogue")
      return owner(true, async (db) => ({
        corpus: await telegramCorpus(db),
        decisions: await telegramDecision(db),
      }));
    const snapshot = await collectTelegramWorker(phaseWorker(phase));
    if (resolving) {
      const resolution = review.resolutions[phase];
      requireTelegram(
        resolution?.worker_version === snapshot.version,
        "resolution-worker-version-differs",
      );
      if (phase.startsWith("recover-") && resolution.conclusion === "effect_verified")
        assertTelegramRecoveryVersion(
          snapshot,
          telegramJson<TelegramWorkerSnapshot>(review.recovery_targets[phaseWorker(phase)]),
          phaseWorker(phase),
        );
    }

    exclusiveRecord(policy.paths.operation, `observation-${phase}-${randomUUID()}.json`, snapshot);
    const practice = phase.startsWith("practice-")
      ? await owner(true, async (db) => {
          requireTelegram(review.channel_readiness, "production-channel-readiness-required");
          const accepted = catalogueAcceptance(review.catalogue_acceptance);
          const corpus = await telegramCorpus(db),
            decision = await telegramDecision(db);
          requireTelegram(
            decision.length === 1 &&
              decision[0].policy_revision === policy.canary.policy &&
              decision[0].review_evidence_sha256 === review.catalogue_acceptance.sha256 &&
              decision[0].effective === true &&
              corpus.corpus_sha256 === accepted.corpus_sha256,
            "current-accepted-canary-decision-required",
          );
          return telegramPracticeReadiness(db, review.channel_readiness, Date.now());
        })
      : undefined;
    return {
      worker: telegramWorkerState(snapshot),
      ...(phase.startsWith("recover-") ? { serving_version: snapshot.version } : {}),
      ...(practice ? { practice } : {}),
      ...(isRecovery(phase) ? await owner(true, recoveryWork) : {}),
    };
  };
  return {
    ...telegramJournal(),
    now: () => Date.now(),
    admit: async (access: TelegramAdmission["access"]) => {
      requireTelegram(access === admission.access, "access-mode-differs");
      assertBound();
    },
    observe: async () => {
      const origin_witness = await telegramServingOrigins();
      const global_inventory = await owner(true, (db) =>
        telegramGlobalInventory(db, review.integration_allowlist ?? []),
      );
      return { origin_witness, global_inventory, state: await observePhase() };
    },
    effect: async () => {
      await telegramServingOrigins();
      await owner(true, (db) => telegramGlobalInventory(db, review.integration_allowlist ?? []));
      assertBound();
      if (phase === "migration") return applyTelegramMigration(urls.owner, assertBound);
      if (phase === "grants") return applyTelegramGrants(urls.owner, assertBound);
      if (phase === "vault") {
        await createTelegramWrappingKey(vault(), assertBound);
        return;
      }
      if (phase === "catalogue") {
        catalogueAcceptance(review.catalogue_acceptance);
        return owner(false, (db) =>
          appendTelegramCanary(db, review.catalogue_acceptance, assertBound),
        );
      }
      if (phase === "pause-intent") {
        await owner(false, (db) =>
          pauseTelegramStudyIntent(
            db,
            (before) =>
              exclusiveRecord(policy.paths.operation, "pause-intent-database-attempt.json", {
                before,
              }),
            assertBound,
          ),
        );
        return;
      }
      if (phase.startsWith("recover-")) {
        await owner(true, async (db) => {
          const state = await recoveryWork(db);
          requireTelegram(
            state.integration.every((row) => row.study_enabled === false) &&
              state.active.length === 0,
            "recovery-inflight-or-uncertain-work-requires-read-only-reconciliation",
          );
        });
        return restoreDisabled(
          phaseWorker(phase),
          review.recovery_targets[phaseWorker(phase)],
          review,
          assertBound,
        );
      }
      const configuration = review.configs[phase];
      requireTelegram(configuration, "reviewed-phase-config-required");
      await uploadTelegramWorker(
        phaseWorker(phase),
        phase,
        review,
        configuration,
        await vault().bindings(phaseWorker(phase)),
        assertBound,
      );
    },
  };
}
export async function telegramProductionRelease(args: readonly string[]) {
  const { mode, options } = argumentsFor(args);
  if (mode === "dependency-preview") return telegramDependencyInventory();
  if (mode === "preview")
    return {
      kind: "telegram-production-practice-preview-v1",
      filesystem_only: true,
      application: qualifiedTelegramApplication(),
      phases: TELEGRAM_PHASES,
      operational_ready: false,
      configurations: Object.fromEntries(
        ["http", "jobs"].map((worker) => [
          worker,
          Object.keys(TELEGRAM_PHASES)
            .filter((phase) => phase.endsWith(worker) && !phase.startsWith("recover-"))
            .map((phase) => ({
              phase,
              configuration: telegramPhaseConfig(
                worker as TelegramWorker,
                phase as TelegramPhase,
                readFileSync(
                  resolve(
                    policy.paths.application,
                    policy.workers[worker as TelegramWorker].config,
                  ),
                  "utf8",
                ),
              ),
            })),
        ]),
      ),
    };
  if (mode === "initialize") {
    const request = telegramJson<{
      kind: string;
      accepted: boolean;
      reviewer_role: string;
      operation: string;
      tooling_source: string;
    }>({ path: options["--request"] ?? "", sha256: options["--request-sha"] ?? "" });
    requireTelegram(
      Object.keys(options).length === 2 &&
        request.kind === "telegram-operation-evidence-initialization-v1" &&
        request.accepted === true &&
        request.reviewer_role === "independent_reviewer" &&
        request.operation === policy.operation &&
        !existsSync(policy.paths.operation),
      "new-reviewed-operation-directory-required",
    );
    mkdirSync(policy.paths.operation, { mode: 0o700 });
    mkdirSync(journal, { mode: 0o700 });
    const identity = {
      operation: directoryIdentity(policy.paths.operation),
      journal: directoryIdentity(journal),
    };
    exclusiveRecord(policy.paths.operation, "genesis.json", {
      ...identity,
      request_sha256: options["--request-sha"],
      tooling_source: request.tooling_source,
    });
    return identity;
  }
  if (mode === "probe" || mode === "probe-child") {
    const tools = publicPostExecutionTools(),
      hash = sha256("telegram-zero-provider-database-probe-v1");
    if (mode === "probe-child") {
      (await boundChild("probe", hash, hash, tools))();
      return { bounded: true, provider_calls: 0, database_calls: 0 };
    }
    if (!existsSync(policy.paths.processQualification))
      mkdirSync(policy.paths.processQualification, { recursive: true, mode: 0o700 });
    return superviseProductionTimeout({
      journalDirectory: policy.paths.processQualification,
      wrapperPath: self,
      wrapperArguments: ["probe"],
      argv: [process.execPath, self, "probe-child"],
      mode: "probe",
      executorSha256: fileHash(self),
      admissionSha256: hash,
      reviewSha256: hash,
      executionTools: tools,
    });
  }
  requireTelegram(Object.keys(options).length === 5, "exact-five-live-options-required");
  const phase = options["--phase"] as TelegramPhase;
  requireTelegram(Object.hasOwn(TELEGRAM_PHASES, phase), "unknown-fixed-phase");
  const reviewSha = options["--review-sha"] ?? "",
    admissionSha = options["--admission-sha"] ?? "";
  const review = telegramJson<TelegramReview>({
    path: options["--review"] ?? "",
    sha256: reviewSha,
  });
  const admission = telegramJson<TelegramAdmission>({
    path: options["--admission"] ?? "",
    sha256: admissionSha,
  });
  const access = mode.startsWith("observe") || mode.startsWith("resolve") ? "observe" : "effect";
  admitTelegram(review, reviewSha, admission, phase, access, Date.now());
  requireTelegram(
    digest(directoryIdentity(journal)) === digest(review.journal_identity),
    "journal-directory-identity-changed",
  );
  if (!mode.endsWith("-child"))
    return superviseProductionTimeout({
      journalDirectory: journal,
      wrapperPath: self,
      wrapperArguments: [...args],
      argv: [process.execPath, self, `${mode}-child`, ...args.slice(1)],
      mode: `${access}:${phase}`,
      executorSha256: fileHash(self),
      admissionSha256: admissionSha,
      reviewSha256: reviewSha,
      executionTools: review.execution_tools,
    });
  const bound = await boundChild(
    `${access}:${phase}`,
    reviewSha,
    admissionSha,
    review.execution_tools,
  );
  if (mode.startsWith("resolve"))
    return resolveTelegramPhase(
      phase,
      review,
      reviewSha,
      admissionSha,
      await liveIo(phase, review, reviewSha, admission, bound, true),
    );
  return telegramPhase(
    phase,
    review,
    reviewSha,
    admissionSha,
    access,
    await liveIo(phase, review, reviewSha, admission, bound),
  );
}
if (import.meta.main)
  telegramProductionRelease(process.argv.slice(2))
    .then((value) => console.log(JSON.stringify(value)))
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({
          success: false,
          reason:
            error instanceof TelegramReleaseRefused
              ? error.message
              : "Telegram operation refused or unresolved; preserve evidence and reconcile read-only",
        }),
      );
      process.exitCode = 1;
    });
