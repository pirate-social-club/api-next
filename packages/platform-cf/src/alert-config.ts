import { Data } from "effect";

import { type AlertDeliveryLedger, type AlertSink, makeLocalAlertSink } from "./alerts";

export interface AlertSinkBindings {
  readonly API_NEXT_ENV?: string;
}

export class AlertSinkConfigurationError extends Data.TaggedError("AlertSinkConfigurationError")<{
  readonly field: "API_NEXT_ENV";
}> {}

/**
 * All environments use the structured local Workers Logs adapter. Construction
 * remains eager at the Worker boundary so invalid environment names fail fast.
 */
export function makeConfiguredAlertSink(
  bindings: AlertSinkBindings,
  delivery?: AlertDeliveryLedger,
): AlertSink {
  if (
    bindings.API_NEXT_ENV !== undefined &&
    bindings.API_NEXT_ENV !== "development" &&
    bindings.API_NEXT_ENV !== "staging" &&
    bindings.API_NEXT_ENV !== "production"
  ) {
    throw new AlertSinkConfigurationError({ field: "API_NEXT_ENV" });
  }
  const sink = makeLocalAlertSink(bindings.API_NEXT_ENV ?? "development");
  if (delivery === undefined) return sink;
  return { ...sink, delivery };
}
