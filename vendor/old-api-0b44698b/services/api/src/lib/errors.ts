export class OldApiAuthError extends Error {
  readonly code = "authentication_failed" as const;
}

export function authError(message: string): OldApiAuthError {
  return new OldApiAuthError(message)
}

export function internalError(message: string): OldApiAuthError {
  return new OldApiAuthError(message)
}
