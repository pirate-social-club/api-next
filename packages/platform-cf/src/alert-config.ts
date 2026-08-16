import { Data, Redacted } from "effect";

import {
  type AlertDeliveryLedger,
  type AlertSink,
  makeHttpAlertSink,
  makeLocalAlertSink,
} from "./alerts";

export interface AlertSinkBindings {
  readonly API_NEXT_ENV?: string;
  readonly API_NEXT_ALERT_EMAIL_URL?: string;
  readonly API_NEXT_ALERT_WEBHOOK_URL?: string;
  readonly API_NEXT_ALERT_EMAIL_TOKEN?: string;
  readonly API_NEXT_ALERT_WEBHOOK_TOKEN?: string;
}

export class AlertSinkConfigurationError extends Data.TaggedError("AlertSinkConfigurationError")<{
  readonly field:
    | "API_NEXT_ALERT_EMAIL_URL"
    | "API_NEXT_ALERT_WEBHOOK_URL"
    | "API_NEXT_ALERT_EMAIL_TOKEN"
    | "API_NEXT_ALERT_WEBHOOK_TOKEN";
}> {}

function requiredUrl(
  bindings: AlertSinkBindings,
  field: "API_NEXT_ALERT_EMAIL_URL" | "API_NEXT_ALERT_WEBHOOK_URL",
): string {
  const value = bindings[field]?.trim();
  if (value === undefined || value.length === 0 || !value.startsWith("https://")) {
    throw new AlertSinkConfigurationError({ field });
  }
  return value;
}

function requiredSecret(
  bindings: AlertSinkBindings,
  field: "API_NEXT_ALERT_EMAIL_TOKEN" | "API_NEXT_ALERT_WEBHOOK_TOKEN",
): Redacted.Redacted<string> {
  const value = bindings[field];
  if (value === undefined || value.length === 0) {
    throw new AlertSinkConfigurationError({ field });
  }
  return Redacted.make(value);
}

/**
 * Production requires both endpoint URLs and both Wrangler-provisioned
 * secrets. Development and tests use a local sink and never contact a
 * provider, even when a shell happens to contain production variables.
 */
export function makeConfiguredAlertSink(
  bindings: AlertSinkBindings,
  delivery?: AlertDeliveryLedger,
): AlertSink {
  if (bindings.API_NEXT_ENV !== "production") {
    return makeLocalAlertSink();
  }
  return makeHttpAlertSink({
    emailUrl: requiredUrl(bindings, "API_NEXT_ALERT_EMAIL_URL"),
    webhookUrl: requiredUrl(bindings, "API_NEXT_ALERT_WEBHOOK_URL"),
    emailToken: requiredSecret(bindings, "API_NEXT_ALERT_EMAIL_TOKEN"),
    webhookToken: requiredSecret(bindings, "API_NEXT_ALERT_WEBHOOK_TOKEN"),
    ...(delivery === undefined ? {} : { delivery }),
  });
}
