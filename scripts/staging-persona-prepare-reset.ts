import type { Client } from "pg";
import {
  compileApprovedStagingPrivileges,
  verifyStagingRuntimeIdentity,
} from "./staging-persona-approved-privileges.ts";
import {
  readResetGrantCatalog,
  revokeResetCatalogGrant,
  verifyResetForbiddenGrants,
} from "./staging-persona-grant-catalog.ts";
import type { ResetGrant } from "./staging-persona-grant-reconciliation.ts";
import { observeStagingProviderBackup } from "./staging-persona-provider-backup.ts";
import {
  allowlistedReason,
  StructuredRefusal,
  structuredFailureCategory,
  structuredSqlState,
} from "./staging-persona-rehearsal-failure";
import {
  fingerprintRehearsalData,
  withProviderRehearsalOperator,
} from "./staging-persona-rehearsal-inventory.ts";
import {
  assertRestoredFromApprovedBackup,
  rehearsalTarget,
} from "./staging-persona-rehearsal-target.ts";
import { verifyResetRuntimeDenied } from "./staging-persona-reset-denied-grants.ts";

/** Preparation that must complete before reconstruction admission.
 *
 * The 2026-09-09 r8 exercise established this ordering the hard way. The
 * restored branch carried three forbidden `schema_migrations` writes on the
 * runtime role, `verifyApprovedStagingRuntime` refused at admission with
 * `reset_forbidden_privilege_effective`, and the run never reached the grant
 * reconciliation that would have removed them. Reconciliation after
 * reconstruction cannot satisfy a gate that already refused, so removal and
 * verification belong here, before admission, and the admission gate stays
 * exactly as strict as it was.
 */
export type PreparationCheck = "runtime_identity" | "operator_visibility" | "forbidden_privileges";

export type PreparationFinding = {
  readonly check: PreparationCheck;
  readonly satisfied: boolean;
  /** Counts and role names only; never a grant's object identity. */
  readonly detail: string | null;
};

export type PreparationReport = {
  readonly ready: boolean;
  readonly findings: readonly PreparationFinding[];
  readonly forbiddenPresent: readonly ResetGrant[];
  /** Every catalog grant reachable by the runtime or PUBLIC. These grants are
   * the database fence that must be removed before reconstruction, including
   * reviewed grants which are restored only after the paired release. */
  readonly runtimePresent: readonly ResetGrant[];
};

/** What is forbidden is a privilege on an object, not a privilege held by one
 * named role. The compiled policy names the runtime role because that is who it
 * was compiled for, so keying on the grantee would only ever match that exact
 * role — and the grants that matter most, PUBLIC and those inherited through a
 * role the runtime can become, would silently fail to match while the report
 * said ready. The grantee decides reachability; the object and privilege decide
 * what is forbidden. */
const forbiddenKey = (grant: ResetGrant) =>
  [grant.objectKind, grant.objectIdentity, grant.privilege].join(" ");

/** The decision, separated from the reads so it can be exercised without a
 * database. Effective denial includes PUBLIC and every role the runtime can
 * become, so a grant to any of those names counts as present. */
export function classifyResetPreparation(input: {
  readonly catalog: readonly ResetGrant[];
  readonly forbidden: readonly ResetGrant[];
  readonly runtimeNames: readonly string[];
  readonly operatorVisibility: boolean;
  readonly runtimeIdentityProven: boolean;
}): PreparationReport {
  // Fail closed on a value that is not a string array even though the type says
  // it is. A single string spreads into characters, silently matching no
  // grantee and reporting a clean preparation (rehearsal r9, 2026-09-13).
  if (
    !Array.isArray(input.runtimeNames) ||
    input.runtimeNames.some((name) => typeof name !== "string")
  )
    throw new Error("reset_runtime_identity_unproven");
  const reachable = new Set([...input.runtimeNames, "PUBLIC"]);
  const forbidden = new Set(input.forbidden.map(forbiddenKey));
  const runtimePresent = input.catalog.filter(
    (grant) => reachable.has(grant.grantee) && grant.objectKind !== "type",
  );
  const present = runtimePresent.filter((grant) => forbidden.has(forbiddenKey(grant)));
  const findings: PreparationFinding[] = [
    {
      check: "runtime_identity",
      satisfied: input.runtimeIdentityProven,
      detail: input.runtimeIdentityProven ? null : "runtime role identity unproven",
    },
    {
      check: "operator_visibility",
      satisfied: input.operatorVisibility,
      detail: input.operatorVisibility
        ? null
        : "operator lacks pg_read_all_stats; the drain check will refuse",
    },
    {
      check: "forbidden_privileges",
      satisfied: present.length === 0,
      detail: present.length === 0 ? null : `${present.length} forbidden grant(s) effective`,
    },
  ];
  return Object.freeze({
    ready: findings.every((finding) => finding.satisfied),
    findings: Object.freeze(findings),
    forbiddenPresent: Object.freeze(present),
    runtimePresent: Object.freeze(runtimePresent),
  });
}

const VISIBILITY_SQL =
  "SELECT (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user)" +
  " OR pg_catalog.pg_has_role(current_user,'pg_read_all_stats','USAGE') AS visible";

/** Read-only inspection. Reports what preparation still owes; changes nothing. */
export type PreparationStage =
  | "setup"
  | "identity"
  | "compile"
  | "catalog"
  | "visibility"
  | "classify"
  | "denial"
  | "reset";

export async function inspectResetPreparation(
  admin: Pick<Client, "query">,
  runtimeRole: string,
  repositoryRoot?: string,
  onStage?: (stage: PreparationStage) => void,
): Promise<PreparationReport> {
  onStage?.("identity");
  const names = await verifyStagingRuntimeIdentity(admin, runtimeRole);
  onStage?.("compile");
  const approved = await compileApprovedStagingPrivileges(admin, runtimeRole, repositoryRoot);
  onStage?.("catalog");
  const catalog = await readResetGrantCatalog(admin);
  onStage?.("visibility");
  const visibility = (await admin.query(VISIBILITY_SQL)).rows[0]?.visible;
  onStage?.("classify");
  return classifyResetPreparation({
    catalog: catalog.grants,
    forbidden: approved.policy.forbidden ?? [],
    runtimeNames: names,
    operatorVisibility: visibility === true,
    runtimeIdentityProven: true,
  });
}

/** Everything that must hold before a revocation is issued. Destination is one
 * of them, not all of them: the rehearsal boundary proves which branch the
 * connection reaches, and says nothing about whether this run was authorized to
 * mutate, whether the branch came from the approved backup, whether its data is
 * the data that was approved, or whether the operator can prove a drain
 * afterwards. Removal is itself a mutation and waits for all of them. */
export type RemovalPrerequisites = {
  readonly executionAuthorized: boolean;
  readonly backupLinked: boolean;
  readonly dataDigestMatches: boolean;
  readonly operatorVisibility: boolean;
};

export function assertRemovalPrerequisites(prerequisites: RemovalPrerequisites) {
  // Authorization first: an unauthorized run must refuse before it reads
  // anything about the target, so a dry run cannot reach a revocation by any
  // path, including one where every other prerequisite happens to hold.
  if (!prerequisites.executionAuthorized)
    throw new Error("reset_removal_refused:execution_unauthorized");
  if (!prerequisites.backupLinked) throw new Error("reset_removal_refused:backup_unlinked");
  if (!prerequisites.dataDigestMatches)
    throw new Error("reset_removal_refused:data_digest_mismatch");
  if (!prerequisites.operatorVisibility)
    throw new Error("reset_removal_refused:operator_visibility");
}

/** The orchestration, with its effects injected so the ordering can be proven
 * rather than asserted: prerequisites, policy inspection, every
 * runtime-reachable grant revoked, then complete effective-denial
 * verification. A refusal happens before the first revocation. */
export async function performForbiddenGrantRemoval(input: {
  readonly prerequisites: RemovalPrerequisites;
  readonly inspect: () => Promise<PreparationReport>;
  readonly revoke: (grant: ResetGrant) => Promise<void>;
  readonly verifyDenied: () => Promise<void>;
}) {
  assertRemovalPrerequisites(input.prerequisites);
  const report = await input.inspect();
  for (const grant of report.runtimePresent) await input.revoke(grant);
  // Effective denial, not catalog absence. Direct grants and PUBLIC are not
  // exhaustive: authority inherited through a role the runtime can become
  // survives the revocations above, so the catalog count is never the proof.
  await input.verifyDenied();
  return { revoked: report.runtimePresent.length };
}

/** Removes every grant reachable by the runtime or PUBLIC, then proves full
 * effective denial. The forbidden policy remains the preparation readiness
 * gate; reviewed access is deliberately removed for the reset and restored
 * later from the independent reviewed manifest.
 *
 * The connection is acquired here rather than accepted. Comparing two target
 * values supplied by the caller proves only that the caller is self-consistent:
 * matching rehearsal identifiers could arrive alongside a connection to live
 * staging, and the revocations would land there.
 * `withProviderRehearsalOperator` verifies the branch against the provider —
 * database, branch identity, ready state, restore source and access binding —
 * before it yields a client, so a mutation reaches the verified rehearsal
 * branch or nothing at all. The remaining prerequisites are checked here
 * because that wrapper does not establish them. */
export async function removeForbiddenResetGrants(input: {
  readonly executionAuthorized: boolean;
  readonly repositoryRoot?: string;
}) {
  // Refuse before opening a connection at all when the run is not authorized.
  // Authorization is the one prerequisite that cannot be observed: it is a
  // decision, so it is the only one the caller supplies.
  if (!input.executionAuthorized) throw new Error("reset_removal_refused:execution_unauthorized");
  const bound = rehearsalTarget();
  return withProviderRehearsalOperator(async (admin, _operator, runtimeRole) => {
    // Every remaining prerequisite is observed here, on the same connection
    // that will carry the revocations, and against the same bound target the
    // rehearsal boundary just verified this connection reaches. A caller
    // passing `backupLinked: true` would assert a fact rather than establish
    // one, and nothing would tie that assertion to this branch.
    const backup = await observeStagingProviderBackup(bound.backupId);
    let backupLinked = true;
    try {
      assertRestoredFromApprovedBackup(bound, backup);
    } catch {
      backupLinked = false;
    }
    const data = await fingerprintRehearsalData(admin);
    const report = await inspectResetPreparation(admin, runtimeRole, input.repositoryRoot);
    const visibility = report.findings.find((finding) => finding.check === "operator_visibility");
    return performForbiddenGrantRemoval({
      prerequisites: {
        executionAuthorized: input.executionAuthorized,
        backupLinked,
        dataDigestMatches: data.sha256 === bound.dataDigest,
        operatorVisibility: visibility?.satisfied === true,
      },
      inspect: async () => report,
      revoke: (grant) => revokeResetCatalogGrant(admin, grant),
      verifyDenied: () => verifyResetRuntimeDenied(admin, runtimeRole),
    });
  });
}

/** The authoritative check, and the only one a gate should trust. */
export async function assertForbiddenPrivilegesDenied(
  admin: Pick<Client, "query">,
  runtimeRole: string,
  repositoryRoot?: string,
) {
  const approved = await compileApprovedStagingPrivileges(admin, runtimeRole, repositoryRoot);
  await verifyResetForbiddenGrants(admin, approved.policy.forbidden ?? []);
}

const GATE_STATEMENT_TIMEOUT = "60s";
const GATE_DEADLINE_MS = 240_000;
/** Explicit termination budget for joining owned operations after a failure.
 * It is separate from the gate deadline on purpose: an expired deadline is
 * exactly when the join must still be allowed to observe settlement rather
 * than inheriting a near-zero remainder of the budget that just expired. */
const GATE_JOIN_MS = 5_000;

/** Refuses unless preparation is complete. Called before admission; it does not
 * replace the admission gate, which still runs its own verification.
 *
 * One absolute deadline covers setup, inspection and reset. Once cancellation
 * or deadline expiry is recorded, no new statement reaches the connection: the
 * query boundary refuses locally rather than forwarding to a connection whose
 * timeout state is unknown. A timeout cancels through the connection owner's
 * `cancel` boundary and then joins every operation this gate started — setup,
 * inspection, reset and the cancellation itself — within the explicit
 * termination budget. A failed join refuses with
 * `reset_preparation_cleanup_unresolved` instead of reporting the original
 * timeout as though settlement had been verified. Failures that are not
 * already named carry only the last stage plus a fixed structured category. */
export async function assertResetPreparationComplete(
  admin: Pick<Client, "query">,
  runtimeRole: string,
  repositoryRoot: string | undefined,
  options: {
    readonly deadlineMs?: number;
    readonly joinMs?: number;
    readonly onStage?: (stage: PreparationStage) => void;
    /** Effective owner cancellation for the connection under test. Every
     * failure path invokes it and then observes settlement of what it owned. */
    readonly cancel: () => void | Promise<void>;
  },
) {
  const deadlineAt = Date.now() + (options.deadlineMs ?? GATE_DEADLINE_MS);
  const joinMs = options.joinMs ?? GATE_JOIN_MS;
  let stopped = false;
  let stage: PreparationStage = "setup";
  const track = (next: PreparationStage) => {
    stage = next;
    options.onStage?.(next);
  };
  // The stopped-state boundary is the production half of the regression: an
  // inspection branch that has not yet observed cancellation still cannot put
  // another statement on the wire.
  const boundary = {
    query: ((...args: unknown[]) => {
      if (stopped) throw new Error("reset_preparation_gate_stopped");
      if (Date.now() >= deadlineAt) {
        stopped = true;
        throw new StructuredRefusal(`reset_preparation_gate_failed:${stage}`, {
          category: "timeout",
        });
      }
      return (admin.query as unknown as (...inner: unknown[]) => Promise<unknown>)(...args);
    }) as unknown as Client["query"],
  } as Pick<Client, "query">;
  const withDeadline = <T>(work: () => Promise<T>, code: () => string): Promise<T> => {
    if (stopped || Date.now() >= deadlineAt) {
      stopped = true;
      return Promise.reject(new StructuredRefusal(code(), { category: "timeout" }));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      const delay = deadlineAt - Date.now();
      if (delay <= 0) {
        stopped = true;
        reject(new StructuredRefusal(code(), { category: "timeout" }));
        return;
      }
      timer = setTimeout(() => {
        stopped = true;
        reject(new StructuredRefusal(code(), { category: "timeout" }));
      }, delay);
      (timer as { unref?: () => void }).unref?.();
    });
    // The work starts only after the expiry check, so an already-expired
    // deadline cannot open a new statement.
    let pending: Promise<T>;
    try {
      pending = work();
    } catch (error) {
      if (timer !== undefined) clearTimeout(timer);
      return Promise.reject(error);
    }
    return Promise.race([pending, timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  };
  const boundedDelay = (milliseconds: number) =>
    new Promise<void>((done) => {
      const handle = setTimeout(done, milliseconds);
      (handle as { unref?: () => void }).unref?.();
    });
  let setup: Promise<unknown> | undefined;
  let started: Promise<PreparationReport> | undefined;
  let reset: Promise<unknown> | undefined;
  /** Joins every owned operation, including rejected ones, within one explicit
   * budget, and reports by name the ones still unresolved when it expires. */
  const joinPending = async (): Promise<readonly string[]> => {
    const owned: { readonly name: string; readonly work: Promise<unknown> }[] = [
      {
        name: "cancel",
        work: Promise.resolve()
          .then(() => options.cancel())
          .catch(() => undefined),
      },
    ];
    if (setup !== undefined) owned.push({ name: "setup", work: setup.catch(() => undefined) });
    if (started !== undefined)
      owned.push({ name: "inspection", work: started.catch(() => undefined) });
    if (reset !== undefined) owned.push({ name: "reset", work: reset.catch(() => undefined) });
    const settlement = owned.map(({ name, work }) => {
      let settled = false;
      const observed = work.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      return { name, observed, isSettled: () => settled };
    });
    await Promise.race([
      Promise.all(settlement.map(({ observed }) => observed)),
      boundedDelay(joinMs),
    ]);
    return settlement.filter(({ isSettled }) => !isSettled()).map(({ name }) => name);
  };
  const steps = () =>
    (started ??= (async () => {
      const report = await inspectResetPreparation(boundary, runtimeRole, repositoryRoot, track);
      const unsatisfied = report.findings.find((finding) => !finding.satisfied);
      if (unsatisfied) throw new Error(`reset_preparation_incomplete:${unsatisfied.check}`);
      // The catalog findings above are informative. This is the proof:
      // effective denial through every role the runtime can become, which a
      // catalog count cannot establish.
      track("denial");
      await assertForbiddenPrivilegesDenied(boundary, runtimeRole, repositoryRoot);
      return report;
    })());
  const refuse = (error: unknown) => {
    if (
      error instanceof StructuredRefusal ||
      (error instanceof Error && allowlistedReason(error.message) !== null)
    )
      return error;
    return new StructuredRefusal(`reset_preparation_gate_failed:${stage}`, {
      category: structuredFailureCategory(error),
      sqlstate: structuredSqlState(error),
    });
  };
  let report: PreparationReport | undefined;
  try {
    // Setup is inside the deadline and its failure is not ignored: the gate
    // does not inspect without a confirmed statement timeout, and the
    // timeout cap stays the conservative one rather than the gate budget.
    await withDeadline(
      () => (setup = boundary.query(`SET statement_timeout = '${GATE_STATEMENT_TIMEOUT}'`)),
      () => "reset_preparation_gate_failed:setup",
    );
    report = await withDeadline(
      () => steps(),
      () => `reset_preparation_gate_failed:${stage}`,
    );
    track("reset");
    await withDeadline(
      () => (reset = boundary.query("RESET statement_timeout")),
      () => "reset_preparation_gate_failed:reset",
    );
  } catch (error) {
    // Any failure, including a reset timeout, stops the boundary, cancels the
    // connection and joins setup, inspection, reset and the cancellation
    // itself, bounded, before returning. An unresolved operation is its own
    // refusal: the original timeout must not be reported as though settlement
    // had been verified.
    stopped = true;
    const unresolved = await joinPending();
    if (unresolved.length > 0)
      throw new StructuredRefusal("reset_preparation_cleanup_unresolved", {
        category: structuredFailureCategory(error),
        sqlstate: structuredSqlState(error),
      });
    throw refuse(error);
  }
  return report;
}

/** The reconstruction admission window is a separate failure surface from the
 * preparation gate: its errors are thrown outside the gate's mapping, so the
 * rehearsal wrapper saw only an unallowlisted message and flattened it to
 * `provider_rehearsal_unproven:operation`, losing both the failing step and
 * any category. This boundary names the step and derives the category from
 * the original error, keeping that error in the chain for in-process
 * diagnosis while the message, logs and receipts stay redacted. */
export const ADMISSION_STAGES = [
  "marker",
  "policy",
  "reference",
  "budget",
  "connection",
  "fence_recovery",
  "baseline",
  "schema_authority",
  "runtime_identity",
  "grants",
  "replication",
  "marker_create",
  "inventory",
  "first_batch",
  "admitted",
] as const;
export type AdmissionStage = (typeof ADMISSION_STAGES)[number];

export function admissionRefusal(error: unknown, stage: AdmissionStage): StructuredRefusal {
  if (error instanceof StructuredRefusal) return error;
  return new StructuredRefusal(`reset_admission_unproven:${stage}`, {
    category: structuredFailureCategory(error),
    sqlstate: structuredSqlState(error),
    cause: error,
  });
}

/** Keep every failure before the first observed committed batch on the finite,
 * redacted admission surface. Once `admitted` is observed, later failures
 * retain their existing restore-required identity. */
export async function withResetAdmissionReporting<T>(
  run: (observe: (stage: AdmissionStage) => void) => Promise<T>,
): Promise<T> {
  let stage = "marker" as AdmissionStage;
  try {
    return await run((next) => {
      stage = next;
    });
  } catch (error) {
    if (stage === "admitted") throw error;
    throw admissionRefusal(error, stage);
  }
}
