import type {
  SpacesFinalIssuanceVerifier,
  SpacesReconciliationStore,
  SpacesSaleNamespaceStore,
} from "@pirate/application";
import type { JobsWorkerConfigValue } from "@pirate/platform-cf/config";
import type { makeHyperdriveControlPlaneLayer } from "@pirate/platform-cf/postgres";
import { makeSpacesFinalIssuanceVerifier } from "@pirate/platform-cf/spaces-final-issuance-verifier";
import type { SpacesRootAuthorityObserver } from "@pirate/platform-cf/spaces-owner-proof-repository";
import { makeControlPlaneSpacesReconciliationStore } from "@pirate/platform-cf/spaces-reconciliation-repository";
import { makeSpacesRootAuthorityObserver } from "@pirate/platform-cf/spaces-root-authority-observer";
import {
  makeSpacesRootObservationTargets,
  type SpacesRootObservationTargets,
} from "@pirate/platform-cf/spaces-root-observation-targets";
import { makeControlPlaneSpacesSaleNamespaceStore } from "@pirate/platform-cf/spaces-sale-namespace-repository";

export type SpacesReconciliationBindings = Readonly<{
  SPACES_RECONCILIATION_ENABLED?: string;
  SPACES_RECONCILIATION_OVERDUE_SECONDS?: string;
  SPACES_RECONCILIATION_MEASUREMENT_REFERENCE?: string;
  SPACES_VERIFIER_ACCESS_CLIENT_ID?: string;
  SPACES_VERIFIER_ACCESS_CLIENT_SECRET?: string;
  SPACES_VERIFIER_BEARER_TOKEN?: string;
}>;

export type SpacesReconciliationComposition = Readonly<{
  store: SpacesReconciliationStore;
  verifier: SpacesFinalIssuanceVerifier;
  rootObservation: Readonly<{
    targets: SpacesRootObservationTargets;
    observer: SpacesRootAuthorityObserver;
    saleNamespaces: SpacesSaleNamespaceStore;
  }>;
  overdueThresholdSeconds: number;
  measurementReference: string;
}>;

/** Disabled unless the staging pilot explicitly supplies a measured policy and verifier credentials. */
export function makeSpacesReconciliationComposition(
  bindings: SpacesReconciliationBindings,
  runtime: ReturnType<typeof makeHyperdriveControlPlaneLayer>,
  environment: JobsWorkerConfigValue["API_NEXT_ENV"],
): SpacesReconciliationComposition | undefined {
  const flag = bindings.SPACES_RECONCILIATION_ENABLED;
  if (flag === undefined || flag === "false") return undefined;
  if (flag !== "true" || environment !== "staging") {
    throw new Error("Spaces reconciliation configuration is invalid");
  }
  const threshold = bindings.SPACES_RECONCILIATION_OVERDUE_SECONDS;
  if (threshold === undefined || !/^[1-9][0-9]{0,7}$/u.test(threshold)) {
    throw new Error("Spaces reconciliation overdue threshold is invalid");
  }
  const overdueThresholdSeconds = Number(threshold);
  if (overdueThresholdSeconds > 31_536_000) {
    throw new Error("Spaces reconciliation overdue threshold is invalid");
  }
  const measurementReference = bindings.SPACES_RECONCILIATION_MEASUREMENT_REFERENCE;
  if (measurementReference === undefined || measurementReference.trim().length === 0) {
    throw new Error("Spaces reconciliation measurement reference is required");
  }
  const credentials = {
    accessClientId: bindings.SPACES_VERIFIER_ACCESS_CLIENT_ID ?? "",
    accessClientSecret: bindings.SPACES_VERIFIER_ACCESS_CLIENT_SECRET ?? "",
    bearerToken: bindings.SPACES_VERIFIER_BEARER_TOKEN ?? "",
  };
  return {
    store: makeControlPlaneSpacesReconciliationStore(runtime),
    verifier: makeSpacesFinalIssuanceVerifier(credentials),
    rootObservation: {
      targets: makeSpacesRootObservationTargets(runtime),
      observer: makeSpacesRootAuthorityObserver(credentials),
      saleNamespaces: makeControlPlaneSpacesSaleNamespaceStore(runtime),
    },
    overdueThresholdSeconds,
    measurementReference,
  };
}
