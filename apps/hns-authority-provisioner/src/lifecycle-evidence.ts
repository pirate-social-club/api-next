import {
  type HnsChainObservationResultV1,
  type HnsChainObservationViewV1,
  hnsChainObservationIsFindingV1,
  hnsObservedResourceMatchesEncodedPlanV1,
} from "@pirate/application/namespace-ownership";
import type { HnsLifecycleEvidenceV1 } from "./lifecycle-executor.ts";

/**
 * Turns one real chain observation into lifecycle evidence.
 *
 * This is the seam the composed path runs through, and it is where two
 * distinctions that have each already caused a defect are enforced in one
 * place.
 *
 * Qualification compares the observed records' *wire* digest against the
 * retained plan's encoded digest. The observation also carries a canonical-JSON
 * digest of the same records; the two hash different byte sequences and can
 * never be equal, so comparing them produces a check that is always false.
 *
 * A finding about the name and unavailable evidence are different kinds of
 * fact. Only `resource_absent` and `resource_mismatch` describe the name;
 * every other class is an outage and becomes a provider failure, which
 * preserves the phase and the readiness evidence. An outage is not proof that
 * control changed.
 */

export type HnsLifecycleEvidencePortsV1 = Readonly<{
  readonly observe_chain: (
    rootLabel: string,
    view: HnsChainObservationViewV1,
  ) => Promise<HnsChainObservationResultV1>;
}>;

/** A stable reference for one observation, so replays are recognised. */
function evidenceRef(view: HnsChainObservationViewV1, result: HnsChainObservationResultV1): string {
  if (result.kind === "observed") {
    return `${view}:${result.observation.anchor.height}:${result.observation.resource_sha256.slice(0, 16)}`;
  }
  if (result.kind === "finding") return `${view}:finding:${result.classification}`;
  return `${view}:unavailable:${result.classification}`;
}

async function hnsLifecycleEvidenceFromObservationV1(
  view: HnsChainObservationViewV1,
  result: HnsChainObservationResultV1,
  planEncodedResourceSha256: string | null,
): Promise<HnsLifecycleEvidenceV1> {
  const ref = evidenceRef(view, result);
  if (result.kind === "unavailable") {
    return {
      kind: "provider_failure",
      classification: result.classification,
      budget_exempt: false,
      evidence_ref: ref,
    };
  }
  if (result.kind === "finding") {
    // A finding about the name. `resource_mismatch` and `resource_absent` are
    // both non-qualifying; the distinction is carried so the reducer can say
    // which it was.
    const mismatch = result.classification === "resource_mismatch";
    return view === "current"
      ? {
          kind: "current_observation",
          qualifying: false,
          mismatch,
          resource_sha256: null,
          evidence_ref: ref,
        }
      : {
          kind: "safe_observation",
          qualifying: false,
          bracket_observed_at_epoch_ms: Date.now(),
          evidence_ref: ref,
        };
  }
  if (!hnsChainObservationIsFindingV1("resource_absent")) {
    // Defensive: the classification vocabulary is shared with the observer.
    throw new Error("HNS chain observation vocabulary changed");
  }
  const qualifying =
    planEncodedResourceSha256 !== null &&
    (await hnsObservedResourceMatchesEncodedPlanV1(
      result.observation.records,
      planEncodedResourceSha256,
    ));
  return view === "current"
    ? {
        kind: "current_observation",
        qualifying,
        mismatch: !qualifying,
        resource_sha256: result.observation.resource_sha256,
        evidence_ref: ref,
      }
    : {
        kind: "safe_observation",
        qualifying,
        bracket_observed_at_epoch_ms: result.observation.observed_at_epoch_ms,
        evidence_ref: ref,
      };
}

/** The executor's observe port, backed by a real chain observer. */
export function makeHnsLifecycleObservePort(ports: HnsLifecycleEvidencePortsV1) {
  return async (
    job: Readonly<{ readonly job_kind: string }>,
    identity: Readonly<{
      readonly root_label: string;
      readonly plan_encoded_resource_sha256: string | null;
    }>,
  ): Promise<HnsLifecycleEvidenceV1> => {
    const view: HnsChainObservationViewV1 | null =
      job.job_kind === "observe_current"
        ? "current"
        : job.job_kind === "observe_safe"
          ? "safe"
          : null;
    if (view === null) {
      return { kind: "none", evidence_ref: `unsupported:${job.job_kind}` };
    }
    const result = await ports.observe_chain(identity.root_label, view);
    return hnsLifecycleEvidenceFromObservationV1(
      view,
      result,
      identity.plan_encoded_resource_sha256,
    );
  };
}
