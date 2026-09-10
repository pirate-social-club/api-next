import type { HnsChainObservationResultV1 } from "./hns-chain-observation.ts";
import type { HnsRootResourceRecordV1 } from "./hns-root-import-plan.ts";

/**
 * The activation current-view gatherer — spec 012, "Execution ownership and
 * readiness handover" and "Activation and the public contract".
 *
 * The sequence is fixed and the order is the point: read the operation's
 * authoritative identity (root, revision, generation and the generation-bound
 * encoded-resource digest) in one database scope, release that scope, observe
 * the current chain view outside any transaction, then encode the observed
 * records with the real wire codec to obtain the digest the activation gate
 * compares. A provider read never runs inside a database transaction, and a
 * binding is never returned for evidence that was not observed.
 *
 * Confirmed conflicting control and unavailable provider evidence stay
 * distinct here. A `finding` about the name is a conflict; every other
 * classification is an outage and is reported as unavailable, so a caller
 * cannot read an outage as a fact about the name. The observation's
 * canonical-JSON digest is a different field and is not used for activation
 * qualification.
 *
 * After adoption the identity's `plan_encoded_resource_sha256` is the adopted
 * generation's digest, so qualification follows the current generation and
 * the original exposed plan remains historical evidence.
 */

export type HnsActivationCurrentViewIdentityV1 = Readonly<{
  readonly root_label: string;
  readonly lifecycle_revision: number;
  readonly lifecycle_generation: number;
  /** The effective, generation-bound encoded-resource digest, when exposed. */
  readonly plan_encoded_resource_sha256: string | null;
}>;

export type HnsActivationCurrentViewBindingV1 = Readonly<{
  readonly lifecycle_revision: number;
  readonly lifecycle_generation: number;
  readonly observed_at_epoch_ms: number;
  /** The wire digest of the observed records, not their canonical-JSON digest. */
  readonly resource_sha256: string;
  readonly qualifying: boolean;
}>;

export type HnsActivationCurrentViewGatherResultV1 =
  | Readonly<{ readonly kind: "gathered"; readonly binding: HnsActivationCurrentViewBindingV1 }>
  | Readonly<{ readonly kind: "operation_absent" }>
  | Readonly<{
      readonly kind: "conflict";
      readonly classification: "resource_absent" | "resource_mismatch";
    }>
  | Readonly<{ readonly kind: "unavailable"; readonly classification: string }>;

export type HnsActivationCurrentViewPortsV1 = Readonly<{
  /**
   * Reads the operation's identity in its own database scope. The scope is
   * released when this promise settles; no transaction is held across the
   * chain read below.
   */
  readonly identity: (
    rootImportSessionId: string,
  ) => Promise<HnsActivationCurrentViewIdentityV1 | null>;
  readonly observe_current: (rootLabel: string) => Promise<HnsChainObservationResultV1>;
  /** The real wire codec's digest for the observed records. */
  readonly wire_digest: (records: readonly HnsRootResourceRecordV1[]) => Promise<string>;
}>;

export async function gatherHnsActivationCurrentViewV1(
  rootImportSessionId: string,
  ports: HnsActivationCurrentViewPortsV1,
): Promise<HnsActivationCurrentViewGatherResultV1> {
  let identity: HnsActivationCurrentViewIdentityV1 | null;
  try {
    identity = await ports.identity(rootImportSessionId);
  } catch {
    return { kind: "unavailable", classification: "transport_failure" };
  }
  if (identity === null) return { kind: "operation_absent" };

  let observed: HnsChainObservationResultV1 | null;
  try {
    observed = await ports.observe_current(identity.root_label);
  } catch {
    return { kind: "unavailable", classification: "transport_failure" };
  }
  if (observed.kind === "unavailable") {
    return { kind: "unavailable", classification: observed.classification };
  }
  if (observed.kind === "finding") {
    // A finding is a fact about the name; it is not an outage.
    return { kind: "conflict", classification: observed.classification };
  }

  let digest: string | null;
  try {
    digest = await ports.wire_digest(observed.observation.records);
  } catch {
    // An observed resource that cannot be re-encoded is unavailable evidence,
    // never a silent qualification.
    return { kind: "unavailable", classification: "malformed_response" };
  }
  if (digest === null || !/^[0-9a-f]{64}$/u.test(digest)) {
    return { kind: "unavailable", classification: "malformed_response" };
  }
  return {
    kind: "gathered",
    binding: {
      lifecycle_revision: identity.lifecycle_revision,
      lifecycle_generation: identity.lifecycle_generation,
      observed_at_epoch_ms: observed.observation.observed_at_epoch_ms,
      resource_sha256: digest,
      qualifying:
        identity.plan_encoded_resource_sha256 !== null &&
        digest === identity.plan_encoded_resource_sha256,
    },
  };
}
