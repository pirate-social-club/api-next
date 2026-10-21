import { isHnsDiagnosticId } from "@pirate/platform-cf/hns-authority-diagnostics";

export const OFFERING_LIST_DIAGNOSTIC_HEADER = "x-pirate-offering-diagnostic-id";

/** Opt-in timings for the public staging list; no SQL or parameter values. */
export function offeringListDiagnosticId(request: Request): string | undefined {
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.hostname !== "api-next-staging.pirate.sc" ||
    !/^\/communities\/[^/]+\/handle-offerings$/u.test(url.pathname)
  )
    return undefined;
  const id = request.headers.get(OFFERING_LIST_DIAGNOSTIC_HEADER);
  return id !== null && isHnsDiagnosticId(id) ? id : undefined;
}
