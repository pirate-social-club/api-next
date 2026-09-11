import {
  gatherHnsActivationCurrentViewV1,
  preflightEncodeHnsResourceV1,
} from "@pirate/application/namespace-ownership";
import type { HnsActivationCurrentViewConfigValue } from "@pirate/platform-cf/config";
import { makeControlPlaneHnsActivationCurrentViewIdentityRead } from "@pirate/platform-cf/hns-activation-current-view-repository";
import { makeHsdRootResourceObserver } from "@pirate/platform-cf/namespace-ownership-hns-root-resource-observer";
import { Effect, Redacted } from "effect";
import type { makeHnsCommunityRootImportHandlers } from "./hns-community-root-import-handlers.ts";

type ActivationCurrentView = NonNullable<
  Parameters<typeof makeHnsCommunityRootImportHandlers>[0]["currentView"]
>;
type ControlPlaneRuntime = Parameters<
  typeof makeControlPlaneHnsActivationCurrentViewIdentityRead
>[0];

/**
 * Builds the only production activation current-view port. Disabled
 * configuration yields an unavailable capability rather than an invalid one;
 * enabled configuration is already complete and bounded (enforced by
 * HnsActivationCurrentViewConfig), and constructing the observer performs no
 * I/O. The identity read runs in its own database scope, released before the
 * observer's network read.
 */
export function makeProductionHnsActivationCurrentView(
  controlPlane: ControlPlaneRuntime,
  configuration: HnsActivationCurrentViewConfigValue,
): ActivationCurrentView {
  if (!configuration.enabled) {
    return () => Effect.succeed({ kind: "unavailable", classification: "disabled" });
  }
  let observer: ReturnType<typeof makeHsdRootResourceObserver>;
  try {
    observer = makeHsdRootResourceObserver({
      rpc_url: configuration.HNS_AUTHORITY_HSD_RPC_URL,
      authorization: Redacted.value(configuration.HNS_AUTHORITY_HSD_AUTHORIZATION),
      chain_network: configuration.HNS_AUTHORITY_CHAIN_NETWORK,
      genesis_block_hash: configuration.HNS_AUTHORITY_CHAIN_GENESIS_BLOCK_HASH,
      tree_interval_blocks: configuration.HNS_AUTHORITY_TREE_INTERVAL_BLOCKS,
      safe_minimum_confirmations: configuration.HNS_AUTHORITY_SAFE_CONFIRMATIONS,
      maximum_tip_age_seconds: configuration.HNS_AUTHORITY_MAXIMUM_TIP_AGE_SECONDS,
      maximum_future_tip_seconds: configuration.HNS_AUTHORITY_MAXIMUM_FUTURE_TIP_SECONDS,
    });
  } catch {
    throw new Error("HNS activation current-view configuration is invalid");
  }
  const identityRead = makeControlPlaneHnsActivationCurrentViewIdentityRead(controlPlane);
  return (input) =>
    Effect.promise(() =>
      gatherHnsActivationCurrentViewV1(input.root_import_session_id, {
        // The identity read is its own scope; it is released before the
        // observer's network read below.
        identity: (rootImportSessionId) => Effect.runPromise(identityRead(rootImportSessionId)),
        observe_current: (rootLabel) => observer(rootLabel, "current"),
        wire_digest: async (records) => (await preflightEncodeHnsResourceV1(records)).sha256,
      }),
    );
}
