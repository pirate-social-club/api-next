import {
  classifyHnsRecoveryEvidenceV1,
  type HnsChainObservationResultV1,
  type HnsChainObservationViewV1,
  type HnsRecoveryEvidenceV1,
  type HnsRecoveryFindingV1,
  type HnsRecoveryInclusionV1,
  type HnsRetainedAuthorityReferenceV1,
  type HnsRootResourceRecordV1,
  hnsRecoveryEvidenceRefV1,
} from "@pirate/application/namespace-ownership";

/**
 * Gathers incident evidence. Read-only by construction: every port here reads,
 * none of them writes, and none of them touches the provider's mutating API.
 *
 * The chain half is deliberately not the routine observer. Establishing which
 * transaction published the current resource needs the owning outpoint, the
 * transaction that produced it, and the block that confirmed it — a name read
 * alone cannot answer it, and `info.height` is the height the name was opened
 * at, which does not move when the resource changes. A node without transaction
 * indexing simply cannot answer, and that yields no inclusion rather than a
 * guess.
 */

export type HnsIncidentNameStateV1 = Readonly<{
  /** The outpoint of the transaction that currently owns the name. */
  readonly owner_txid: string;
  readonly owner_index: number;
  /** The wire-encoded resource the name currently carries, hex. */
  readonly resource_hex: string | null;
}>;

export type HnsIncidentTransactionV1 = Readonly<{
  readonly block_hash: string | null;
  readonly confirmations: number;
  /** The covenant on the owning output, if this transaction carries one. */
  readonly covenant_action: string | null;
  readonly covenant_resource_hex: string | null;
}>;

export type HnsIncidentEvidencePortsV1 = Readonly<{
  /** hsd `getnameinfo`, reduced to the fields inclusion is derived from. */
  readonly name_state: (rootLabel: string) => Promise<HnsIncidentNameStateV1 | null>;
  /** hsd `getrawtransaction` verbose. Null when the node cannot resolve it. */
  readonly transaction: (
    txid: string,
    outputIndex: number,
  ) => Promise<HnsIncidentTransactionV1 | null>;
  /** hsd `getblockheader` verbose, reduced to the confirmed height. */
  readonly block_height: (blockHash: string) => Promise<number | null>;
  readonly observe_chain: (
    rootLabel: string,
    view: HnsChainObservationViewV1,
  ) => Promise<HnsChainObservationResultV1>;
  /** Provider availability. Null when it could not be established at all. */
  readonly zone_availability: (rootLabel: string) => Promise<Readonly<{
    readonly zone_present: boolean;
    readonly signing_keys_present: boolean;
  }> | null>;
  /**
   * The operation's retained plan digest and what it asserts on the name.
   *
   * `lifecycle_present` says whether the operation has a lifecycle row. A
   * deployment that predates the lifecycle tables can still be read and
   * classified — the chain and the provider answer four of the five questions,
   * and the plan lives in the older session tables — but a finding cannot be
   * persisted against an operation the lifecycle does not know about.
   */
  readonly retained_plan: (rootImportSessionId: string) => Promise<Readonly<{
    readonly root_label: string;
    readonly generation: number;
    readonly revision: number;
    readonly plan_encoded_sha256: string | null;
    readonly authority: HnsRetainedAuthorityReferenceV1 | null;
    readonly lifecycle_present: boolean;
  }> | null>;
  readonly decode_resource: (hex: string) => readonly HnsRootResourceRecordV1[];
  readonly sha256_hex: (hex: string) => Promise<string>;
}>;

export type HnsIncidentEvidenceReportV1 = Readonly<{
  readonly root_import_session_id: string;
  readonly root_label: string;
  readonly generation: number;
  readonly revision: number;
  /** False when no finding can be persisted for this operation. */
  readonly recordable: boolean;
  readonly evidence: HnsRecoveryEvidenceV1;
  readonly evidence_ref: string;
  readonly finding: HnsRecoveryFindingV1;
}>;

async function resolveInclusion(
  ports: HnsIncidentEvidencePortsV1,
  state: HnsIncidentNameStateV1,
): Promise<HnsRecoveryInclusionV1 | null> {
  const transaction = await ports
    .transaction(state.owner_txid, state.owner_index)
    .catch(() => null);
  if (transaction === null || transaction.block_hash === null) return null;
  if (transaction.covenant_resource_hex === null || transaction.covenant_action === null) {
    return null;
  }
  const height = await ports.block_height(transaction.block_hash).catch(() => null);
  if (height === null) return null;
  return {
    txid: state.owner_txid,
    output_index: state.owner_index,
    block_hash: transaction.block_hash,
    block_height: height,
    confirmations: transaction.confirmations,
    covenant_action: transaction.covenant_action,
    covenant_resource_sha256: await ports.sha256_hex(transaction.covenant_resource_hex),
  };
}

export async function gatherHnsIncidentEvidenceV1(
  rootImportSessionId: string,
  ports: HnsIncidentEvidencePortsV1,
): Promise<HnsIncidentEvidenceReportV1 | null> {
  const operation = await ports.retained_plan(rootImportSessionId);
  if (operation === null) return null;
  const rootLabel = operation.root_label;

  // Every read is tolerant of its own failure and reports absence, because a
  // failed read is not a finding about the name. The classifier turns any
  // absence into insufficient evidence with the reason named.
  const settle = async <A>(read: Promise<A>): Promise<A | null> => read.catch(() => null);
  const [state, current, safe, zone] = await Promise.all([
    settle(ports.name_state(rootLabel)),
    settle(ports.observe_chain(rootLabel, "current")),
    settle(ports.observe_chain(rootLabel, "safe")),
    settle(ports.zone_availability(rootLabel)),
  ]);

  const inclusion = state === null ? null : await resolveInclusion(ports, state);
  let decoded: readonly HnsRootResourceRecordV1[] | null = null;
  if (state?.resource_hex != null) {
    try {
      decoded = ports.decode_resource(state.resource_hex);
    } catch {
      // An undecodable resource is not an absent one.
      decoded = null;
    }
  }

  const evidence: HnsRecoveryEvidenceV1 = {
    inclusion,
    decoded_resource: decoded,
    retained_plan_encoded_sha256: operation.plan_encoded_sha256,
    retained_authority: operation.authority,
    current,
    safe,
    zone: zone ?? null,
  };
  return {
    root_import_session_id: rootImportSessionId,
    root_label: rootLabel,
    generation: operation.generation,
    revision: operation.revision,
    recordable: operation.lifecycle_present,
    evidence,
    evidence_ref: hnsRecoveryEvidenceRefV1(evidence),
    finding: classifyHnsRecoveryEvidenceV1(evidence),
  };
}
