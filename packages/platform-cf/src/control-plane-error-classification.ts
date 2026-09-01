import type { ControlPlaneError } from "@pirate/application";

type MegapotStorageFailureReason = "conflict" | "constraint" | "outcome-unknown" | "unavailable";

export function classifyMegapotStorageFailure(
  error: unknown,
): MegapotStorageFailureReason | undefined {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return undefined;

  switch (error._tag) {
    case "ControlPlaneTransactionOutcomeUnknown":
      return "outcome-unknown";
    case "ControlPlaneOperationTimedOut":
      return "outcomeCertainty" in error && error.outcomeCertainty === "unknown"
        ? "outcome-unknown"
        : "unavailable";
    case "ControlPlaneStatementFailed":
      if ("sqlState" in error && error.sqlState === "23505") return "conflict";
      return !("sqlState" in error) || error.sqlState !== null ? "constraint" : "unavailable";
    case "ControlPlaneAcquireFailed":
      return "unavailable";
    default:
      return undefined;
  }
}

export function mapMegapotStorageFailure<E, F>(
  error: E | ControlPlaneError,
  makeFailure: (reason: MegapotStorageFailureReason) => F,
): E | F {
  const reason = classifyMegapotStorageFailure(error);
  return reason === undefined ? (error as E) : makeFailure(reason);
}
