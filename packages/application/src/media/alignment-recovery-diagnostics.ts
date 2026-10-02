import { Option, Schema } from "effect";

const StaleReason = Schema.Literals([
  "invalid_publication_binding",
  "multiple_recovery_rows",
  "malformed_recovery_identifiers",
  "invalid_projection_row_count",
  "unknown_projection_status",
  "invalid_failure_code",
  "malformed_artifact",
]);

const ErrorClass = Schema.Literals([
  "ControlPlaneAcquireFailed",
  "ControlPlaneOperationTimedOut",
  "ControlPlaneStatementFailed",
  "ControlPlaneTransactionOutcomeUnknown",
  "unknown",
]);

const ErrorCode = Schema.Literals([
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "40001",
  "40P01",
  "53300",
  "53400",
  "57014",
  "57P01",
  "57P02",
  "57P03",
  "58000",
  "XX000",
  "23503",
  "23505",
  "23514",
  "42501",
]);

const QueryLabel = Schema.Literals([
  "media-processing.alignment-recovery-authorization",
  "media-processing.alignment-recovery",
]);

const FailedReason = Schema.Struct({
  errorClass: ErrorClass,
  code: Schema.NullOr(ErrorCode),
  query: QueryLabel,
});

const Diagnostic = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("alignment_recovery_lookup_stale"),
    reason: StaleReason,
  }),
  Schema.Struct({
    outcome: Schema.Literal("alignment_recovery_lookup_failed"),
    reason: FailedReason,
  }),
]);

export type AlignmentRecoveryStaleReason = typeof StaleReason.Type;
export type AlignmentRecoveryFailedReason = typeof FailedReason.Type;
export type AlignmentRecoveryLookupDiagnostic = typeof Diagnostic.Type;

/** Preserve classifications only; never inspect or forward driver messages. */
export function sanitizeAlignmentRecoveryLookupFailure(
  error: unknown,
  query: AlignmentRecoveryFailedReason["query"],
): AlignmentRecoveryFailedReason {
  const fields = Schema.decodeUnknownOption(
    Schema.Struct({
      _tag: Schema.optional(ErrorClass),
      sqlState: Schema.optional(Schema.Unknown),
    }),
  )(error);
  if (Option.isNone(fields)) return { errorClass: "unknown", code: null, query };
  const code = Schema.decodeUnknownOption(ErrorCode)(fields.value.sqlState);
  return {
    errorClass: fields.value._tag ?? "unknown",
    code: Option.isSome(code) ? code.value : null,
    query,
  };
}

const TERMINAL_PREFIX = "media-alignment-recovery:";

/** The Workflow error journal retains this closed, sanitized diagnostic. */
export function alignmentRecoveryTerminalMessage(
  diagnostic: AlignmentRecoveryLookupDiagnostic,
): string {
  const safe = Schema.decodeUnknownSync(Diagnostic)(diagnostic);
  return `${TERMINAL_PREFIX}${JSON.stringify(safe)}`;
}

export class AlignmentRecoveryLookupTerminalError extends Error {
  override readonly name = "AlignmentRecoveryLookupTerminalError";
  constructor(diagnostic: AlignmentRecoveryLookupDiagnostic) {
    super(alignmentRecoveryTerminalMessage(diagnostic));
  }
}

export function readAlignmentRecoveryTerminalMessage(
  message: unknown,
): AlignmentRecoveryLookupDiagnostic | null {
  if (typeof message !== "string") return null;
  // Worker RPC serialization prefixes a custom Error's name to its message.
  const wrapper = "AlignmentRecoveryLookupTerminalError: ";
  const retained = message.startsWith(wrapper) ? message.slice(wrapper.length) : message;
  if (!retained.startsWith(TERMINAL_PREFIX)) return null;
  try {
    const decoded = Schema.decodeUnknownOption(Diagnostic)(
      JSON.parse(retained.slice(TERMINAL_PREFIX.length)),
      {
        onExcessProperty: "error",
      },
    );
    return Option.isSome(decoded) ? decoded.value : null;
  } catch {
    return null;
  }
}
