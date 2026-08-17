import { describe, expect, test } from "bun:test";
import {
  type LegacyGlobalHandleRow,
  makePublicProfileBackfillManifest,
  makePublicProfileTargetSnapshot,
  type PublicProfileBackfillTransaction,
  type PublicProfileTargetHandle,
  type PublicProfileTargetUser,
  planPublicProfileBackfill,
  runPublicProfileBackfill,
} from "./public-profile-backfill.ts";

const dates = {
  issued_at: "2026-08-16T00:00:00.000Z",
  replaced_at: null,
  created_at: "2026-08-16T00:00:00.000Z",
  updated_at: "2026-08-16T00:00:00.000Z",
} as const;

function row(
  input: Partial<LegacyGlobalHandleRow> &
    Pick<LegacyGlobalHandleRow, "global_handle_id" | "user_id" | "label_normalized">,
): LegacyGlobalHandleRow {
  const { global_handle_id, user_id, label_normalized, ...overrides } = input;
  return {
    global_handle_id,
    user_id,
    label_normalized,
    label_display: `${label_normalized}.pirate`,
    status: "active",
    tier: "standard",
    issuance_source: "generated_signup",
    redirect_target_global_handle_id: null,
    price_paid_cents: null,
    free_rename_consumed: 0,
    ...dates,
    ...overrides,
  };
}

function user(user_id: string, status: "active" | "deleted" = "active"): PublicProfileTargetUser {
  return { user_id, status };
}

function targetHandle(
  input: Partial<PublicProfileTargetHandle> &
    Pick<PublicProfileTargetHandle, "handle_id" | "owner_user_id" | "label_normalized">,
): PublicProfileTargetHandle {
  const { handle_id, owner_user_id, label_normalized, ...overrides } = input;
  return {
    handle_id,
    owner_user_id,
    label_normalized,
    label_display: `${label_normalized}.pirate`,
    status: "active",
    redirect_target_handle_id: null,
    ...overrides,
  };
}

function manifest(rows: readonly LegacyGlobalHandleRow[]) {
  const ownerIds = [...new Set(rows.map((value) => value.user_id))].sort();
  return makePublicProfileBackfillManifest({
    snapshot_at: "2026-08-16T01:00:00.000Z",
    rows,
    owner_mappings: ownerIds.map((legacy_user_id) => ({
      legacy_user_id,
      api_next_user_id: legacy_user_id,
      legacy_owner_state: "active",
      reviewed: false,
    })),
    handle_mappings: rows.map((value) => ({
      legacy_handle_id: value.global_handle_id,
      api_next_handle_id: `target_${value.global_handle_id}`,
    })),
  });
}

function mappedHandle(handleId: string): string {
  return `target_${handleId}`;
}

function snapshot(
  users: readonly PublicProfileTargetUser[],
  handles: readonly PublicProfileTargetHandle[] = [],
) {
  return makePublicProfileTargetSnapshot({
    captured_at: "2026-08-16T02:00:00.000Z",
    users,
    handles,
  });
}

describe("public-profile historical backfill planner", () => {
  test("seeds a current label and its historical redirect target", () => {
    const current = row({
      global_handle_id: "gh_current",
      user_id: "usr_one",
      label_normalized: "captain",
    });
    const historical = row({
      global_handle_id: "gh_old",
      user_id: "usr_one",
      label_normalized: "old-captain",
      status: "redirect",
      redirect_target_global_handle_id: "gh_current",
    });
    const plan = planPublicProfileBackfill(
      manifest([historical, current]),
      snapshot([user("usr_one")]),
    );
    expect(plan.report.counts).toEqual({
      inserts: 1,
      renames: 0,
      redirects: 1,
      skips: 0,
      errors: 0,
    });
    expect(plan.operations.map(({ kind, row: value }) => [kind, value.global_handle_id])).toEqual([
      ["insert", "gh_current"],
      ["redirect", "gh_old"],
    ]);
  });

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

  test("validates legacy metadata without persisting it", () => {
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

  test("rejects invalid labels and does not normalize or invent them", () => {
    const invalid = row({
      global_handle_id: "gh_invalid",
      user_id: "usr_one",
      label_normalized: "Not A Pirate",
      label_display: "Not A Pirate.pirate",
    });
    const plan = planPublicProfileBackfill(manifest([invalid]), snapshot([user("usr_one")]));
    expect(plan.report.counts.errors).toBe(1);
    expect(plan.report.issue_counts["invalid-source-label"]).toBe(1);
    expect(plan.operations).toEqual([]);
  });

  test("rejects missing, deleted, and foreign owners", () => {
    const missing = row({
      global_handle_id: "gh_missing",
      user_id: "usr_missing",
      label_normalized: "missing",
    });
    const deleted = row({
      global_handle_id: "gh_deleted",
      user_id: "usr_deleted",
      label_normalized: "deleted",
    });
    const foreignCurrent = row({
      global_handle_id: "gh_foreign",
      user_id: "usr_two",
      label_normalized: "foreign",
    });
    const foreignRedirect = row({
      global_handle_id: "gh_foreign_redirect",
      user_id: "usr_one",
      label_normalized: "foreign-redirect",
      status: "redirect",
      redirect_target_global_handle_id: "gh_foreign",
    });
    const plan = planPublicProfileBackfill(
      manifest([missing, deleted, foreignCurrent, foreignRedirect]),
      snapshot([user("usr_one"), user("usr_deleted", "deleted"), user("usr_two")]),
    );
    expect(plan.report.issue_counts["missing-owner"]).toBe(1);
    expect(plan.report.issue_counts["owner-not-active"]).toBe(1);
    expect(plan.report.issue_counts["foreign-owner"]).toBe(1);
    expect(plan.report.counts.errors).toBe(3);
  });

  test("rejects active owner and target label/ownership collisions", () => {
    const first = row({
      global_handle_id: "gh_first",
      user_id: "usr_one",
      label_normalized: "first",
    });
    const second = row({
      global_handle_id: "gh_second",
      user_id: "usr_one",
      label_normalized: "second",
    });
    const existingLabel = row({
      global_handle_id: "gh_label",
      user_id: "usr_two",
      label_normalized: "label",
    });
    const transfer = row({
      global_handle_id: "gh_transfer",
      user_id: "usr_one",
      label_normalized: "transfer",
    });
    const plan = planPublicProfileBackfill(
      manifest([first, second, existingLabel, transfer]),
      snapshot(
        [user("usr_one"), user("usr_two")],
        [
          targetHandle({
            handle_id: mappedHandle("gh_existing"),
            owner_user_id: "usr_two",
            label_normalized: "label",
          }),
          targetHandle({
            handle_id: mappedHandle("gh_transfer"),
            owner_user_id: "usr_two",
            label_normalized: "transfer",
          }),
        ],
      ),
    );
    expect(plan.report.issue_counts["active-owner-collision"]).toBe(3);
    expect(plan.report.issue_counts["target-label-collision"]).toBe(1);
    expect(plan.report.issue_counts["ownership-transfer"]).toBe(1);
    expect(plan.operations).toHaveLength(2);
  });

  test("rejects cycles, missing targets, and non-active redirect targets", () => {
    const cycleA = row({
      global_handle_id: "gh_cycle_a",
      user_id: "usr_one",
      label_normalized: "cycle-a",
      status: "redirect",
      redirect_target_global_handle_id: "gh_cycle_b",
    });
    const cycleB = row({
      global_handle_id: "gh_cycle_b",
      user_id: "usr_one",
      label_normalized: "cycle-b",
      status: "redirect",
      redirect_target_global_handle_id: "gh_cycle_a",
    });
    const missing = row({
      global_handle_id: "gh_missing_target",
      user_id: "usr_one",
      label_normalized: "missing-target",
      status: "redirect",
      redirect_target_global_handle_id: "gh_not_exported",
    });
    const retiredTarget = row({
      global_handle_id: "gh_retired_source",
      user_id: "usr_one",
      label_normalized: "retired-source",
      status: "redirect",
      redirect_target_global_handle_id: "gh_retired",
    });
    const retired = row({
      global_handle_id: "gh_retired",
      user_id: "usr_one",
      label_normalized: "retired",
      status: "retired",
    });
    const plan = planPublicProfileBackfill(
      manifest([cycleA, cycleB, missing, retiredTarget, retired]),
      snapshot(
        [user("usr_one")],
        [
          targetHandle({
            handle_id: mappedHandle("gh_retired"),
            owner_user_id: "usr_one",
            label_normalized: "retired",
            status: "retired",
          }),
        ],
      ),
    );
    expect(plan.report.issue_counts["redirect-cycle"]).toBe(2);
    expect(plan.report.issue_counts["redirect-target-missing"]).toBe(1);
    expect(plan.report.issue_counts["redirect-target-not-active"]).toBe(1);
    expect(plan.operations).toEqual([]);
  });

  test("is idempotent for an exact current/redirect seed and reports skips", () => {
    const current = row({
      global_handle_id: "gh_current",
      user_id: "usr_one",
      label_normalized: "captain",
    });
    const historical = row({
      global_handle_id: "gh_old",
      user_id: "usr_one",
      label_normalized: "old-captain",
      status: "redirect",
      redirect_target_global_handle_id: "gh_current",
    });
    const target = snapshot(
      [user("usr_one")],
      [
        targetHandle({
          handle_id: mappedHandle(current.global_handle_id),
          owner_user_id: current.user_id,
          label_normalized: current.label_normalized,
        }),
        targetHandle({
          handle_id: mappedHandle(historical.global_handle_id),
          owner_user_id: historical.user_id,
          label_normalized: historical.label_normalized,
          status: "redirect",
          redirect_target_handle_id: mappedHandle(
            historical.redirect_target_global_handle_id ?? "",
          ),
        }),
      ],
    );
    const plan = planPublicProfileBackfill(manifest([historical, current]), target);
    expect(plan.operations).toEqual([]);
    expect(plan.report.counts).toEqual({
      inserts: 0,
      renames: 0,
      redirects: 0,
      skips: 2,
      errors: 0,
    });
  });

  test("does not write during dry-run and rejects manifest tampering", async () => {
    const current = row({
      global_handle_id: "gh_current",
      user_id: "usr_one",
      label_normalized: "captain",
    });
    const source = manifest([current]);
    const tampered = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
    const tamperedRows = tampered.rows as Array<Record<string, unknown>>;
    tamperedRows[0] = { ...tamperedRows[0], label_display: "tampered.pirate" };
    const tamperedTarget = snapshot([user("usr_one")]);
    expect(() => planPublicProfileBackfill(tampered, tamperedTarget)).toThrow(
      "manifest-source-digest-mismatch",
    );

    const result = await runPublicProfileBackfill({
      mode: "dry-run",
      manifest: source,
      target: snapshot([user("usr_one")]),
    });
    expect(result.applied).toBe(0);
  });

  test("CLI exits nonzero when a dry-run report contains validation errors", async () => {
    const invalid = row({
      global_handle_id: "gh_cli_invalid",
      user_id: "usr_one",
      label_normalized: "Invalid Label",
      label_display: "Invalid Label.pirate",
    });
    const suffix = crypto.randomUUID();
    const manifestPath = `/tmp/public-profile-backfill-manifest-${suffix}.json`;
    const targetPath = `/tmp/public-profile-backfill-target-${suffix}.json`;
    await Bun.write(manifestPath, JSON.stringify(manifest([invalid])));
    await Bun.write(targetPath, JSON.stringify(snapshot([user("usr_one")])));
    const child = Bun.spawn(
      ["bun", "scripts/public-profile-backfill.ts", "--dry-run", "--manifest", manifestPath],
      {
        env: { ...process.env, PUBLIC_PROFILE_BACKFILL_TARGET_SNAPSHOT: targetPath },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Dry-run rejected");
  });

  test("applies all inserts in one transaction and leaves rollback to the adapter", async () => {
    const current = row({
      global_handle_id: "gh_current",
      user_id: "usr_one",
      label_normalized: "captain",
    });
    const historical = row({
      global_handle_id: "gh_old",
      user_id: "usr_one",
      label_normalized: "old-captain",
      status: "redirect",
      redirect_target_global_handle_id: "gh_current",
    });
    let writes = 0;
    let rolledBack = false;
    const transaction: PublicProfileBackfillTransaction = {
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        text: string,
        _values?: readonly unknown[],
      ): Promise<{ readonly rows: readonly Row[] }> => {
        if (text.startsWith("SELECT user_id")) {
          return { rows: [user("usr_one")] as unknown as readonly Row[] };
        }
        if (text.startsWith("SELECT handle_id")) return { rows: [] as readonly Row[] };
        if (text.startsWith("INSERT")) writes += 1;
        if (writes === 2) throw new Error("simulated insert failure");
        return { rows: [] as readonly Row[] };
      },
    };
    const database = {
      withTransaction: async <A>(
        run: (tx: PublicProfileBackfillTransaction) => Promise<A>,
      ): Promise<A> => {
        try {
          return await run(transaction);
        } catch (error) {
          rolledBack = true;
          throw error;
        }
      },
    };
    await expect(
      runPublicProfileBackfill({
        mode: "apply",
        manifest: manifest([historical, current]),
        database,
      }),
    ).rejects.toThrow("simulated insert failure");
    expect(writes).toBe(2);
    expect(rolledBack).toBe(true);
  });

  test("keeps reports deterministic for equivalent manifests", () => {
    const current = row({
      global_handle_id: "gh_current",
      user_id: "usr_one",
      label_normalized: "captain",
    });
    const historical = row({
      global_handle_id: "gh_old",
      user_id: "usr_one",
      label_normalized: "old-captain",
      status: "redirect",
      redirect_target_global_handle_id: "gh_current",
    });
    const target = snapshot([user("usr_one")]);
    const left = planPublicProfileBackfill(manifest([current, historical]), target);
    const right = planPublicProfileBackfill(manifest([historical, current]), target);
    expect(left.report).toEqual(right.report);
  });
});
