import type {
  SpacesNetworkV1,
  SpacesOperatorFundingV1,
  SpacesSaleNamespaceActivationV1,
  SpacesSaleReadinessReasonV1,
  SpacesSaleReadinessV1,
} from "@pirate/contracts";
import type {
  SpacesAuthorityDriftV1,
  SpacesAuthorityFreshnessV1,
  SpacesSaleReadinessFactsV1,
} from "@pirate/domain";
import { Data, type Effect } from "effect";
import type { HandleSalesFailure } from "./sales.ts";

/**
 * Native Spaces sale-namespace activation and readiness (spec 012 §5.3.13.3
 * and §5.3.13.4). The store is not composed into any Worker until the Spaces
 * driver is enabled; every composition stays disabled.
 */

/** The owner sees one readiness reason at a time (§5.3.13.4). */
export class SpacesSaleNamespaceNotReady extends Data.TaggedError("SpacesSaleNamespaceNotReady")<{
  readonly reason: SpacesSaleReadinessReasonV1;
}> {}

export type SpacesSaleNamespaceFailure = HandleSalesFailure | SpacesSaleNamespaceNotReady;

/** The server resolves network, roots, and every hash; the command cannot assert them. */
type SpacesSaleNamespaceCommand = Readonly<{
  accountId: string;
  communityId: string;
  idempotencyKey: string;
  namespaceAuthorityReference: string;
  expectedNamespaceAuthorityGeneration: number;
  operatorAssignmentId: string;
  expectedOperatorAssignmentGeneration: number;
  operatorFundingTermsConfirmed: true;
}>;

export type CreateSpacesSaleNamespaceInput = SpacesSaleNamespaceCommand &
  Readonly<{ activationId: string; actionId: string }>;

export type ReviseSpacesSaleNamespaceInput = SpacesSaleNamespaceCommand &
  Readonly<{
    activationId: string;
    expectedActivationHash: string;
    requestedStatus: "active" | "suspended" | "revoked";
    actionId: string;
  }>;

export type SpacesSaleNamespaceMutationResult = Readonly<{
  activation: SpacesSaleNamespaceActivationV1;
  replayed: boolean;
}>;

/** Readiness for a root the owner may activate, from its current authority and assignment. */
export type SpacesSaleNamespaceCandidateReadinessV1 = Readonly<{
  network: SpacesNetworkV1;
  canonical_root: string;
  display_root: string;
  namespace_authority_reference: string;
  namespace_authority_generation: number;
  operator_assignment: Readonly<{
    operator_assignment_id: string;
    operator_assignment_generation: number;
  }> | null;
  facts: SpacesSaleReadinessFactsV1;
  readiness: SpacesSaleReadinessV1;
}>;

export type SpacesSaleNamespaceReadinessItemV1 = Readonly<{
  activation: SpacesSaleNamespaceActivationV1;
  facts: SpacesSaleReadinessFactsV1;
  readiness: SpacesSaleReadinessV1;
}>;

/** One observation of the root from a verifier independent of the operator host. */
export type SpacesRootObservationInputV1 = Readonly<{
  canonicalRoot: string;
  observerReference: string;
  observedAt: string;
  root:
    | Readonly<{
        kind: "resolved";
        outpoint: string;
        key: string;
        anchoredAt: string;
        anchorCoversRootOutpoint: boolean;
        publication: "verified" | "failed";
        delegationAddress: string | null;
      }>
    | Readonly<{ kind: "unresolved" }>;
  commitmentHistory:
    | Readonly<{
        kind: "verified";
        commitmentCount: number;
        latestCommitmentRootHex: string | null;
      }>
    | Readonly<{ kind: "unverified" }>;
  freshness: SpacesAuthorityFreshnessV1;
}>;

export type SpacesObservationStale = Readonly<{ kind: "stale" }>;

export type SpacesRootObservationResultV1 =
  | SpacesObservationStale
  | Readonly<{
      kind: "recorded";
      observation_generation: number;
      /** Null when no active Spaces activation serves the root. */
      drift: SpacesAuthorityDriftV1 | null;
      /** The new suspended generation when the observation confirms authority loss. */
      suspended: SpacesSaleNamespaceActivationV1 | null;
    }>;

export type SpacesOperatorCapabilityObservationInputV1 = Readonly<{
  operatorAssignmentId: string;
  operatorAssignmentGeneration: number;
  observedAt: string;
  capability: "observed" | "absent";
  observationMaxAgeMs: number;
}>;

export type SpacesOperatorFundingObservationInputV1 = Readonly<{
  operatorAssignmentId: string;
  operatorAssignmentGeneration: number;
  observedAt: string;
  confirmedBalanceSats: string;
  nextCommitFeeSats: string;
}>;

export interface SpacesSaleNamespaceStore {
  readonly readCandidateReadiness: (
    input: Readonly<{ accountId: string; communityId: string; canonicalRoot: string }>,
  ) => Effect.Effect<SpacesSaleNamespaceCandidateReadinessV1 | null, HandleSalesFailure>;
  readonly createSaleNamespace: (
    input: CreateSpacesSaleNamespaceInput,
  ) => Effect.Effect<SpacesSaleNamespaceMutationResult, SpacesSaleNamespaceFailure>;
  readonly reviseSaleNamespace: (
    input: ReviseSpacesSaleNamespaceInput,
  ) => Effect.Effect<SpacesSaleNamespaceMutationResult, SpacesSaleNamespaceFailure>;
  readonly getSaleNamespaceReadiness: (
    input: Readonly<{ accountId: string; communityId: string; activationId: string }>,
  ) => Effect.Effect<SpacesSaleNamespaceReadinessItemV1 | null, HandleSalesFailure>;
  readonly recordRootObservation: (
    input: SpacesRootObservationInputV1,
  ) => Effect.Effect<SpacesRootObservationResultV1, HandleSalesFailure>;
  readonly recordOperatorCapabilityObservation: (
    input: SpacesOperatorCapabilityObservationInputV1,
  ) => Effect.Effect<
    SpacesObservationStale | Readonly<{ kind: "recorded"; observation_generation: number }>,
    HandleSalesFailure
  >;
  readonly recordFundingObservation: (
    input: SpacesOperatorFundingObservationInputV1,
  ) => Effect.Effect<
    SpacesObservationStale | Readonly<{ kind: "recorded"; funding: SpacesOperatorFundingV1 }>,
    HandleSalesFailure
  >;
}
