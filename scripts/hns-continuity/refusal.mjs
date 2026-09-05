/** Only controlled operator messages cross the CLI error boundary. */
export class ContinuityRefusal extends Error {
  name = "ContinuityRefusal";
}

export function continuityFailureMessage(error) {
  if (error instanceof ContinuityRefusal) return error.message;
  if (
    (error?.name === "HnsAuthorityCandidateCommitRefusal" ||
      error?.name === "HnsAuthorityEmitRefusal") &&
    typeof error.reason === "string" &&
    /^[a-z_]+$/u.test(error.reason)
  )
    return `HNS continuity refused: ${error.reason}`;
  return "HNS continuity command failed; credential-bearing transport and database errors are suppressed";
}
