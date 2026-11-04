import type { Effect } from "effect";
import type {
  DurableParticipationOutcome,
  GuestParticipationStoreFailure,
  ParticipationOperationIdentity,
} from "./guest-participation-authority.ts";

/** Every numerical/global ceiling is explicit. Missing policy keeps paid composition absent. */
export type GuestResourceAdmissionPolicy = Readonly<{
  version: string;
  costPolicyVersion: string;
  maximumOwnerActiveSessions: 2;
  maximumOwnerReservedPaidCallsPerRollingDay: 60;
  maximumGlobalActiveSessions: number;
  maximumGlobalPaidCallsPerRollingDay: number;
  maximumGlobalCostMicrosPerRollingDay: string;
  maximumOwnerCostMicrosPerRollingDay: string;
  maximumTrustedEdgeSessionsPerWindow: number;
  trustedEdgeWindowSeconds: number;
  maximumProviderCallCostMicros: string;
}>;
type Result<A> = Effect.Effect<A, GuestParticipationStoreFailure>;
export type GuestResourceReservation =
  | Readonly<{
      state: "reserved";
      reservationId: string;
      sourceOwnerId: string;
      operation: ParticipationOperationIdentity;
      remainingUnits: number;
      policyVersion: string;
      costPolicyVersion: string;
    }>
  | Readonly<{
      state: "rate_limited" | "budget_refused" | "unavailable";
      retryAfterSeconds: number | null;
    }>;
export type GuestProviderCallReservation =
  | Readonly<{
      state: "reserved";
      callId: string;
      reservationId: string;
      maximumCostMicros: string;
    }>
  | Readonly<{ state: "completed"; callId: string; checkpointId: string }>
  | Readonly<{ state: "unknown"; callId: string; reservationId: string }>;
export interface GuestResourceAdmissionStore {
  readonly reserveSession: (
    input: Readonly<{
      sourceOwnerId: string;
      operation: ParticipationOperationIdentity;
      sessionId: string;
      worstCasePaidAttemptUnits: number;
      worstCaseCostMicros: string;
      trustedEdge: Readonly<{ kind: "trusted_edge"; fingerprint: string }>;
      policy: GuestResourceAdmissionPolicy;
    }>,
  ) => Result<DurableParticipationOutcome<GuestResourceReservation>>;
  readonly reserveProviderCall: (
    input: Readonly<{
      sourceOwnerId: string;
      operation: ParticipationOperationIdentity;
      sessionId: string;
      reservationId: string;
      units: number;
      maximumCostMicros: string;
      costPolicyVersion: string;
    }>,
  ) => Result<DurableParticipationOutcome<GuestProviderCallReservation>>;
  /** Provider I/O occurs outside SQL; unknown invocation keeps its allowance held. */
  readonly completeProviderCall: (
    input: Readonly<{
      sourceOwnerId: string;
      operation: ParticipationOperationIdentity;
      reservationId: string;
      callId: string;
      disposition:
        | Readonly<{ state: "completed"; checkpointId: string; costMicros: string }>
        | Readonly<{ state: "not_invoked" | "failed" | "unknown" }>;
    }>,
  ) => Result<DurableParticipationOutcome<void>>;
  readonly releaseSessionRemainder: (
    input: Readonly<{
      sourceOwnerId: string;
      operation: ParticipationOperationIdentity;
      sessionId: string;
      reservationId: string;
      authoritativeTerminalState: "completed" | "expired";
    }>,
  ) => Result<DurableParticipationOutcome<void>>;
}
