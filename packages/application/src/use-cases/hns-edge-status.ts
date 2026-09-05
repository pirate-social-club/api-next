import {
  HNS_EDGE_STATUS_FUTURE_SKEW_SECONDS,
  HNS_EDGE_STATUS_HEARTBEAT_STALE_SECONDS,
  HNS_EDGE_STATUS_MAX_REPORT_AGE_SECONDS,
  HNS_EDGE_STATUS_REPORT_VERSION,
  HNS_EDGE_STATUS_RRSIG_THRESHOLD_SECONDS,
  type HnsEdgeStatusReportV1 as HnsEdgeStatusReport,
  HnsEdgeStatusReportV1,
} from "@pirate/contracts";
import { Data, Effect, Schema } from "effect";

const UnixSeconds = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);

export const HnsEdgeStatusSnapshotV1 = Schema.Struct({
  version: Schema.Literal(HNS_EDGE_STATUS_REPORT_VERSION),
  received_at_unix_seconds: UnixSeconds,
  report: HnsEdgeStatusReportV1,
});
export type HnsEdgeStatusSnapshotV1 = Schema.Schema.Type<typeof HnsEdgeStatusSnapshotV1>;

export class HnsEdgeStatusFailed extends Data.TaggedError("HnsEdgeStatusFailed")<{
  readonly reason: "invalid-report" | "stale-report" | "conflicting-report" | "storage-unavailable";
}> {}

export interface HnsEdgeStatusStore {
  readonly load: () => Effect.Effect<HnsEdgeStatusSnapshotV1 | null, HnsEdgeStatusFailed>;
  readonly save: (snapshot: HnsEdgeStatusSnapshotV1) => Effect.Effect<void, HnsEdgeStatusFailed>;
}

export interface HnsEdgeStatusClock {
  readonly nowUnixSeconds: () => number;
}

export type HnsRootHealthRenewalStatusV1 = Readonly<{
  readonly last_successful_tick_unix_seconds: number | null;
  readonly freshness_threshold_seconds: number | null;
  readonly active_root_count: number;
  readonly healthy_root_count: number;
  readonly delayed_job_count: number;
  readonly terminal_job_count: number;
  readonly earliest_serving_valid_until_unix_seconds: number | null;
  readonly serving_remaining_seconds: number | null;
  readonly earliest_health_valid_until_unix_seconds: number | null;
}>;

export interface HnsRootHealthRenewalStatusStore {
  readonly load: () => Effect.Effect<HnsRootHealthRenewalStatusV1, HnsEdgeStatusFailed>;
}

export interface HnsEdgeStatusProjectionV1 {
  readonly state: "healthy" | "attention" | "missing";
  readonly observed_at_unix_seconds: number | null;
  readonly received_at_unix_seconds: number | null;
  readonly heartbeat_age_seconds: number | null;
  readonly heartbeat_fresh: boolean;
  readonly rrsig_minimum_remaining_seconds: number | null;
  readonly rrsig_threshold_seconds: number;
  readonly rrsig_healthy: boolean;
  readonly primary_serial: number | null;
  readonly secondary_serial: number | null;
  readonly authority_serials_agree: boolean;
  readonly certificate_not_after_unix_seconds: number | null;
  readonly certificate_remaining_seconds: number | null;
  readonly spki_matches_tlsa: boolean;
  readonly app_http_status: number | null;
  readonly failed_units: readonly string[];
}

function canonicalReport(report: HnsEdgeStatusReport): string {
  return JSON.stringify(report);
}

function validReportSemantics(report: HnsEdgeStatusReport, now: number): boolean {
  const [primary, secondary] = report.authority_views;
  const failedUnits = report.failed_units;
  return (
    Number.isSafeInteger(now) &&
    now >= 0 &&
    report.observed_at_unix_seconds <= now + HNS_EDGE_STATUS_FUTURE_SKEW_SECONDS &&
    report.observed_at_unix_seconds >= now - HNS_EDGE_STATUS_MAX_REPORT_AGE_SECONDS &&
    primary.view_id === "primary" &&
    secondary.view_id === "secondary" &&
    new Set(failedUnits).size === failedUnits.length &&
    failedUnits.every((value, index) => {
      const previous = failedUnits[index - 1];
      return previous === undefined || previous < value;
    })
  );
}

export const makeHnsEdgeStatusService = (input: {
  readonly store: HnsEdgeStatusStore;
  readonly clock: HnsEdgeStatusClock;
}) => {
  const publish = Effect.fn("HnsEdgeStatus.publish")(function* (
    report: HnsEdgeStatusReport,
  ): Effect.fn.Return<
    { readonly accepted: true; readonly observed_at_unix_seconds: number },
    HnsEdgeStatusFailed
  > {
    const now = input.clock.nowUnixSeconds();
    if (!validReportSemantics(report, now)) {
      return yield* new HnsEdgeStatusFailed({ reason: "invalid-report" });
    }

    const current = yield* input.store.load();
    if (current !== null) {
      if (report.observed_at_unix_seconds < current.report.observed_at_unix_seconds) {
        return yield* new HnsEdgeStatusFailed({ reason: "stale-report" });
      }
      if (report.observed_at_unix_seconds === current.report.observed_at_unix_seconds) {
        if (canonicalReport(report) !== canonicalReport(current.report)) {
          return yield* new HnsEdgeStatusFailed({ reason: "conflicting-report" });
        }
        return {
          accepted: true as const,
          observed_at_unix_seconds: report.observed_at_unix_seconds,
        };
      }
    }

    yield* input.store.save({
      version: HNS_EDGE_STATUS_REPORT_VERSION,
      received_at_unix_seconds: now,
      report,
    });
    return { accepted: true as const, observed_at_unix_seconds: report.observed_at_unix_seconds };
  });

  const read = Effect.fn("HnsEdgeStatus.read")(function* (): Effect.fn.Return<
    HnsEdgeStatusProjectionV1,
    HnsEdgeStatusFailed
  > {
    const snapshot = yield* input.store.load();
    if (snapshot === null) {
      return {
        state: "missing",
        observed_at_unix_seconds: null,
        received_at_unix_seconds: null,
        heartbeat_age_seconds: null,
        heartbeat_fresh: false,
        rrsig_minimum_remaining_seconds: null,
        rrsig_threshold_seconds: HNS_EDGE_STATUS_RRSIG_THRESHOLD_SECONDS,
        rrsig_healthy: false,
        primary_serial: null,
        secondary_serial: null,
        authority_serials_agree: false,
        certificate_not_after_unix_seconds: null,
        certificate_remaining_seconds: null,
        spki_matches_tlsa: false,
        app_http_status: null,
        failed_units: [],
      };
    }

    const now = input.clock.nowUnixSeconds();
    if (!Number.isSafeInteger(now) || now < 0) {
      return yield* new HnsEdgeStatusFailed({ reason: "storage-unavailable" });
    }
    const [primary, secondary] = snapshot.report.authority_views;
    const remaining = [
      primary.rrsig_remaining_seconds.dnskey,
      primary.rrsig_remaining_seconds.soa,
      primary.rrsig_remaining_seconds.app_a,
      primary.rrsig_remaining_seconds.app_tlsa,
      primary.rrsig_remaining_seconds.wildcard_tlsa,
      secondary.rrsig_remaining_seconds.dnskey,
      secondary.rrsig_remaining_seconds.soa,
      secondary.rrsig_remaining_seconds.app_a,
      secondary.rrsig_remaining_seconds.app_tlsa,
      secondary.rrsig_remaining_seconds.wildcard_tlsa,
    ];
    const rrsigMinimum = Math.min(...remaining);
    const heartbeatAge = Math.max(0, now - snapshot.report.observed_at_unix_seconds);
    const certificateRemaining = snapshot.report.app.certificate_not_after_unix_seconds - now;
    const heartbeatFresh = heartbeatAge <= HNS_EDGE_STATUS_HEARTBEAT_STALE_SECONDS;
    const rrsigHealthy = rrsigMinimum >= HNS_EDGE_STATUS_RRSIG_THRESHOLD_SECONDS;
    const serialsAgree = primary.zone_serial === secondary.zone_serial;
    const spkiMatches =
      snapshot.report.app.served_spki_sha256 === snapshot.report.app.primary_tlsa_spki_sha256 &&
      snapshot.report.app.served_spki_sha256 === snapshot.report.app.secondary_tlsa_spki_sha256;
    const healthy =
      heartbeatFresh &&
      rrsigHealthy &&
      serialsAgree &&
      certificateRemaining > 0 &&
      spkiMatches &&
      snapshot.report.app.http_status === 200 &&
      snapshot.report.failed_units.length === 0;

    return {
      state: healthy ? "healthy" : "attention",
      observed_at_unix_seconds: snapshot.report.observed_at_unix_seconds,
      received_at_unix_seconds: snapshot.received_at_unix_seconds,
      heartbeat_age_seconds: heartbeatAge,
      heartbeat_fresh: heartbeatFresh,
      rrsig_minimum_remaining_seconds: rrsigMinimum,
      rrsig_threshold_seconds: HNS_EDGE_STATUS_RRSIG_THRESHOLD_SECONDS,
      rrsig_healthy: rrsigHealthy,
      primary_serial: primary.zone_serial,
      secondary_serial: secondary.zone_serial,
      authority_serials_agree: serialsAgree,
      certificate_not_after_unix_seconds: snapshot.report.app.certificate_not_after_unix_seconds,
      certificate_remaining_seconds: certificateRemaining,
      spki_matches_tlsa: spkiMatches,
      app_http_status: snapshot.report.app.http_status,
      failed_units: snapshot.report.failed_units,
    };
  });

  return Object.freeze({ publish, read });
};
