import { AlertCollector, ControlPlaneDb, expireCommunityRouteEvidence } from "@pirate/application";
import {
  decodeHnsControlObserverCompatibleConfigurationBytes,
  HnsActiveLeaseRenewalProviderFailed,
  runHnsActiveLeaseRenewal,
} from "@pirate/application/namespace-ownership";
import { type AlertSink, makeControlPlaneCommunityRouteExpiryStore } from "@pirate/platform-cf";
import {
  makeControlPlaneHnsActiveLeaseRenewalStore,
  readHnsActiveLeaseRenewalCandidates,
} from "@pirate/platform-cf/hns-active-lease-renewal-repository";
import { makeControlPlaneHnsControlObserverRepository } from "@pirate/platform-cf/namespace-ownership-hns-control-observer-postgres";
import { makeHnsOwnerActiveLeaseRenewalServiceBindingProvider } from "@pirate/platform-cf/namespace-ownership-hns-owner-active-lease-renewal-service-binding";
import { Effect, Layer, Option, Schema } from "effect";
import type { HnsRouteRevalidationBindings } from "./hns-route-revalidation";
import { defaultRetrySchedule, JobContext, type JobDeclaration } from "./registry";

export interface HnsActiveLeaseRenewalBindings extends HnsRouteRevalidationBindings {
  readonly HNS_ACTIVE_LEASE_RENEWAL_ENABLED?: string;
  readonly HNS_ROUTE_RENEWAL_LEAD_SECONDS?: string;
}

const Settings = Schema.Struct({
  reference: Schema.NonEmptyString.check(Schema.isTrimmed(), Schema.isMaxLength(256)),
  version: Schema.NonEmptyString.check(Schema.isTrimmed(), Schema.isMaxLength(128)),
  leadSeconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 604_800 })),
});

/** This mode replaces the legacy challenge scheduler; both may not write ownership tables. */
export function makeHnsActiveLeaseRenewalJob(
  bindings: HnsActiveLeaseRenewalBindings,
  environment: string,
  sink: AlertSink,
): JobDeclaration<unknown, ControlPlaneDb | AlertCollector> | null {
  const enabled = bindings.HNS_ACTIVE_LEASE_RENEWAL_ENABLED;
  if (enabled === undefined || enabled === "false") return null;
  const settings = Schema.decodeUnknownOption(Settings)({
    reference: bindings.HNS_OWNERSHIP_CONFIGURATION_REFERENCE,
    version: bindings.HNS_OWNERSHIP_CONFIGURATION_VERSION,
    leadSeconds: Number(bindings.HNS_ROUTE_RENEWAL_LEAD_SECONDS),
  });
  if (
    enabled !== "true" ||
    bindings.HNS_OWNERSHIP_ENABLED === "true" ||
    bindings.HNS_OWNER_VERIFIER === undefined ||
    Option.isNone(settings)
  ) {
    throw new Error(
      "HNS active lease renewal configuration is incomplete or conflicts with recovery",
    );
  }
  const configuration = settings.value;
  const transport = makeHnsOwnerActiveLeaseRenewalServiceBindingProvider(
    bindings.HNS_OWNER_VERIFIER,
  );
  const run = Effect.gen(function* () {
    const db = yield* ControlPlaneDb;
    const alerts = yield* AlertCollector;
    const runtime = Layer.succeed(ControlPlaneDb, db);
    const store = makeControlPlaneHnsActiveLeaseRenewalStore(runtime);
    yield* expireCommunityRouteEvidence(
      { family: "hns", limit: 1, principal_id: "route-expiry-scheduler" },
      { store: makeControlPlaneCommunityRouteExpiryStore(runtime) },
    );
    const bytes = yield* makeControlPlaneHnsControlObserverRepository().resolve(configuration);
    const decoded = yield* Effect.tryPromise({
      try: async () => {
        if (bytes === null) throw new Error("Missing observer configuration");
        const value = await decodeHnsControlObserverCompatibleConfigurationBytes(bytes);
        if (
          value.configuration.environment !== environment ||
          value.configuration.provider_configuration_reference !== configuration.reference ||
          value.configuration.provider_configuration_version !== configuration.version ||
          configuration.leadSeconds >= value.configuration.evidence_lease_seconds
        )
          throw new Error("Observer configuration differs from renewal admission");
        return value;
      },
      catch: () => new HnsActiveLeaseRenewalProviderFailed({ reason: "misconfigured" }),
    });
    const candidates = yield* readHnsActiveLeaseRenewalCandidates({
      ...configuration,
      environment,
      limit: 1,
    });
    for (const candidate of candidates) {
      if (candidate.provider_configuration.digest !== decoded.configuration_digest) {
        return yield* new HnsActiveLeaseRenewalProviderFailed({ reason: "misconfigured" });
      }
      const result = yield* runHnsActiveLeaseRenewal(
        {
          route_binding_id: candidate.route_binding_id,
          idempotency_key: `hns-lease-renewal:${candidate.expected_binding_generation}`,
        },
        {
          store,
          policy: {
            ...decoded.configuration.chain,
            evidence_lease_seconds: decoded.configuration.evidence_lease_seconds,
          },
          provider: {
            renew: (request, authority, options) => {
              if (
                authority.expected_binding_generation !== candidate.expected_binding_generation ||
                authority.expected_verified_evidence_ref !==
                  candidate.expected_verified_evidence_ref ||
                authority.provider_configuration.digest !== decoded.configuration_digest ||
                authority.environment !== environment
              )
                return Effect.fail(
                  new HnsActiveLeaseRenewalProviderFailed({ reason: "unavailable" }),
                );
              return transport
                .renew(request, authority, options)
                .pipe(
                  Effect.mapError(
                    (error) => new HnsActiveLeaseRenewalProviderFailed({ reason: error.reason }),
                  ),
                );
            },
          },
        },
      );
      if (result.status !== "verified") {
        yield* alerts.emit({
          key: "hns-active-lease-renewal:unresolved",
          severity: "high",
          body: "HNS ownership renewal did not produce fresh verified evidence.",
          entity: candidate.route_binding_id,
        });
      }
    }
  }).pipe(
    Effect.onInterrupt(() =>
      JobContext.use((context) => Effect.sync(context.adapterSafety.markAbortedOrFenced)),
    ),
  );
  return {
    name: "hns-active-lease-renewal.poll",
    lane: "hns-route-revalidation",
    schedule: "*/5 * * * *",
    timeout: "45 seconds",
    retry: defaultRetrySchedule,
    expectedFailures: [
      "CommunityRouteExpiryStorageFailed",
      "HnsActiveLeaseRenewalStorageFailed",
      "HnsActiveLeaseRenewalProviderFailed",
      "HnsActiveLeaseRenewalRejected",
    ],
    severity: {
      expectedFailure: {
        CommunityRouteExpiryStorageFailed: "high",
        HnsActiveLeaseRenewalStorageFailed: "high",
        HnsActiveLeaseRenewalProviderFailed: "high",
        HnsActiveLeaseRenewalRejected: "medium",
      },
      timeout: "high",
      transactionOutcomeUnknown: "high",
      defect: "high",
    },
    reads: [
      "postgres:communities",
      "postgres:community_canonical_route_bindings",
      "postgres:community_route_ownership_evidence",
      "postgres:community_route_hns_control_identities",
      "postgres:hns_control_observer_configurations",
      "postgres:namespace_ownership_evidence_snapshots",
      "postgres:community_route_revalidation_evidence_snapshots",
      "postgres:community_route_active_lease_renewals",
      "postgres:community_route_active_lease_renewal_attempts",
      "postgres:community_route_active_lease_renewal_evidence_snapshots",
      "postgres:hns_operator_control_promotion_receipts",
    ],
    writes: [
      "postgres:community_canonical_route_bindings",
      "postgres:community_route_ownership_evidence",
      "postgres:community_route_hns_control_identities",
      "postgres:community_route_active_lease_renewals",
      "postgres:community_route_active_lease_renewal_attempts",
      "postgres:community_route_active_lease_renewal_evidence_snapshots",
      "postgres:community_route_lifecycle_transitions",
    ],
    alertSink: sink,
    requiresAdapterSafety: true,
    run,
  };
}
