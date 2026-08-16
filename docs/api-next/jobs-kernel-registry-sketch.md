# Jobs-kernel registry sketch

The registry is data consumed by one generic runner. It is not a second place
for job-specific scheduling or error-handling logic. The shape below extends
the existing spike's `name`, `lane`, `timeout`, and `run` fields with the
declarations required by foundation 000 section 12.

## Declaration shape

```ts
type TableKey =
  | `control-plane:${string}`
  | `community-shard:${string}`;

type SeverityMapping = {
  readonly expectedFailure: Readonly<Record<string, "low" | "medium" | "high">>;
  readonly timeout: "low" | "medium" | "high";
  readonly transactionOutcomeUnknown: "medium" | "high";
  readonly defect: "high";
};

type JobDeclaration<Failure> = {
  readonly name: string;
  readonly lane: string;
  readonly schedule: string;
  readonly timeout: Duration.Input;
  readonly retry: Schedule<Failure, unknown>;
  readonly expectedFailures: readonly string[];
  readonly severity: SeverityMapping;
  readonly writes: readonly TableKey[];
  readonly run: Effect.Effect<void, Failure, JobContext>;
};
```

`retry` is an Effect `Schedule` value, normally exponential and jittered. It
is not a numeric delay or a per-exception boolean. `schedule` is the declared
cron/event cadence used to place the job in a lane; the runner does not infer
cadence from the function body. `expectedFailures` names the closed tagged
error types that the job may return as values in the Effect error channel.

`writes` is a logical table ownership declaration, not a hint. A job that
reads and writes a table lists it. A dynamic table family must be represented
by a stable `TableKey` family and reviewed as one writer, rather than bypassing
the check with a runtime-generated string.

The declaration also carries the job's effect program. There is no separate
runner-level catch for string-matched exceptions. Expected failures feed the
declared retry schedule and `AlertCollector`; defects go to the defect/error
boundary and the declared high-severity path.

## One-writing-scheduler-per-table rule

The primary enforcement point is the registry builder used during jobs-worker
startup and in a dependency-free registry validation test. It receives the
complete declarations and a coordinator-maintained inventory of still-live
old-API writers.

Registry construction rejects all of these before any schedule is registered:

1. two active declarations list the same `TableKey`, even if they are in
   different lanes;
2. a new declaration lists a table with a live old-API scheduler counterpart;
3. a declaration writes a table without a `TableKey`; or
4. two declarations share a job name. Multiple declarations may share a lane:
   the lane lease serializes them in declaration order, while the global table
   inventory prevents conflicting writers.

The validation result is a typed configuration defect. It fails startup and
the CI registry test; it does not choose a winner or silently disable one
writer. The old counterpart inventory is removed only in the coordinator's
strangler migration step.

The lane DO lease still serializes ticks for a lane, but it is not the table
ownership proof: two jobs in one lane or two lanes can otherwise target the
same table. The registry check is therefore mandatory even when every lane
lease test is green.

At the write boundary, repository ports also receive the active owner/attempt
fencing token. This catches a stale runner even after a lease has expired. A
registry declaration without a corresponding fenced write port is incomplete
and must not be admitted as a writing job.

## Runner consequences

For each declaration, the generic runner:

- acquires and renews the lane lease;
- starts the declared Effect program under `Effect.timeout`;
- applies the declared jittered retry `Schedule` only to the declared
  expected-failure types;
- routes the declared severity mapping through one tick-level
  `AlertCollector`; and
- releases the lease only after adapter abort/fence evidence satisfies the
  adapter-abort contract.

The sole non-cancellable exception, story minting, must be an explicit field
on that job declaration and must use fencing at every write boundary. It is
not a runner-wide special case.
