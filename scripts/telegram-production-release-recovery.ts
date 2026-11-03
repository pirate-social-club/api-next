import { readdirSync } from "node:fs";
import type pg from "pg";
import { exclusiveRecord } from "./production-release/production-operation-evidence.ts";
import {
  type TelegramFile,
  type TelegramReview,
  telegramFile,
  telegramJson,
} from "./telegram-production-release-admission.ts";
import {
  TELEGRAM_RELEASE as policy,
  requireTelegram,
  type TelegramWorker,
  type TelegramWorkerMetadata,
  type TelegramWorkerSnapshot,
  telegramWorkerMetadataState,
} from "./telegram-production-release-policy.ts";
import {
  assertTelegramDisabledTarget,
  collectTelegramWorkerMetadata,
  rollbackTelegramWorker,
} from "./telegram-production-release-workers.ts";
import { digest } from "./worker-binding-drift.ts";

const tables = [
  "community_telegram_integrations",
  "community_telegram_setups",
  "community_telegram_inbox",
  "community_telegram_deliveries",
  "community_telegram_usage",
  "telegram_account_associations",
  "telegram_link_transactions",
  "telegram_link_navigation",
  "telegram_bot_grants",
  "telegram_study_conversations",
  "telegram_interface_preferences",
  "telegram_restricted_learners",
  "telegram_restricted_study_personas",
  "telegram_restricted_bot_affirmations",
] as const;
export const TELEGRAM_PRECONNECT_COUNTS_SQL = [
  ...tables.map(
    (table) => `SELECT '${table}' AS kind,count(*)::text AS rows FROM api_next.${table}`,
  ),
  "SELECT 'telegram_practice_sessions' AS kind,count(*)::text AS rows FROM api_next.study_sessions_v2 WHERE telegram_practice_only",
].join(" UNION ALL ");
export async function telegramPreconnectWork(db: pg.Client) {
  return (await db.query(TELEGRAM_PRECONNECT_COUNTS_SQL)).rows;
}
export function assertTelegramPreconnectWork(rows: readonly Record<string, unknown>[]) {
  const names = [...tables, "telegram_practice_sessions"];
  requireTelegram(
    rows.length === names.length &&
      names.every((name) => {
        const matching = rows.filter((row) => row.kind === name);
        return matching.length === 1 && matching[0]?.rows === "0";
      }),
    "baseline-recovery-requires-zero-global-telegram-history",
  );
}
/** Even an unverified or resolved-not-applied connect attempt excludes this route. */
export function assertTelegramPreconnectHistory(
  review: TelegramReview,
  directory: string = policy.paths.operation,
) {
  const names = readdirSync(directory);
  requireTelegram(
    !names.some((name) => /^(?:connect-http|connect-jobs)-/u.test(name)) &&
      !review.resolutions["connect-http"] &&
      !review.resolutions["connect-jobs"],
    "baseline-recovery-forbidden-after-any-connect-attempt",
  );
}
function disabled(snapshot: TelegramWorkerMetadata) {
  const binding = snapshot.bindings.find((row) => row.name === "TELEGRAM_CONFIG_JSON");
  requireTelegram(binding?.type === "plain_text", "baseline-recovery-mode-required");
  const value = JSON.parse(String(binding.text)) as Record<string, unknown>;
  requireTelegram(
    value?.enabled === false &&
      value.linking_enabled === false &&
      value.practice_enabled === false &&
      !value.community_practice_enabled,
    "baseline-recovery-requires-both-workers-disabled",
  );
}
export function assertTelegramBaselineTarget(
  target: TelegramWorkerSnapshot,
  worker: TelegramWorker,
) {
  const fixed = policy.workers[worker];
  requireTelegram(
    target.version === fixed.baseline &&
      target.message === `git:${fixed.source}` &&
      target.module_sha256 === fixed.baselineModule,
    "exact-preincrement-worker-pair-required",
  );
  disabled(target);
}
/** Actual version/deployment/latest stay exact; unrelated bindings and resources cannot move. */
export function assertTelegramBaselineCurrent(
  current: TelegramWorkerMetadata,
  expected: TelegramWorkerSnapshot,
  target: TelegramWorkerSnapshot,
  worker: TelegramWorker,
) {
  assertTelegramBaselineTarget(target, worker);
  const fixed = policy.workers[worker];
  const original =
    expected.version === fixed.baseline &&
    expected.message === `git:${fixed.source}` &&
    expected.module_sha256 === fixed.baselineModule;
  const candidate =
    expected.message === `git:${policy.source}` && expected.module_sha256 === fixed.module;
  requireTelegram(
    (original || candidate) &&
      current.version === expected.version &&
      current.deployment === expected.deployment &&
      current.latest === expected.latest &&
      digest(telegramWorkerMetadataState(current)) ===
        digest(telegramWorkerMetadataState(expected)),
    "baseline-recovery-current-worker-drift",
  );
  disabled(current);
  const permitted = new Set([
    "TELEGRAM_CONFIG_JSON",
    policy.vault.name,
    ...(worker === "jobs" ? [policy.vault.transcription] : []),
  ]);
  const state = (snapshot: TelegramWorkerMetadata) => ({
    ...telegramWorkerMetadataState(snapshot, true),
    message: undefined,
    bindings_sha256: digest(snapshot.bindings.filter((row) => !permitted.has(row.name))),
  });
  requireTelegram(
    digest(state(current)) === digest(state(target)),
    "baseline-recovery-unrelated-resource-drift",
  );
}
export function assertTelegramBaselineVersion(
  observed: TelegramWorkerMetadata,
  target: TelegramWorkerSnapshot,
  worker: TelegramWorker,
) {
  assertTelegramBaselineTarget(target, worker);
  requireTelegram(
    observed.version === target.version &&
      digest(telegramWorkerMetadataState(observed, true)) ===
        digest(telegramWorkerMetadataState(target, true)),
    "exact-baseline-recovery-version-not-serving",
  );
}
interface Compatibility {
  readonly kind: "telegram-preconnect-baseline-compatibility-v1";
  readonly accepted: true;
  readonly reviewer_role: "independent_reviewer";
  readonly findings: readonly never[];
  readonly candidate_source: string;
  readonly http_source: string;
  readonly jobs_source: string;
  readonly migration_sha256: string;
  readonly grants_sha256: string;
  readonly preconnect_only: true;
  readonly additive_schema_and_grants: true;
  readonly ordinary_website_compatible: true;
  readonly immutable_history_preserved: true;
  readonly evidence: readonly TelegramFile[];
}
function compatibility(review: TelegramReview) {
  requireTelegram(review.baseline_compatibility, "baseline-compatibility-review-required");
  const value = telegramJson<Compatibility>(review.baseline_compatibility);
  requireTelegram(
    value.kind === "telegram-preconnect-baseline-compatibility-v1" &&
      value.accepted === true &&
      value.reviewer_role === "independent_reviewer" &&
      value.findings.length === 0 &&
      value.candidate_source === policy.source &&
      value.http_source === policy.workers.http.source &&
      value.jobs_source === policy.workers.jobs.source &&
      value.migration_sha256 === policy.database.migrationSha256 &&
      value.grants_sha256 === "5c5b7f7f24a16654a1aea9360083f0499597f93c23d7242cb057bd0f4bd5957f" &&
      value.preconnect_only === true &&
      value.additive_schema_and_grants === true &&
      value.ordinary_website_compatible === true &&
      value.immutable_history_preserved === true &&
      value.evidence.length > 0,
    "exact-preconnect-baseline-compatibility-required",
  );
  for (const file of value.evidence) telegramFile(file);
}
/** Baseline recovery ends at connect. Accept ordinary service before crossing that boundary. */
export function assertTelegramOrdinaryService(review: TelegramReview) {
  requireTelegram(
    review.ordinary_service_acceptance,
    "ordinary-service-acceptance-required-before-connect",
  );
  const value = telegramJson<{
    kind: string;
    accepted: boolean;
    reviewer_role: string;
    findings: readonly unknown[];
    operation: string;
    api_source: string;
    http_module_sha256: string;
    jobs_module_sha256: string;
    website_source: string;
    website_artifact: string;
    disabled_backend_verified: boolean;
    website_deployed_verified: boolean;
    ordinary_flows_verified: boolean;
    evidence: readonly TelegramFile[];
  }>(review.ordinary_service_acceptance);
  requireTelegram(
    value.kind === "telegram-disabled-ordinary-service-acceptance-v1" &&
      value.accepted === true &&
      value.reviewer_role === "independent_reviewer" &&
      value.findings.length === 0 &&
      value.operation === policy.operation &&
      value.api_source === policy.source &&
      value.http_module_sha256 === policy.workers.http.module &&
      value.jobs_module_sha256 === policy.workers.jobs.module &&
      value.website_source === "78ab15f93ff7e12cdd88277c2b9fa22a186323a2" &&
      value.website_artifact ===
        "cd6a0045f711a3f3cea18c6fea33cf98e3d6134f4cf4efc740b897befb2cca85" &&
      value.disabled_backend_verified === true &&
      value.website_deployed_verified === true &&
      value.ordinary_flows_verified === true &&
      value.evidence.length >= 3,
    "exact-disabled-ordinary-service-acceptance-required",
  );
  for (const file of value.evidence) telegramFile(file);
}
export interface TelegramBaselineRecoveryIo {
  observe(worker: TelegramWorker): Promise<TelegramWorkerMetadata>;
  work(): Promise<readonly Record<string, unknown>[]>;
  assertBound(): void;
  attempt(value: unknown): void;
  /** Existing managed rollback invokes the boundary after all awaited guard preflights. */
  rollback(version: string, boundary: () => Promise<void>): Promise<{ readonly exitCode: number }>;
}
export async function restoreTelegramBaseline(
  worker: TelegramWorker,
  review: TelegramReview,
  io: TelegramBaselineRecoveryIo,
  directory: string = policy.paths.operation,
) {
  const targets = () => {
    compatibility(review);
    requireTelegram(
      review.baseline_recovery_targets && review.serving_workers,
      "reviewed-baseline-targets-and-current-pair-required",
    );
    return Object.fromEntries(
      (["http", "jobs"] as const).map((name) => [
        name,
        {
          target: telegramJson<TelegramWorkerSnapshot>(
            review.baseline_recovery_targets?.[name] as TelegramFile,
          ),
          current: telegramJson<TelegramWorkerSnapshot>(
            review.serving_workers?.[name] as TelegramFile,
          ),
        },
      ]),
    ) as Record<
      TelegramWorker,
      { target: TelegramWorkerSnapshot; current: TelegramWorkerSnapshot }
    >;
  };
  const check = async () => {
    io.assertBound();
    assertTelegramPreconnectHistory(review, directory);
    const pair = targets();
    const observations = {} as Record<TelegramWorker, TelegramWorkerMetadata>;
    for (const name of ["http", "jobs"] as const) {
      observations[name] = await io.observe(name);
      assertTelegramBaselineCurrent(
        observations[name],
        pair[name].current,
        pair[name].target,
        name,
      );
    }
    assertTelegramPreconnectWork(await io.work());
    assertTelegramPreconnectHistory(review, directory);
    io.assertBound();
    return { current: observations[worker], target: pair[worker].target };
  };
  const before = await check();
  if (before.current.version === before.target.version) {
    assertTelegramBaselineVersion(before.current, before.target, worker);
    return;
  }
  let boundaries = 0;
  const result = await io.rollback(before.target.version, async () => {
    requireTelegram(boundaries++ === 0, "baseline-traffic-boundary-already-attempted");
    const fresh = await check();
    requireTelegram(
      fresh.current.version === before.current.version &&
        fresh.current.latest === before.current.latest,
      "baseline-state-moved-at-traffic-boundary",
    );
    io.assertBound();
    io.attempt({
      target_version: before.target.version,
      current_version: before.current.version,
      current_latest: before.current.latest,
      target_sha256: review.baseline_recovery_targets?.[worker].sha256,
    });
    io.assertBound();
  });
  requireTelegram(
    boundaries === 1 && result.exitCode === 0,
    "baseline-traffic-acknowledgement-unresolved",
  );
  const after = await io.observe(worker);
  requireTelegram(after.latest === before.current.latest, "baseline-recovery-latest-upload-moved");
  assertTelegramBaselineVersion(after, before.target, worker);
}

export async function restoreTelegramDisabled(
  worker: TelegramWorker,
  reference: TelegramFile,
  review: TelegramReview,
  assertBound: () => void,
) {
  const target = telegramJson<TelegramWorkerSnapshot>(reference);
  assertTelegramDisabledTarget(target, worker);
  // Both pause phases must already be verified. Candidate acceptance is not required for this recovery.
  const current = await collectTelegramWorkerMetadata(worker);
  for (const snapshot of [
    await collectTelegramWorkerMetadata("http"),
    await collectTelegramWorkerMetadata("jobs"),
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
  const after = await collectTelegramWorkerMetadata(worker);
  requireTelegram(
    after.version === target.version &&
      after.latest === current.latest &&
      digest(telegramWorkerMetadataState(after, true)) ===
        digest(telegramWorkerMetadataState(target, true)),
    "recovery-serving-state-unverified",
  );
}
