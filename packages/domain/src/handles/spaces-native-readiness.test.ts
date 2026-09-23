import { describe, expect, test } from "bun:test";
import {
  assessSpacesReauthorizationV1,
  classifySpacesAuthorityObservationV1,
  deriveSpacesSaleReadinessV1,
  SPACES_SALE_READINESS_REASONS_V1,
  type SpacesRootObservationV1,
  type SpacesSaleReadinessFactsV1,
  spacesAuthorityResponseV1,
} from "./spaces-native-readiness.ts";

const ready: SpacesSaleReadinessFactsV1 = {
  namespace_authority_current: true,
  owner_challenge_current: true,
  anchor_covers_root_outpoint: true,
  publication_verified: true,
  delegation_observed: true,
  operator_capability_observed: true,
  commitment_history_verified: true,
  driver_enabled: true,
};
const factForReason = {
  namespace_authority_unavailable: "namespace_authority_current",
  owner_challenge_required: "owner_challenge_current",
  anchor_pending: "anchor_covers_root_outpoint",
  publication_unverified: "publication_verified",
  delegation_required: "delegation_observed",
  operator_capability_unverified: "operator_capability_observed",
  commitment_history_unverified: "commitment_history_verified",
  driver_disabled: "driver_enabled",
} as const;

describe("Spaces sale readiness", () => {
  test("keeps the ratified reason order", () => {
    expect(SPACES_SALE_READINESS_REASONS_V1).toEqual([
      "namespace_authority_unavailable",
      "owner_challenge_required",
      "anchor_pending",
      "publication_unverified",
      "delegation_required",
      "operator_capability_unverified",
      "commitment_history_unverified",
      "driver_disabled",
    ]);
    expect(deriveSpacesSaleReadinessV1(ready)).toEqual({ kind: "ready_v1" });
  });

  test("reports each failing fact, and an unobserved fact fails closed", () => {
    for (const reason of SPACES_SALE_READINESS_REASONS_V1) {
      for (const value of [false, null]) {
        expect(
          deriveSpacesSaleReadinessV1({ ...ready, [factForReason[reason]]: value }),
          `${reason}:${value}`,
        ).toEqual({ kind: "not_ready_v1", reason });
      }
    }
  });

  test("shows only the first failing reason", () => {
    const nothingObserved = Object.fromEntries(
      Object.keys(ready).map((fact) => [fact, null]),
    ) as unknown as SpacesSaleReadinessFactsV1;
    expect(deriveSpacesSaleReadinessV1(nothingObserved)).toEqual({
      kind: "not_ready_v1",
      reason: "namespace_authority_unavailable",
    });
    expect(
      deriveSpacesSaleReadinessV1({
        ...ready,
        anchor_covers_root_outpoint: false,
        delegation_observed: false,
        driver_enabled: false,
      }),
    ).toEqual({ kind: "not_ready_v1", reason: "anchor_pending" });
    expect(
      deriveSpacesSaleReadinessV1({
        ...ready,
        commitment_history_verified: null,
        driver_enabled: false,
      }),
    ).toEqual({ kind: "not_ready_v1", reason: "commitment_history_unverified" });
  });
});

describe("Spaces authority drift", () => {
  const now = 1_790_000_000_000;
  const freshness = { observation_max_age_ms: 60_000, anchor_max_age_ms: 3_600_000 };
  const observation: SpacesRootObservationV1 = {
    observed_at_epoch_ms: now - 1_000,
    root: { kind: "resolved", outpoint: "txid:0", key: "key_a" },
    anchor: { anchored_at_epoch_ms: now - 600_000, covers_root_outpoint: true },
    delegation: "observed",
    publication: "verified",
  };
  const classify = (changed: Partial<SpacesRootObservationV1> | null) =>
    classifySpacesAuthorityObservationV1({
      evidence_root_key: "key_a",
      observation: changed === null ? null : { ...observation, ...changed },
      now_epoch_ms: now,
      freshness,
    });

  test("separates anchor lag, loss, key change, and missing observations", () => {
    expect(classify({})).toEqual({ kind: "current" });
    expect(
      classify({ anchor: { anchored_at_epoch_ms: now - 600_000, covers_root_outpoint: false } }),
    ).toEqual({ kind: "anchor_lag" });
    expect(classify(null)).toEqual({ kind: "indeterminate" });
    expect(classify({ observed_at_epoch_ms: now - 60_001 })).toEqual({ kind: "indeterminate" });
    expect(classify({ root: { kind: "unresolved" } })).toEqual({
      kind: "authority_lost",
      reason: "authority_unresolved",
    });
    expect(
      classify({ anchor: { anchored_at_epoch_ms: now - 3_600_001, covers_root_outpoint: true } }),
    ).toEqual({ kind: "authority_lost", reason: "anchor_stale" });
    expect(classify({ delegation: "absent" })).toEqual({
      kind: "authority_lost",
      reason: "delegation_lost",
    });
    expect(classify({ publication: "failed" })).toEqual({
      kind: "authority_lost",
      reason: "publication_failed",
    });
    expect(classify({ root: { kind: "resolved", outpoint: "txid:1", key: "key_b" } })).toEqual({
      kind: "key_changed",
      observed_root_key: "key_b",
    });
  });

  test("a changed key supersedes facts judged against the old evidence", () => {
    expect(
      classify({
        root: { kind: "resolved", outpoint: "txid:1", key: "key_b" },
        anchor: { anchored_at_epoch_ms: now - 600_000, covers_root_outpoint: false },
        publication: "failed",
      }),
    ).toEqual({ kind: "key_changed", observed_root_key: "key_b" });
  });

  test("responds without suspending on lag or degradation", () => {
    expect(spacesAuthorityResponseV1({ kind: "current" })).toEqual({
      stop_commerce: false,
      stop_irreversible_operator_steps: false,
      suspend_activation: false,
      require_reauthorization: false,
    });
    expect(spacesAuthorityResponseV1({ kind: "anchor_lag" })).toEqual({
      stop_commerce: true,
      stop_irreversible_operator_steps: false,
      suspend_activation: false,
      require_reauthorization: false,
    });
    expect(spacesAuthorityResponseV1({ kind: "indeterminate" })).toEqual({
      stop_commerce: true,
      stop_irreversible_operator_steps: true,
      suspend_activation: false,
      require_reauthorization: false,
    });
    expect(spacesAuthorityResponseV1({ kind: "key_changed", observed_root_key: "key_b" })).toEqual({
      stop_commerce: true,
      stop_irreversible_operator_steps: true,
      suspend_activation: false,
      require_reauthorization: true,
    });
    for (const reason of [
      "authority_unresolved",
      "anchor_stale",
      "delegation_lost",
      "publication_failed",
    ] as const) {
      expect(spacesAuthorityResponseV1({ kind: "authority_lost", reason })).toEqual({
        stop_commerce: true,
        stop_irreversible_operator_steps: true,
        suspend_activation: true,
        require_reauthorization: false,
      });
    }
  });

  test("reauthorizes a key change only by a fresh challenge from the same account", () => {
    const input = {
      activation_controlling_account_id: "account_owner_01",
      observed_root_key: "key_b",
      key_last_changed_at_epoch_ms: now - 10_000,
      challenge: {
        root_key: "key_b",
        controlling_account_id: "account_owner_01",
        completed_at_epoch_ms: now - 5_000,
      },
    };
    expect(assessSpacesReauthorizationV1(input)).toEqual({ kind: "accepted" });
    expect(assessSpacesReauthorizationV1({ ...input, challenge: null })).toEqual({
      kind: "refused",
      reason: "challenge_required",
    });
    expect(
      assessSpacesReauthorizationV1({
        ...input,
        challenge: { ...input.challenge, root_key: "key_a" },
      }),
    ).toEqual({ kind: "refused", reason: "challenge_key_mismatch" });
    expect(
      assessSpacesReauthorizationV1({
        ...input,
        challenge: { ...input.challenge, completed_at_epoch_ms: now - 10_000 },
      }),
    ).toEqual({ kind: "refused", reason: "challenge_predates_key_change" });
    expect(
      assessSpacesReauthorizationV1({
        ...input,
        challenge: { ...input.challenge, controlling_account_id: "account_other_01" },
      }),
    ).toEqual({ kind: "refused", reason: "controlling_account_changed" });
  });
});
