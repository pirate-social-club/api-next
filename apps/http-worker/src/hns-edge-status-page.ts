import {
  type HnsEdgeStatusClock,
  type HnsEdgeStatusProjectionV1,
  type HnsEdgeStatusStore,
  type HnsRootHealthRenewalStatusStore,
  type HnsRootHealthRenewalStatusV1,
  makeHnsEdgeStatusService,
} from "@pirate/application/use-cases/hns-edge-status";
import type { CloudflareAccessJwtValidatorV1 } from "@pirate/platform-cf/cloudflare-access-jwt";
import { Effect } from "effect";

export type HnsEdgeStatusComposition =
  | Readonly<{
      enabled: false;
      access_validator: null;
      store: null;
      renewal_status_store: null;
      clock: null;
    }>
  | Readonly<{
      enabled: true;
      access_validator: CloudflareAccessJwtValidatorV1;
      store: HnsEdgeStatusStore;
      renewal_status_store: HnsRootHealthRenewalStatusStore;
      clock: HnsEdgeStatusClock;
    }>;

export type HnsEdgeStatusCompositionDependencies = Readonly<{
  access_validator?: CloudflareAccessJwtValidatorV1;
  store?: HnsEdgeStatusStore;
  renewal_status_store?: HnsRootHealthRenewalStatusStore;
  clock?: HnsEdgeStatusClock;
}>;

const disabledComposition: HnsEdgeStatusComposition = Object.freeze({
  enabled: false,
  access_validator: null,
  store: null,
  renewal_status_store: null,
  clock: null,
});

export function makeHnsEdgeStatusComposition(
  enabled: boolean,
  dependencies: HnsEdgeStatusCompositionDependencies = {},
): HnsEdgeStatusComposition {
  if (!enabled) return disabledComposition;
  if (
    dependencies.access_validator === undefined ||
    dependencies.store === undefined ||
    dependencies.renewal_status_store === undefined ||
    dependencies.clock === undefined
  ) {
    throw new Error("HNS edge status composition is incomplete or invalid");
  }
  return Object.freeze({
    enabled: true,
    access_validator: dependencies.access_validator,
    store: dependencies.store,
    renewal_status_store: dependencies.renewal_status_store,
    clock: dependencies.clock,
  });
}

export const disabledProductionHnsEdgeStatusComposition = makeHnsEdgeStatusComposition(false);

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function instant(unixSeconds: number | null): string {
  return unixSeconds === null ? "No report" : new Date(unixSeconds * 1_000).toISOString();
}

function duration(seconds: number | null): string {
  if (seconds === null) return "No report";
  const sign = seconds < 0 ? "−" : "";
  const absolute = Math.abs(seconds);
  if (absolute >= 86_400) return `${sign}${(absolute / 86_400).toFixed(1)} days`;
  if (absolute >= 3_600) return `${sign}${(absolute / 3_600).toFixed(1)} hours`;
  return `${sign}${Math.floor(absolute / 60)} minutes`;
}

function row(label: string, value: string, healthy: boolean): string {
  const state = healthy ? "ok" : "attention";
  return `<div class="row"><div><span class="dot ${state}"></span>${escapeHtml(label)}</div><strong>${escapeHtml(value)}</strong></div>`;
}

function renderHnsEdgeStatusPage(
  status: HnsEdgeStatusProjectionV1,
  renewal: HnsRootHealthRenewalStatusV1,
  nowUnixSeconds: number,
): string {
  const heartbeat =
    status.heartbeat_age_seconds === null
      ? "No report received"
      : `${duration(status.heartbeat_age_seconds)} ago · observed ${instant(status.observed_at_unix_seconds)} · received ${instant(status.received_at_unix_seconds)}`;
  const rrsig =
    status.rrsig_minimum_remaining_seconds === null
      ? "No report"
      : `${duration(status.rrsig_minimum_remaining_seconds)} · threshold ${duration(status.rrsig_threshold_seconds)}`;
  const serials =
    status.primary_serial === null || status.secondary_serial === null
      ? "No report"
      : `${status.primary_serial} / ${status.secondary_serial}`;
  const certificate =
    status.certificate_not_after_unix_seconds === null
      ? "No report"
      : `${duration(status.certificate_remaining_seconds)} · expires ${instant(status.certificate_not_after_unix_seconds)} · ${status.spki_matches_tlsa ? "TLSA matches" : "TLSA mismatch"}`;
  const httpStatus = status.app_http_status === null ? "No report" : String(status.app_http_status);
  const failedUnits = status.failed_units.length === 0 ? "None" : status.failed_units.join(", ");
  const renewalAge =
    renewal.last_successful_tick_unix_seconds === null
      ? null
      : Math.max(0, nowUnixSeconds - renewal.last_successful_tick_unix_seconds);
  const renewalFresh =
    renewalAge !== null &&
    renewal.freshness_threshold_seconds !== null &&
    renewalAge <= renewal.freshness_threshold_seconds;
  const renewalHeartbeat =
    renewalAge === null
      ? "No successful tick"
      : `${duration(renewalAge)} ago · threshold ${duration(renewal.freshness_threshold_seconds)}`;
  const rootHealth = `${renewal.healthy_root_count} / ${renewal.active_root_count} healthy${
    renewal.earliest_health_valid_until_unix_seconds === null
      ? ""
      : ` · earliest expiry ${instant(renewal.earliest_health_valid_until_unix_seconds)}`
  }`;
  const renewalHealthy =
    renewalFresh &&
    renewal.healthy_root_count === renewal.active_root_count &&
    renewal.delayed_job_count === 0 &&
    renewal.terminal_job_count === 0 &&
    (renewal.active_root_count === 0 || (renewal.serving_remaining_seconds ?? 0) > 0);
  const renewalJobs = `${renewal.delayed_job_count} delayed · ${renewal.terminal_job_count} terminal`;
  const servingValidity =
    renewal.serving_remaining_seconds === null
      ? "No active serving evidence"
      : `${duration(renewal.serving_remaining_seconds)} remaining · expires ${instant(renewal.earliest_serving_valid_until_unix_seconds)}`;
  const title =
    status.state === "healthy" && renewalHealthy ? "HNS healthy" : "HNS needs attention";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root{color-scheme:dark;background:#0c1117;color:#e6edf3;font:16px/1.45 ui-sans-serif,system-ui,sans-serif}
    body{margin:0;padding:24px}main{max-width:760px;margin:0 auto}h1{font-size:1.35rem;margin:0 0 6px}p{color:#8b949e;margin:0 0 20px}
    section{border:1px solid #30363d;border-radius:12px;overflow:hidden;background:#161b22}.row{display:grid;grid-template-columns:minmax(160px,1fr) minmax(0,2fr);gap:16px;padding:15px 16px;border-top:1px solid #30363d}.row:first-child{border-top:0}.row strong{text-align:right;overflow-wrap:anywhere}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:10px;background:#f85149}.dot.ok{background:#3fb950}@media(max-width:560px){body{padding:16px}.row{grid-template-columns:1fr;gap:5px}.row strong{text-align:left;padding-left:19px}}
  </style>
</head>
<body><main><h1>${title}</h1><p>Retained root · latest VPS observation</p><section>
${row("Heartbeat", heartbeat, status.heartbeat_fresh)}
${row("RRSIG margin", rrsig, status.rrsig_healthy)}
${row("Authority serials", serials, status.authority_serials_agree)}
${row("Certificate and TLSA", certificate, (status.certificate_remaining_seconds ?? -1) > 0 && status.spki_matches_tlsa)}
${row("Retained app HTTP", httpStatus, status.app_http_status === 200)}
${row("Failed units", failedUnits, status.failed_units.length === 0)}
${row("Health renewal scheduler", renewalHeartbeat, renewalFresh)}
${row("Imported root health", rootHealth, renewalHealthy)}
${row("Current renewal jobs", renewalJobs, renewal.delayed_job_count === 0 && renewal.terminal_job_count === 0)}
${row("Imported serving validity", servingValidity, renewal.active_root_count === 0 || (renewal.serving_remaining_seconds ?? 0) > 0)}
</section></main></body>
</html>`;
}

const responseHeaders = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "content-type": "text/html; charset=UTF-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

export async function serveHnsEdgeStatusPage(
  request: Request,
  composition: Extract<HnsEdgeStatusComposition, { readonly enabled: true }>,
): Promise<Response> {
  const assertion = request.headers.get("cf-access-jwt-assertion");
  if (assertion === null) return new Response("Not authorized", { status: 401 });
  try {
    await composition.access_validator.verify(assertion, request.signal);
  } catch {
    return new Response("Not authorized", { status: 401 });
  }

  try {
    const [status, renewal] = await Promise.all([
      Effect.runPromise(
        makeHnsEdgeStatusService({ store: composition.store, clock: composition.clock }).read(),
      ),
      Effect.runPromise(composition.renewal_status_store.load()),
    ]);
    return new Response(
      renderHnsEdgeStatusPage(status, renewal, composition.clock.nowUnixSeconds()),
      {
        status: status.state === "missing" ? 503 : 200,
        headers: responseHeaders,
      },
    );
  } catch {
    return new Response("HNS status unavailable", {
      status: 503,
      headers: { ...responseHeaders, "content-type": "text/plain; charset=UTF-8" },
    });
  }
}
