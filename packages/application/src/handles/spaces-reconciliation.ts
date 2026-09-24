import type { SpacesNetworkV1 } from "@pirate/domain";
import type { Effect } from "effect";
import type { HandleSalesStorageFailed } from "./sales.ts";

/** One due claim leased from the database before calling an independent verifier. */
export type SpacesVerificationTargetV1 = Readonly<{
  claim_id: string;
  lease_token: string;
  network: SpacesNetworkV1;
  namespace_root: string;
  handle_label: string;
  script_pubkey_hex: string;
}>;

/** The adapter may report final only after checking the certificate, exact
 * recipient, valid commitment history and tip height against mined height. */
export type SpacesFinalIssuanceV1 = Readonly<{
  certificate_sha256_hex: string;
  commitment_root_hex: string;
  mined_height: number;
  verified_tip_height: number;
  verifier_id: string;
  verifier_version: string;
  observed_at: string;
}>;

export type SpacesVerificationResultV1 =
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "final"; evidence: SpacesFinalIssuanceV1 }>
  | Readonly<{
      kind: "occupied_other";
      observed_script_pubkey_hex: string;
      evidence: SpacesFinalIssuanceV1;
    }>;

/** The verifier is independent of the operator host. A missing adapter never
 * makes a claim fail or creates a grant; the job is not composed in that case. */
export interface SpacesFinalIssuanceVerifier {
  readonly verify: (
    target: SpacesVerificationTargetV1,
  ) => Effect.Effect<SpacesVerificationResultV1, Error>;
}

export interface SpacesReconciliationStore {
  /** Mark only pending claims older than the measured operating threshold. */
  readonly markOverdue: (
    thresholdSeconds: number,
    capacity: number,
  ) => Effect.Effect<readonly string[], HandleSalesStorageFailed>;
  readonly unalertedOverdue: (
    capacity: number,
  ) => Effect.Effect<readonly string[], HandleSalesStorageFailed>;
  readonly markOverdueAlerted: (claimId: string) => Effect.Effect<void, HandleSalesStorageFailed>;
  readonly unalertedScopeAnomalies: (
    capacity: number,
  ) => Effect.Effect<
    readonly Readonly<{ anomaly_id: string; reason: string }>[],
    HandleSalesStorageFailed
  >;
  readonly markScopeAnomalyAlerted: (
    anomalyId: string,
  ) => Effect.Effect<void, HandleSalesStorageFailed>;
  readonly leaseDue: (
    capacity: number,
  ) => Effect.Effect<readonly SpacesVerificationTargetV1[], HandleSalesStorageFailed>;
  readonly retryLater: (
    target: SpacesVerificationTargetV1,
  ) => Effect.Effect<"scheduled" | "stale", HandleSalesStorageFailed>;
  readonly finalize: (
    target: SpacesVerificationTargetV1,
    evidence: SpacesFinalIssuanceV1,
  ) => Effect.Effect<"issued" | "stale", HandleSalesStorageFailed>;
  readonly recordConflict: (
    target: SpacesVerificationTargetV1,
    observedScriptPubkeyHex: string,
    evidence: SpacesFinalIssuanceV1,
  ) => Effect.Effect<"conflict" | "stale", HandleSalesStorageFailed>;
}
