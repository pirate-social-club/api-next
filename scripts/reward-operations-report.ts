import { Predicate } from "effect";

export type RewardStage =
  | "plan"
  | "authentication"
  | "worker-precheck"
  | "exclusion"
  | "journal"
  | "mutation"
  | "polling"
  | "readback"
  | "inspection"
  | "complete"
  | "guard-begin"
  | "guard-configure"
  | "guard-control"
  | "guard-inventory"
  | "guard-operation"
  | "guard-rollback"
  | "database-connect"
  | "database-target"
  | "database-end";
export type RewardReason =
  | "invalid-plan"
  | "deadline"
  | "authentication"
  | "expiry"
  | "identity-drift"
  | "split-deployment"
  | "latest-mismatch"
  | "revision"
  | "persisted-pause"
  | "inventory"
  | "guard-lost"
  | "exclusion"
  | "journal-used"
  | "journal-unavailable"
  | "provider"
  | "transport"
  | "readback"
  | "database-target"
  | "unknown";

export class RewardOperationsRefusal extends Error {
  constructor(
    readonly reason: RewardReason,
    readonly status?: number,
  ) {
    super(`Reward operator refusal: ${reason}`);
  }
}

export function sanitizeRewardOperationsFailure(error: unknown) {
  const result: { reason: RewardReason; status?: number; sqlstate?: string; transport?: string } = {
    reason: error instanceof RewardOperationsRefusal ? error.reason : "unknown",
  };
  if (!Predicate.isObject(error)) return result;
  const status: unknown = Reflect.get(error, "status");
  if (Number.isInteger(status) && Number(status) >= 100 && Number(status) <= 599)
    result.status = Number(status);
  const code: unknown = Reflect.get(error, "code");
  if (
    Predicate.isString(code) &&
    /^(?:08[0-9A-Z]{3}|25P02|40P01|55P03|57014|42501|42P01|42703|PR001|PR002)$/u.test(code)
  )
    result.sqlstate = code;
  if (
    Predicate.isString(code) &&
    ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "ENOTFOUND"].includes(code)
  ) {
    result.transport = code;
    result.reason = "transport";
  }
  return result;
}

export type RewardPublicState = {
  version: string;
  flag: "true" | "false";
  descriptorSha256: string;
};

export function createRewardOperationsReport(operationId: string) {
  const report = {
    schemaVersion: 1,
    operationId,
    ok: false,
    stage: "plan" as RewardStage,
    mutation: "none" as "none" | "attempted" | "verified" | "uncertain",
    failure: undefined as ReturnType<typeof sanitizeRewardOperationsFailure> | undefined,
    cleanupFailures: [] as {
      stage: RewardStage;
      failure: ReturnType<typeof sanitizeRewardOperationsFailure>;
    }[],
    workers: {} as Partial<
      Record<
        "http" | "jobs",
        { current: RewardPublicState | null; lastConfirmed: RewardPublicState | null }
      >
    >,
    blockers: [] as string[],
    control: undefined as
      | {
          state: "running" | "settling" | "paused";
          paused: boolean;
          revision: string;
          admitted: readonly { effect_kind: string; state: string; effects: string }[];
        }
      | undefined,
  };
  return {
    report,
    enter(stage: RewardStage) {
      if (!report.failure) report.stage = stage;
    },
    fail(error: unknown) {
      report.failure ??= sanitizeRewardOperationsFailure(error);
      report.ok = false;
    },
    cleanup(stage: RewardStage, error: unknown) {
      report.cleanupFailures.push({ stage, failure: sanitizeRewardOperationsFailure(error) });
      report.ok = false;
    },
    state(worker: "http" | "jobs", current: RewardPublicState | null) {
      const lastConfirmed = current ?? report.workers[worker]?.lastConfirmed ?? null;
      report.workers[worker] = { current, lastConfirmed };
    },
  };
}

/** Only reviewed readiness categories may leave the canonical preflight boundary. */
export function printableRewardReadiness(blockers: readonly string[]) {
  const allowed = new Set([
    "unpaid_credits",
    "leg_liabilities",
    "sponsor_liabilities",
    "open_offers",
    "open_legs",
    "unresolved_drawings",
    "unresolved_funding",
    "unresolved_chain_effects",
    "unresolved_gas_topups",
  ]);
  return [...new Set(blockers.filter((item) => allowed.has(item)))].sort();
}
