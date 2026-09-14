export type RehearsalModeFlag = "--dry-run" | "--execute";
export type DiagnosticModeFlag = "--diagnostic" | "--no-diagnostic";

/** Diagnostic intent crosses the secret-injection boundary as an argument.
 * The supervisor then overwrites the child's final environment, so ambient or
 * injected values cannot disagree with the launch journal. */
export function resolveDiagnosticIntent(
  mode: string | undefined,
  flag: string | undefined,
): Readonly<{ mode: RehearsalModeFlag; flag: DiagnosticModeFlag; diagnostic: boolean }> {
  if (mode !== "--dry-run" && mode !== "--execute") throw new Error("rehearsal_mode_required");
  if (flag !== "--diagnostic" && flag !== "--no-diagnostic")
    throw new Error("rehearsal_diagnostic_mode_required");
  if (mode === "--dry-run" && flag === "--diagnostic")
    throw new Error("rehearsal_diagnostic_mode_invalid");
  return { mode, flag, diagnostic: mode === "--execute" && flag === "--diagnostic" };
}

export function providerDiagnosticEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
  diagnostic: boolean,
): NodeJS.ProcessEnv {
  return { ...environment, STAGING_REHEARSAL_DIAGNOSTIC: diagnostic ? "1" : "0" };
}
