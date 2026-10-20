import { describe, expect, test } from "bun:test";
import type { ControlPlaneDb } from "@pirate/application";
import type { CommunityHandleOfferingV4 } from "@pirate/contracts";
import { bech32m } from "@scure/base";
import { Effect } from "effect";
import { listHandleOfferingDiscovery } from "./handle-offering-discovery.ts";
import { decodePageCursor } from "./handle-sales-page-cursor.ts";
import type {
  SpacesDiscoveryAuthority,
  SpacesDiscoveryObservation,
} from "./spaces-discovery-authority.ts";
import { spacesDelegationScriptV1 } from "./spaces-operator-assignment-repository.ts";

const now = "2026-10-20T10:00:00.000Z";
const delegation = bech32m.encode("bcs", [1, ...bech32m.toWords(new Uint8Array(32).fill(7))]);
const record = (changes: Record<string, unknown> = {}): Record<string, unknown> => ({
  offering_id: "offering-1",
  offering_revision: 1,
  family: "spaces",
  namespace_root: "yahoo",
  created_at: now,
  discovery_current_offering_id: "offering-1",
  discovery_current_offering_revision: 1,
  discovery_activation_id: "activation-1",
  discovery_current_activation_id: "activation-1",
  discovery_community_id: "community-1",
  discovery_ready: true,
  discovery_spaces_authorized: true,
  discovery_network: "mainnet",
  discovery_authority_generation: 1,
  discovery_authority_reference: "authority-1",
  discovery_root_key: "22".repeat(32),
  discovery_outpoint: `${"11".repeat(32)}:1`,
  discovery_latest_authority_reference: "authority-1",
  discovery_latest_authority_generation: 1,
  discovery_latest_binding_same: true,
  discovery_assignment_id: "assignment-1",
  discovery_assignment_generation: 1,
  discovery_delegation_address: delegation,
  discovery_observation_generation: 1,
  discovery_commitment_count: 0,
  discovery_latest_commitment: null,
  ...changes,
});
const observation = (changes: Record<string, unknown> = {}): SpacesDiscoveryObservation =>
  ({
    kind: "verified",
    network: "mainnet",
    canonicalRoot: "yahoo",
    rootKey: "22".repeat(32),
    outpoint: `${"11".repeat(32)}:1`,
    operatorNumLive: true,
    reverseDelegationMatches: true,
    delegationScript: spacesDelegationScriptV1(delegation),
    commitmentCount: 0,
    latestRoot: null,
    ...changes,
  }) as SpacesDiscoveryObservation;
const offering = (row: Readonly<Record<string, unknown>>) =>
  ({
    family: row.family,
    offering_id: row.offering_id,
    offering_revision: row.offering_revision,
    namespace_root: row.namespace_root,
  }) as CommunityHandleOfferingV4;

function scenario(
  options: {
    before?: readonly Record<string, unknown>[];
    after?: readonly Record<string, unknown>[];
    authority?: SpacesDiscoveryAuthority;
    cursor?: string;
    limit?: number;
  } = {},
) {
  const before = options.before ?? [record()];
  const after = options.after ?? before.slice(0, options.limit ?? 20);
  const reads: string[] = [];
  const db = {
    execute: (statement: { label: string; text: string; readonly: boolean }) => {
      expect(statement.readonly).toBe(true);
      reads.push(statement.label);
      if (statement.label === "handle-sales.offering.list-clock")
        return Effect.succeed({ rows: [{ database_now: now }], rowCount: 1 });
      expect(statement.text).toContain("clock_timestamp()");
      expect(statement.text).not.toContain("sale_namespace_activation_id,$2::timestamptz");
      const rows = statement.label === "handle-sales.offering.list-public" ? before : after;
      return Effect.succeed({ rows, rowCount: rows.length });
    },
  } as unknown as ControlPlaneDb["Service"];
  const effect = listHandleOfferingDiscovery(
    db,
    options.authority ?? null,
    {
      communityId: "community-1",
      ...(options.cursor ? { cursor: options.cursor } : {}),
      ...(options.limit ? { limit: options.limit } : {}),
    },
    offering,
  );
  return { effect, reads };
}
const current: NonNullable<SpacesDiscoveryAuthority> = () => Effect.succeed(observation());

describe("public offering discovery projection", () => {
  test("matching current authorization and real observation are both required", async () => {
    const { effect, reads } = scenario({ authority: current });
    const page = await Effect.runPromise(effect);
    expect(page.items[0]).toMatchObject({ current_availability: { kind: "available" } });
    expect(reads).toEqual([
      "handle-sales.offering.list-clock",
      "handle-sales.offering.list-public",
      "handle-sales.offering.discovery-recheck",
    ]);
  });

  test("unwired and pending reads preserve visibility without admitting readiness", async () => {
    for (const authority of [
      null,
      () => Effect.succeed({ kind: "temporarily_unavailable" as const }),
    ]) {
      const { effect } = scenario({ authority });
      expect((await Effect.runPromise(effect)).items[0]).toMatchObject({
        current_availability: { kind: "temporarily_unavailable" },
      });
    }
  });

  test("expiry, same-binding evidence refresh and commitment drift remain temporary", async () => {
    for (const changes of [
      { discovery_ready: false },
      { discovery_ready: false, discovery_latest_authority_generation: 2 },
      { discovery_commitment_count: 1, discovery_latest_commitment: "66".repeat(32) },
      {
        discovery_ready: false,
        discovery_commitment_count: null,
        discovery_observation_generation: null,
      },
    ]) {
      const { effect } = scenario({ authority: current, before: [record(changes)] });
      expect((await Effect.runPromise(effect)).items[0]).toMatchObject({
        current_availability: { kind: "temporarily_unavailable" },
      });
    }
  });

  test("independent exact-root key or outpoint loss omits the candidate", async () => {
    for (const changes of [{ rootKey: "77".repeat(32) }, { outpoint: `${"77".repeat(32)}:0` }]) {
      const { effect } = scenario({ authority: () => Effect.succeed(observation(changes)) });
      expect((await Effect.runPromise(effect)).items).toEqual([]);
    }
  });

  test("post-wait affirmative lifecycle denial omits even an unobserved root", async () => {
    const { effect } = scenario({ after: [record({ discovery_spaces_authorized: false })] });
    expect((await Effect.runPromise(effect)).items).toEqual([]);
  });

  test("changed post-wait evidence cannot reuse earlier availability", async () => {
    const { effect } = scenario({
      authority: current,
      after: [record({ discovery_observation_generation: 2 })],
    });
    expect((await Effect.runPromise(effect)).items[0]).toMatchObject({
      current_availability: { kind: "temporarily_unavailable" },
    });
  });

  test("missing required authorization fails the page instead of an omission", async () => {
    for (const after of [
      [],
      [record({ discovery_authority_reference: null })],
      [record({ discovery_current_activation_id: null })],
    ]) {
      const result = await Effect.runPromise(
        Effect.flip(scenario({ authority: current, after }).effect),
      );
      expect(result._tag).toBe("HandleSalesStorageFailed");
    }
  });

  test("missing initial authorization records fail before any observer call", async () => {
    let calls = 0;
    const authority: NonNullable<SpacesDiscoveryAuthority> = () =>
      Effect.sync(() => {
        calls++;
        return observation();
      });
    for (const key of [
      "discovery_current_offering_id",
      "discovery_activation_id",
      "discovery_current_activation_id",
      "discovery_community_id",
      "discovery_authority_reference",
      "discovery_latest_authority_reference",
    ]) {
      const result = await Effect.runPromise(
        Effect.flip(scenario({ authority, before: [record({ [key]: null })] }).effect),
      );
      expect(result._tag).toBe("HandleSalesStorageFailed");
    }
    expect(calls).toBe(0);
  });

  test("validated supersession omits before observation and during the wait", async () => {
    const superseded = record({
      discovery_spaces_authorized: false,
      discovery_ready: false,
      discovery_latest_binding_same: false,
      discovery_latest_authority_generation: 2,
    });
    for (const authority of [
      null,
      () => Effect.succeed({ kind: "temporarily_unavailable" as const }),
    ]) {
      expect(
        (await Effect.runPromise(scenario({ before: [superseded], authority }).effect)).items,
      ).toEqual([]);
      expect(
        (await Effect.runPromise(scenario({ after: [superseded], authority }).effect)).items,
      ).toEqual([]);
    }
  });

  test("over-budget candidates are rechecked and remain visible when authorized", async () => {
    const rows = ["yahoo", "two", "three", "four"].map((namespace_root, index) =>
      record({ namespace_root, offering_id: `offering-${index}` }),
    );
    const calls: string[] = [];
    const authority: NonNullable<SpacesDiscoveryAuthority> = (root) =>
      Effect.sync(() => {
        calls.push(root.canonicalRoot);
        return observation({ canonicalRoot: root.canonicalRoot });
      });
    const page = await Effect.runPromise(scenario({ before: rows, authority }).effect);
    expect(calls).toEqual(["yahoo", "two", "three"]);
    expect(page.items).toHaveLength(4);
    expect(page.items[3]).toMatchObject({
      current_availability: { kind: "temporarily_unavailable" },
    });
    const denied = [
      ...rows.slice(0, 3),
      record({ ...rows[3], discovery_spaces_authorized: false }),
    ];
    expect(
      (await Effect.runPromise(scenario({ before: rows, after: denied, authority }).effect)).items,
    ).toHaveLength(3);
  });

  test("the original page cursor advances after every selected item is omitted", async () => {
    const rows = [
      record(),
      record({ offering_id: "older", created_at: "2026-10-19T10:00:00.000Z" }),
    ];
    const { effect } = scenario({
      before: rows,
      after: [record({ discovery_spaces_authorized: false })],
      limit: 1,
    });
    const page = await Effect.runPromise(effect);
    expect(page.items).toEqual([]);
    expect(decodePageCursor(page.next_cursor ?? undefined, "offerings", "community-1")).toEqual({
      snapshotCutoff: now,
      sortTime: now,
      sortId: "offering-1",
    });
    const later = scenario({
      cursor: page.next_cursor ?? undefined,
      before: [record({ discovery_ready: false })],
    });
    expect((await Effect.runPromise(later.effect)).items[0]).toMatchObject({
      current_availability: { kind: "temporarily_unavailable" },
    });
    expect(later.reads).not.toContain("handle-sales.offering.list-clock");
  });

  test("HNS wire remains unchanged and current authorization is rechecked", async () => {
    const row = record({ family: "hns" });
    expect((await Effect.runPromise(scenario({ before: [row] }).effect)).items).toEqual([
      offering(row),
    ]);
    expect(
      (
        await Effect.runPromise(
          scenario({ before: [row], after: [record({ family: "hns", discovery_ready: false })] })
            .effect,
        )
      ).items,
    ).toEqual([]);
  });
});
