import { canonicalJson } from "@pirate/domain";
import type { HnsRootResourceRecordV1 } from "./hns-root-import-plan.ts";

/**
 * Typed HNS chain observation model — spec 012, "Observation evidence model"
 * (2026-09-09 amendment). Chain observations are typed as current or safe
 * views, never one conflated read. Only `resource_absent` and
 * `resource_mismatch` are findings about the name; every other class is
 * unavailable evidence that preserves the lifecycle phase.
 */

export type HnsChainObservationViewV1 = "current" | "safe";

export type HnsChainObservationClassV1 =
  | "resource_absent"
  | "resource_mismatch"
  | "chain_moving"
  | "node_stale"
  | "node_unavailable"
  | "wrong_network"
  | "malformed_response"
  | "transport_failure";

export const HNS_CHAIN_UNAVAILABLE_CLASSES_V1: ReadonlySet<HnsChainObservationClassV1> =
  new Set<HnsChainObservationClassV1>([
    "chain_moving",
    "node_stale",
    "node_unavailable",
    "wrong_network",
    "malformed_response",
    "transport_failure",
  ]);

/** The two classifications that are findings about the name itself. */
export const HNS_CHAIN_FINDING_CLASSES_V1: ReadonlySet<HnsChainObservationClassV1> =
  new Set<HnsChainObservationClassV1>(["resource_absent", "resource_mismatch"]);

/** True when the class is a finding about the name, not unavailable evidence. */
export function hnsChainObservationIsFindingV1(
  classification: HnsChainObservationClassV1,
): boolean {
  return HNS_CHAIN_FINDING_CLASSES_V1.has(classification);
}

/**
 * One anchor of the observation bracket: the node's view of its own best
 * block at the moment of the read. Two equal brackets around the name reads
 * are required before any observation qualifies.
 */
export type HnsChainObservationAnchorV1 = Readonly<{
  readonly network: string;
  readonly genesis_block_hash: string;
  readonly height: number;
  readonly best_block_hash: string;
  readonly median_time_past_epoch_seconds: number;
  readonly header_time_epoch_seconds: number;
  readonly confirmations: number;
}>;

export function sameHnsChainObservationAnchorV1(
  left: HnsChainObservationAnchorV1,
  right: HnsChainObservationAnchorV1,
): boolean {
  return (
    left.network === right.network &&
    left.genesis_block_hash === right.genesis_block_hash &&
    left.height === right.height &&
    left.best_block_hash === right.best_block_hash &&
    left.median_time_past_epoch_seconds === right.median_time_past_epoch_seconds &&
    left.header_time_epoch_seconds === right.header_time_epoch_seconds &&
    left.confirmations === right.confirmations
  );
}

/**
 * The Urkel tree commitment a safe observation resolved the name through.
 * `selection_basis` records how it was selected; `tree_interval_blocks` and
 * `minimum_confirmations` retain the pinned network facts behind the
 * selection so the height derivation stays auditable.
 */
export type HnsSafeCommitmentSelectionV1 = Readonly<{
  readonly selection_basis: "hsd_getsaferoot_compatible";
  readonly commitment_height: number;
  readonly commitment_block_hash: string;
  readonly commitment_tree_root: string;
  readonly tip_height: number;
  readonly tree_interval_blocks: number;
  readonly minimum_confirmations: number;
}>;

/**
 * Computes the HSD `getSafeRoot()` commitment height from the tip height.
 * The tree is committed every `tree_interval_blocks`; a commitment with at
 * least `minimum_confirmations` blocks on top is safe. Mirrors
 * hsd Chain.getSafeRoot: with interval T, H the tip height and
 * mod = H % T, the safe height is H when mod >= 12, else H - mod.
 */
export function hsdSafeCommitmentHeightV1(
  tipHeight: number,
  treeIntervalBlocks: number,
  minimumConfirmations: number,
): number {
  if (
    !Number.isSafeInteger(tipHeight) ||
    tipHeight < 0 ||
    !Number.isSafeInteger(treeIntervalBlocks) ||
    treeIntervalBlocks < 1 ||
    !Number.isSafeInteger(minimumConfirmations) ||
    minimumConfirmations < 0
  ) {
    throw new Error("HSD safe commitment height inputs are invalid");
  }
  let modulo = tipHeight % treeIntervalBlocks;
  if (modulo >= minimumConfirmations) modulo = 0;
  return tipHeight - modulo;
}

/**
 * A qualified chain observation. Current observations read the node's best
 * block (`safe=false`); safe observations resolve the name through the
 * selected safe commitment (`safe=true`) and additionally retain the
 * commitment selection. Tip height, UPDATE inclusion height, and commitment
 * height are distinct fields; conflating them is a defect.
 */
export type HnsChainObservationV1 = Readonly<{
  readonly view: HnsChainObservationViewV1;
  readonly network: string;
  readonly genesis_block_hash: string;
  readonly anchor: HnsChainObservationAnchorV1;
  readonly tip_height: number;
  readonly update_inclusion_height: number | null;
  readonly commitment: HnsSafeCommitmentSelectionV1 | null;
  readonly observed_at_epoch_ms: number;
  readonly records: readonly HnsRootResourceRecordV1[];
  readonly resource_sha256: string;
}>;

/**
 * The outcome of one observation attempt. `observed` carries qualified
 * evidence (an active name; its complete decoded resource, possibly empty).
 * `finding` carries a name finding — `resource_absent` (the name is not
 * active so no resource can exist) or `resource_mismatch` (a decoded
 * resource that differs from an expected digest, classified by the
 * comparison step). `unavailable` classes preserve the phase: no result is
 * inferred from unavailable evidence.
 */
export type HnsChainObservationResultV1 =
  | Readonly<{ readonly kind: "observed"; readonly observation: HnsChainObservationV1 }>
  | Readonly<{
      readonly kind: "finding";
      readonly classification: "resource_absent" | "resource_mismatch";
      readonly anchor: HnsChainObservationAnchorV1;
      readonly observed_at_epoch_ms: number;
    }>
  | Readonly<{
      readonly kind: "unavailable";
      readonly classification: Exclude<
        HnsChainObservationClassV1,
        "resource_absent" | "resource_mismatch"
      >;
    }>;

const encoder = new TextEncoder();

export async function hnsChainResourceDigestV1(
  records: readonly HnsRootResourceRecordV1[],
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(canonicalJson(records)).buffer as ArrayBuffer,
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
