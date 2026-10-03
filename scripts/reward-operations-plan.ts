import { resolve } from "node:path";
import { Schema } from "effect";
import { RewardDatabaseTargetSchema } from "./reward-operations-database-target.ts";
import { RewardOperationsRefusal } from "./reward-operations-report.ts";
import {
  compareRewardWorkerDescriptor,
  decodeRewardWorkerDescriptor,
  RewardWorkerDescriptorSchema,
} from "./reward-operations-worker-policy.ts";

const Reference = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u));
const Instant = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u));
const WorkerName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,62}$/u));
const WorkerPlan = Schema.Struct({
  name: WorkerName,
  hyperdriveId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u)),
  route: Schema.Literals(["settings-patch", "existing-version"]),
  baseline: RewardWorkerDescriptorSchema,
  candidate: Schema.optional(RewardWorkerDescriptorSchema),
  deploymentAuthority: Schema.optional(Reference),
});
const Plan = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  operationId: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,79}$/u)),
  authorizationReference: Reference,
  enableAuthority: Schema.optional(Reference),
  environment: Schema.Literals(["staging", "production"]),
  accountId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u)),
  target: Schema.Literals(["true", "false"]),
  expectedRevision: Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]*)$/u)),
  expiresAt: Instant,
  exclusionReference: Reference,
  journalNamespace: Schema.String.check(Schema.isPattern(/^\/[ -~]+$/u)),
  databaseTarget: RewardDatabaseTargetSchema,
  workers: Schema.Struct({ http: WorkerPlan, jobs: WorkerPlan }),
});
export type RewardOperationsPlan = typeof Plan.Type;

export function decodeRewardOperationsPlan(value: unknown): RewardOperationsPlan {
  try {
    const plan = Schema.decodeUnknownSync(Plan, { onExcessProperty: "error" })(value);
    if (
      !Number.isFinite(Date.parse(plan.expiresAt)) ||
      resolve(plan.journalNamespace) !== plan.journalNamespace ||
      (plan.target === "true" && !plan.enableAuthority)
    )
      throw new RewardOperationsRefusal("invalid-plan");
    for (const worker of Object.values(plan.workers)) {
      decodeRewardWorkerDescriptor(worker.baseline);
      if (worker.route === "existing-version") {
        if (!worker.candidate || !worker.deploymentAuthority)
          throw new RewardOperationsRefusal("invalid-plan");
        decodeRewardWorkerDescriptor(worker.candidate);
        compareRewardWorkerDescriptor(worker.baseline, worker.candidate, plan.target, false);
      } else if (worker.candidate) throw new RewardOperationsRefusal("invalid-plan");
    }
    return plan;
  } catch {
    throw new RewardOperationsRefusal("invalid-plan");
  }
}

const Lease = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  reference: Reference,
  operationId: Reference,
  accountId: Schema.String,
  http: WorkerName,
  jobs: WorkerName,
  active: Schema.Boolean,
  startsAt: Instant,
  expiresAt: Instant,
});

export function assertRewardResourceExclusion(
  value: unknown,
  plan: RewardOperationsPlan,
  now: number,
) {
  try {
    const lease = Schema.decodeUnknownSync(Lease, { onExcessProperty: "error" })(value);
    if (
      !lease.active ||
      lease.reference !== plan.exclusionReference ||
      lease.operationId !== plan.operationId ||
      lease.accountId !== plan.accountId ||
      lease.http !== plan.workers.http.name ||
      lease.jobs !== plan.workers.jobs.name ||
      !(Date.parse(lease.startsAt) <= now && now < Date.parse(lease.expiresAt)) ||
      Date.parse(lease.expiresAt) < Date.parse(plan.expiresAt)
    )
      throw new RewardOperationsRefusal("exclusion");
  } catch {
    throw new RewardOperationsRefusal("exclusion");
  }
}

export function assertRewardPlanTime(plan: RewardOperationsPlan, now: number) {
  if (now >= Date.parse(plan.expiresAt)) throw new RewardOperationsRefusal("deadline");
}
