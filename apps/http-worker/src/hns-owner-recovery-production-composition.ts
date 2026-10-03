import { decodeHnsControlObserverCompatibleConfigurationBytes } from "@pirate/application/namespace-ownership";
import {
  HnsOwnerRecoveryPollRejected,
  HnsOwnerRecoveryProviderFailed,
} from "@pirate/application/route-revalidation";
import { makeControlPlaneHnsOwnerRecoveryPollStore } from "@pirate/platform-cf/hns-owner-recovery-poll-repository";
import {
  makeControlPlaneHnsOwnerRecoveryAuthorityResolver,
  makeControlPlaneHnsOwnerRecoveryStartStore,
} from "@pirate/platform-cf/hns-owner-recovery-start-repository";
import { makeControlPlaneHnsControlObserverConfigurationResolver } from "@pirate/platform-cf/namespace-ownership-hns-control-observer-postgres";
import { makeHnsOwnerRecoveryServiceBindingProvider } from "@pirate/platform-cf/namespace-ownership-hns-owner-recovery-service-binding";
import type { HnsOwnerServiceBinding } from "@pirate/platform-cf/namespace-ownership-provider-registry";
import { Effect } from "effect";
import {
  type HnsOwnerRecoveryHandlers,
  makeHnsOwnerRecoveryHandlers,
} from "./hns-owner-recovery-handlers.ts";

export function makeProductionHnsOwnerRecoveryHandlers(
  input: Readonly<{
    enabled: boolean;
    environment: string;
    database: Parameters<typeof makeControlPlaneHnsOwnerRecoveryStartStore>[0];
    verifier?: HnsOwnerServiceBinding;
  }>,
): Partial<HnsOwnerRecoveryHandlers> {
  if (!input.enabled) return {};
  if (input.verifier === undefined) {
    throw new Error("HNS owner recovery private verifier is unavailable");
  }
  const provider = makeHnsOwnerRecoveryServiceBindingProvider(input.verifier);
  const store = makeControlPlaneHnsOwnerRecoveryPollStore(input.database);
  const configurations = makeControlPlaneHnsControlObserverConfigurationResolver(input.database);
  return makeHnsOwnerRecoveryHandlers({
    start: {
      authority: makeControlPlaneHnsOwnerRecoveryAuthorityResolver(input.database),
      store: makeControlPlaneHnsOwnerRecoveryStartStore(input.database),
      provider,
    },
    poll: (request) =>
      Effect.gen(function* () {
        const stored = yield* store.load(request);
        if (stored === null)
          return yield* new HnsOwnerRecoveryPollRejected({ reason: "not_found" });
        const session = stored.session;
        if (session.expected_binding_generation !== request.expected_generation) {
          return yield* new HnsOwnerRecoveryPollRejected({ reason: "conflict" });
        }
        const expected = session.provider_configuration;
        const bytes = yield* Effect.tryPromise({
          try: (signal) => configurations.resolve(expected, { deadline_ms: 5_000, signal }),
          catch: () => new HnsOwnerRecoveryProviderFailed({ reason: "unavailable" }),
        });
        if (bytes === null)
          return yield* new HnsOwnerRecoveryProviderFailed({ reason: "misconfigured" });
        const decoded = yield* Effect.tryPromise({
          try: () => decodeHnsControlObserverCompatibleConfigurationBytes(bytes),
          catch: () => new HnsOwnerRecoveryProviderFailed({ reason: "misconfigured" }),
        });
        const config = decoded.configuration;
        if (
          decoded.configuration_digest !== expected.digest ||
          config.provider_configuration_reference !== expected.reference ||
          config.provider_configuration_version !== expected.version ||
          config.environment !== session.environment ||
          config.environment !== input.environment
        ) {
          return yield* new HnsOwnerRecoveryProviderFailed({ reason: "misconfigured" });
        }
        return {
          store,
          provider,
          policy: {
            expected_block_interval_seconds: config.chain.expected_block_interval_seconds,
            minimum_safe_remaining_blocks: config.chain.minimum_safe_remaining_blocks,
            expiry_safety_blocks: config.chain.expiry_safety_blocks,
            evidence_lease_seconds: config.evidence_lease_seconds,
          },
        };
      }),
  });
}
