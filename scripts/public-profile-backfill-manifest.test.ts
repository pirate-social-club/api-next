import { describe, expect, test } from "bun:test";
import {
  makePublicProfileBackfillManifest,
  planPublicProfileBackfill,
} from "./public-profile-backfill.ts";
import {
  manifest,
  mappedHandle,
  row,
  snapshot,
  user,
} from "./public-profile-backfill-test-fixtures.ts";

describe("public-profile historical backfill manifest", () => {
  test("uses explicit non-identity owner and handle mappings", () => {
    const legacy = row({
      global_handle_id: "legacy_handle_1",
      user_id: "legacy_user_1",
      label_normalized: "mapped-captain",
    });
    const mappedManifest = makePublicProfileBackfillManifest({
      snapshot_at: "2026-08-16T01:00:00.000Z",
      rows: [legacy],
      owner_mappings: [
        {
          legacy_user_id: "legacy_user_1",
          api_next_user_id: "api_user_9",
          legacy_owner_state: "active",
          reviewed: false,
        },
      ],
      handle_mappings: [
        { legacy_handle_id: "legacy_handle_1", api_next_handle_id: "api_handle_9" },
      ],
    });
    const plan = planPublicProfileBackfill(mappedManifest, snapshot([user("api_user_9")]));
    expect(plan.report.counts.errors).toBe(0);
    expect(plan.operations[0]).toMatchObject({
      api_next_handle_id: "api_handle_9",
      api_next_owner_user_id: "api_user_9",
    });

    const unreviewed = makePublicProfileBackfillManifest({
      snapshot_at: "2026-08-16T01:00:00.000Z",
      rows: [legacy],
      owner_mappings: [
        {
          legacy_user_id: "legacy_user_1",
          api_next_user_id: "api_user_9",
          legacy_owner_state: "merged",
          reviewed: false,
        },
      ],
      handle_mappings: [
        { legacy_handle_id: "legacy_handle_1", api_next_handle_id: "api_handle_9" },
      ],
    });
    expect(() => planPublicProfileBackfill(unreviewed, snapshot([user("api_user_9")]))).toThrow(
      "manifest-unreviewed-legacy-owner-state",
    );
  });

  test("declares and validates separate owner and handle mapping digests", () => {
    const first = row({
      global_handle_id: "gh_digest_first",
      user_id: "usr_digest_first",
      label_normalized: "digest-first",
    });
    const second = row({
      global_handle_id: "gh_digest_second",
      user_id: "usr_digest_second",
      label_normalized: "digest-second",
    });
    const source = manifest([first, second]);
    expect(source.owner_mappings_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(source.handle_mappings_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(source.owner_mappings_sha256).not.toBe(source.handle_mappings_sha256);
    expect(
      planPublicProfileBackfill(
        source,
        snapshot([user("usr_digest_first"), user("usr_digest_second")]),
      ).report.owner_mappings_sha256,
    ).toBe(source.owner_mappings_sha256);

    const tamperedMapping = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
    (tamperedMapping.owner_mappings as Array<Record<string, unknown>>)[0].api_next_user_id =
      "usr_digest_other";
    expect(() => planPublicProfileBackfill(tamperedMapping, snapshot([]))).toThrow(
      "manifest-mapping-digest-mismatch",
    );

    const reordered = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
    reordered.owner_mappings = [...(reordered.owner_mappings as unknown[])].reverse();
    expect(() => planPublicProfileBackfill(reordered, snapshot([]))).toThrow(
      "manifest-mappings-not-canonical",
    );

    const tamperedDigest = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
    tamperedDigest.handle_mappings_sha256 = "0".repeat(64);
    expect(() => planPublicProfileBackfill(tamperedDigest, snapshot([]))).toThrow(
      "manifest-mapping-digest-mismatch",
    );
  });

  test("allows reviewed merged and tombstoned owners to converge on one canonical owner", () => {
    const current = row({
      global_handle_id: "gh_canonical_current",
      user_id: "legacy_canonical",
      label_normalized: "canonical",
    });
    const mergedHistory = row({
      global_handle_id: "gh_merged_history",
      user_id: "legacy_merged",
      label_normalized: "merged-history",
      status: "redirect",
      redirect_target_global_handle_id: current.global_handle_id,
    });
    const tombstonedHistory = row({
      global_handle_id: "gh_tombstoned_history",
      user_id: "legacy_tombstoned",
      label_normalized: "tombstoned-history",
      status: "redirect",
      redirect_target_global_handle_id: current.global_handle_id,
    });
    const converged = makePublicProfileBackfillManifest({
      snapshot_at: "2026-08-16T01:00:00.000Z",
      rows: [tombstonedHistory, current, mergedHistory],
      owner_mappings: [
        {
          legacy_user_id: "legacy_canonical",
          api_next_user_id: "api_canonical",
          legacy_owner_state: "active",
          reviewed: false,
        },
        {
          legacy_user_id: "legacy_merged",
          api_next_user_id: "api_canonical",
          legacy_owner_state: "merged",
          reviewed: true,
        },
        {
          legacy_user_id: "legacy_tombstoned",
          api_next_user_id: "api_canonical",
          legacy_owner_state: "tombstoned",
          reviewed: true,
        },
      ],
      handle_mappings: [current, mergedHistory, tombstonedHistory].map((value) => ({
        legacy_handle_id: value.global_handle_id,
        api_next_handle_id: mappedHandle(value.global_handle_id),
      })),
    });
    const plan = planPublicProfileBackfill(converged, snapshot([user("api_canonical")]));
    expect(plan.report.counts).toEqual({
      inserts: 1,
      renames: 0,
      redirects: 2,
      skips: 0,
      errors: 0,
    });
  });

  test("rejects active-owner convergence, unreviewed convergence, and planned active collisions", () => {
    const first = row({
      global_handle_id: "gh_active_first",
      user_id: "legacy_active_first",
      label_normalized: "active-first",
    });
    const second = row({
      global_handle_id: "gh_active_second",
      user_id: "legacy_active_second",
      label_normalized: "active-second",
    });
    const mappings = [first, second].map((value) => ({
      legacy_user_id: value.user_id,
      api_next_user_id: "api_same_canonical",
      legacy_owner_state: "active" as const,
      reviewed: false,
    }));
    const activeCollision = makePublicProfileBackfillManifest({
      snapshot_at: "2026-08-16T01:00:00.000Z",
      rows: [first, second],
      owner_mappings: mappings,
      handle_mappings: [first, second].map((value) => ({
        legacy_handle_id: value.global_handle_id,
        api_next_handle_id: mappedHandle(value.global_handle_id),
      })),
    });
    expect(() => planPublicProfileBackfill(activeCollision, snapshot([]))).toThrow(
      "manifest-owner-mapping-not-one-to-one",
    );

    const unreviewed = makePublicProfileBackfillManifest({
      snapshot_at: "2026-08-16T01:00:00.000Z",
      rows: [first, second],
      owner_mappings: [
        mappings[0] ?? {
          legacy_user_id: first.user_id,
          api_next_user_id: "api_same_canonical",
          legacy_owner_state: "active",
          reviewed: false,
        },
        {
          legacy_user_id: second.user_id,
          api_next_user_id: "api_same_canonical",
          legacy_owner_state: "merged",
          reviewed: false,
        },
      ],
      handle_mappings: [first, second].map((value) => ({
        legacy_handle_id: value.global_handle_id,
        api_next_handle_id: mappedHandle(value.global_handle_id),
      })),
    });
    expect(() => planPublicProfileBackfill(unreviewed, snapshot([]))).toThrow(
      "manifest-unreviewed-legacy-owner-state",
    );

    const mergedActive = row({
      global_handle_id: "gh_merged_active",
      user_id: "legacy_merged_active",
      label_normalized: "merged-active",
    });
    const canonicalActive = row({
      global_handle_id: "gh_canonical_active",
      user_id: "legacy_canonical_active",
      label_normalized: "canonical-active",
    });
    const plannedCollision = makePublicProfileBackfillManifest({
      snapshot_at: "2026-08-16T01:00:00.000Z",
      rows: [mergedActive, canonicalActive],
      owner_mappings: [
        {
          legacy_user_id: canonicalActive.user_id,
          api_next_user_id: "api_planned_canonical",
          legacy_owner_state: "active",
          reviewed: false,
        },
        {
          legacy_user_id: mergedActive.user_id,
          api_next_user_id: "api_planned_canonical",
          legacy_owner_state: "merged",
          reviewed: true,
        },
      ],
      handle_mappings: [mergedActive, canonicalActive].map((value) => ({
        legacy_handle_id: value.global_handle_id,
        api_next_handle_id: mappedHandle(value.global_handle_id),
      })),
    });
    const report = planPublicProfileBackfill(
      plannedCollision,
      snapshot([user("api_planned_canonical")]),
    ).report;
    expect(report.issue_counts["active-owner-collision"]).toBe(2);
  });

  test("validates metadata without persisting it", () => {
    const paid = row({
      global_handle_id: "gh_paid",
      user_id: "usr_paid",
      label_normalized: "paid-captain",
      price_paid_cents: 12_500,
      free_rename_consumed: 1,
    });
    const plan = planPublicProfileBackfill(manifest([paid]), snapshot([user("usr_paid")]));
    expect(plan.report.omitted_source_fields).toEqual([
      "tier",
      "issuance_source",
      "price_paid_cents",
      "free_rename_consumed",
      "issued_at",
      "replaced_at",
      "created_at",
      "updated_at",
    ]);
    const invalidPrice = JSON.parse(JSON.stringify(manifest([paid]))) as Record<string, unknown>;
    (invalidPrice.rows as Array<Record<string, unknown>>)[0].price_paid_cents = -1;
    expect(() => planPublicProfileBackfill(invalidPrice, snapshot([user("usr_paid")]))).toThrow(
      "manifest-invalid-row-value",
    );
  });
});
