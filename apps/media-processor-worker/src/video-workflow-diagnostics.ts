import { Option, Schema } from "effect";

const MachineLabel = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.:-]{1,120}$/u));
const StatementFailure = Schema.Struct({
  _tag: Schema.Literal("ControlPlaneStatementFailed"),
  label: MachineLabel,
  sqlState: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[A-Z0-9]{5}$/u))),
  constraint: Schema.NullOr(MachineLabel),
  outcomeCertainty: Schema.Literals(["not-started", "completed", "aborted", "unknown"]),
});
const Context = Schema.Struct({
  workflow_instance_id: Schema.String.check(Schema.isPattern(/^vaw-[a-f0-9]{64}$/u)),
  step: MachineLabel,
});

/** Retain database classification across Cloudflare's Error-message serialization.
 * SQL, values, driver messages, stacks and arbitrary error properties stay private.
 * This is still an ordinary retryable step error; it changes no recovery policy.
 */
export async function runVideoWorkflowStep<T>(
  instanceId: string,
  step: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const failure = Schema.decodeUnknownOption(StatementFailure)(error);
    const context = Schema.decodeUnknownOption(Context)({ workflow_instance_id: instanceId, step });
    if (Option.isNone(failure) || Option.isNone(context)) throw error;
    const diagnostic = {
      ...context.value,
      error_tag: failure.value._tag,
      statement: failure.value.label,
      sql_state: failure.value.sqlState,
      constraint: failure.value.constraint,
      outcome_certainty: failure.value.outcomeCertainty,
    };
    console.error("video_workflow_database_failure", diagnostic);
    throw new Error(`video-workflow-database-failure:${JSON.stringify(diagnostic)}`);
  }
}
