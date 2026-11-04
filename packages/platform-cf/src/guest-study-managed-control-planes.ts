// Source construction only: actual distinct named Hyperdrive bindings, no grants or secrets.
import { Schema } from "effect";
import {
  type HyperdriveConnection,
  makeHyperdriveControlPlaneLayer,
  makeReadOnlyPostgresControlPlaneLayer,
} from "./postgres.ts";

export interface GuestStudyManagedControlPlaneBindings {
  readonly GUEST_STUDY_PUBLIC_READ?: HyperdriveConnection;
  readonly GUEST_STUDY_CONTROLLED_LEARNING?: HyperdriveConnection;
  readonly GUEST_STUDY_CRON?: HyperdriveConnection;
  readonly GUEST_STUDY_READINESS_OBSERVER?: HyperdriveConnection;
}
const Hyperdrive = Schema.Struct({ connectionString: Schema.NonEmptyString });
const options = { connectTimeoutMs: 3000, statementTimeoutMs: 2000, closeTimeoutMs: 2000 } as const;
function actual(binding: HyperdriveConnection | undefined): HyperdriveConnection {
  try {
    // Actual Cloudflare bindings have additional properties; none is a privilege
    // assertion. Only the SDK's opaque connectionString is selected and never logged.
    const selected = Schema.decodeUnknownSync(Hyperdrive)(binding);
    if (selected.connectionString.trim() !== selected.connectionString)
      throw new Error("invalid binding");
    return selected;
  } catch {
    throw new Error("Managed Guest Study database bindings unavailable");
  }
}
/** Shared source helper for the later independently admitted Guest jobs closure.
 * This receives the explicit Guestcron binding, never the ordinary Account job
 * connection or browser authority. Construction does not register or run jobs.
 */
export function makeGuestStudyCronControlPlane(binding: HyperdriveConnection | undefined) {
  return makeHyperdriveControlPlaneLayer(actual(binding), options);
}
export function makeGuestStudyManagedControlPlanes(
  bindings: GuestStudyManagedControlPlaneBindings,
) {
  const publicRead = actual(bindings.GUEST_STUDY_PUBLIC_READ);
  const learning = actual(bindings.GUEST_STUDY_CONTROLLED_LEARNING);
  const cron = actual(bindings.GUEST_STUDY_CRON);
  const observer = actual(bindings.GUEST_STUDY_READINESS_OBSERVER);
  // This catches accidental same opaque configuration early. Actual principal,
  // cluster/database identity and finite privileges are STILL derived by V2.
  if (
    new Set([
      publicRead.connectionString,
      learning.connectionString,
      cron.connectionString,
      observer.connectionString,
    ]).size !== 4
  )
    throw new Error("Managed Guest Study database bindings must be distinct");
  return Object.freeze({
    publicRead: makeReadOnlyPostgresControlPlaneLayer(publicRead.connectionString, options),
    learning: makeHyperdriveControlPlaneLayer(learning, options),
    cron: makeGuestStudyCronControlPlane(cron),
    observer: makeReadOnlyPostgresControlPlaneLayer(observer.connectionString, options),
    // Both maintained SDK constructors transactionally pin api_next,pg_catalog.
    // A caller body/config value cannot select another schema or bypass admission.
    schema: "api_next" as const,
  });
}
