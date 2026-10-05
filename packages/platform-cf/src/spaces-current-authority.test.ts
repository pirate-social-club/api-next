import { describe, expect, test } from "bun:test";
import type { ControlPlaneTransaction } from "@pirate/application";
import type { CommunityHandleOfferingV4 } from "@pirate/contracts";
import { bech32m } from "@scure/base";
import { Effect } from "effect";
import {
  filterCurrentSpacesOfferings,
  hasCurrentSpacesAuthority,
  makeSpacesCurrentAuthority,
  requireCurrentSpacesAuthority,
} from "./spaces-current-authority.ts";
import { spacesDelegationScriptV1 } from "./spaces-operator-assignment-repository.ts";
import type { SpacesRootAuthorityObserver } from "./spaces-owner-proof-repository.ts";
import { parseSpacesRootAuthorityEvidenceV1 } from "./spaces-root-authority-evidence.ts";
import { bytes, fixture } from "./spaces-root-authority-test-fixture.ts";

const target = { activationId: "activation-1", activationGeneration: 1, canonicalRoot: "yahoo" };
const delegation = bech32m.encode("bcs", [1, ...bech32m.toWords(new Uint8Array(32).fill(7))]);
const row: Record<string, unknown> = {
  spaces_network: "mainnet",
  root_key_hex: "22".repeat(32),
  root_outpoint: `${"11".repeat(32)}:1`,
  delegation_address: delegation,
  commitment_count: 0,
  latest_commitment_root_hex: null,
  namespace_authority_reference: "authority-1",
  namespace_authority_generation: 1,
  operator_assignment_id: "assignment-1",
  current_generation: 1,
};
const offering = {
  family: "spaces",
  namespace_root: "yahoo",
  sale_namespace_activation_id: "activation-1",
  sale_namespace_activation_generation: 1,
} as CommunityHandleOfferingV4;
const hns = { family: "hns" } as CommunityHandleOfferingV4;
const evidence = (changes: Record<string, unknown> = {}) =>
  parseSpacesRootAuthorityEvidenceV1(
    bytes({
      ...fixture(),
      operator_num_live: true,
      operator_num_outpoint: `${"55".repeat(32)}:0`,
      operator_num_holder_script_pubkey_hex: spacesDelegationScriptV1(delegation),
      ...changes,
    }),
    "yahoo",
    false,
  );
const verified = (changes: Record<string, unknown> = {}): SpacesRootAuthorityObserver => ({
  observe: async () => ({ kind: "verified", evidence: evidence(changes), bytes: new Uint8Array() }),
});
const reader = (rows = [row, row]) => {
  let reads = 0;
  const db: ControlPlaneTransaction = {
    execute: ((statement) => {
      expect(statement.text).toContain("clock_timestamp()");
      expect(statement.values).toEqual(["activation-1", "yahoo", 1]);
      const value = rows[Math.min(reads++, rows.length - 1)];
      return Effect.succeed({ rows: value ? [value] : [], rowCount: value ? 1 : 0 });
    }) as ControlPlaneTransaction["execute"],
  };
  return { db, reads: () => reads };
};

describe("Spaces current authority", () => {
  test("a still-fresh ready row cannot override a current stale-parent refusal", async () => {
    const { db } = reader();
    const pending = makeSpacesCurrentAuthority({ observe: async () => ({ kind: "pending" }) });
    expect(await Effect.runPromise(hasCurrentSpacesAuthority(db, pending, target))).toBe(false);
    expect(
      await Effect.runPromise(filterCurrentSpacesOfferings(db, pending, [offering, hns])),
    ).toEqual([hns]);
    const refusal = await Effect.runPromise(
      Effect.flip(requireCurrentSpacesAuthority(db, pending, offering)),
    );
    expect(refusal.reason).toBe("sale_namespace_inactive");
    expect(refusal.retryable).toBe(true);
  });

  test("publication must also match the latest scheduled commitment", async () => {
    const { db } = reader();
    const next = makeSpacesCurrentAuthority(
      verified({ commitment_count: 1, latest_commitment: { state_root: "66".repeat(32) } }),
    );
    expect(await Effect.runPromise(hasCurrentSpacesAuthority(db, next, target))).toBe(false);
    const current = reader([
      { ...row, commitment_count: 1, latest_commitment_root_hex: "66".repeat(32) },
    ]);
    expect(await Effect.runPromise(hasCurrentSpacesAuthority(current.db, next, target))).toBe(true);
  });

  test("changed owner, outpoint, delegation and commitment history refuse readiness", async () => {
    for (const changes of [
      { owner_xonly_key_hex: "77".repeat(32), owner_script_pubkey_hex: `5120${"77".repeat(32)}` },
      { outpoint: `${"77".repeat(32)}:0` },
      { operator_num_holder_script_pubkey_hex: `5120${"77".repeat(32)}` },
      { commitment_count: 1, latest_commitment: { state_root: "77".repeat(32) } },
    ]) {
      expect(
        await Effect.runPromise(
          hasCurrentSpacesAuthority(
            reader().db,
            makeSpacesCurrentAuthority(verified(changes)),
            target,
          ),
        ),
      ).toBe(false);
    }
  });

  test("unwired, unavailable and malformed authority fail closed", async () => {
    const absent = reader();
    expect(await Effect.runPromise(hasCurrentSpacesAuthority(absent.db, null, target))).toBe(false);
    expect(absent.reads()).toBe(0);
    const unavailable = makeSpacesCurrentAuthority({
      observe: async () => {
        throw new Error("unavailable");
      },
    });
    expect(
      await Effect.runPromise(hasCurrentSpacesAuthority(reader().db, unavailable, target)),
    ).toBe(false);
    expect(
      await Effect.runPromise(
        hasCurrentSpacesAuthority(
          reader().db,
          makeSpacesCurrentAuthority(verified({ commitment_count: 1, latest_commitment: {} })),
          target,
        ),
      ),
    ).toBe(false);
  });

  test("rechecks current authorization and database freshness after the external wait", async () => {
    const checker = makeSpacesCurrentAuthority(verified());
    expect(
      await Effect.runPromise(
        hasCurrentSpacesAuthority(
          reader([row, { ...row, current_generation: 2 }]).db,
          checker,
          target,
        ),
      ),
    ).toBe(false);
    const expired = reader();
    let checks = 0;
    const db: ControlPlaneTransaction = {
      execute: (() =>
        Effect.succeed({
          rows: checks++ === 0 ? [row] : [],
          rowCount: 1,
        })) as ControlPlaneTransaction["execute"],
    };
    expect(await Effect.runPromise(hasCurrentSpacesAuthority(db, checker, target))).toBe(false);
    expect(await Effect.runPromise(hasCurrentSpacesAuthority(expired.db, checker, target))).toBe(
      true,
    );
    expect(expired.reads()).toBe(2);
  });

  test("deduplicates a root activation only within the current page and preserves HNS items", async () => {
    let calls = 0;
    const checker = makeSpacesCurrentAuthority({
      observe: async () => {
        calls += 1;
        return { kind: "verified", evidence: evidence(), bytes: new Uint8Array() };
      },
    });
    expect(
      await Effect.runPromise(
        filterCurrentSpacesOfferings(reader().db, checker, [offering, offering, hns]),
      ),
    ).toEqual([offering, offering, hns]);
    expect(calls).toBe(1);
    await Effect.runPromise(filterCurrentSpacesOfferings(reader().db, checker, [offering]));
    expect(calls).toBe(2);
  });
  test("outer cancellation reaches the independent observer", async () => {
    let aborted = false;
    const checker = makeSpacesCurrentAuthority({
      observe: async (_input, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    });
    const controller = new AbortController();
    const pending = Effect.runPromise(hasCurrentSpacesAuthority(reader().db, checker, target), {
      signal: controller.signal,
    });
    const began = performance.now();
    const timer = setTimeout(() => controller.abort(), 10);
    try {
      await expect(pending).rejects.toThrow();
    } finally {
      clearTimeout(timer);
    }
    expect(performance.now() - began).toBeLessThan(500);
    expect(aborted).toBe(true);
  });

  test("checks a bounded page prefix without hiding fast successes or accepting a different generation", async () => {
    let calls = 0;
    const db: ControlPlaneTransaction = {
      execute: (() =>
        Effect.succeed({ rows: [row], rowCount: 1 })) as ControlPlaneTransaction["execute"],
    };
    const checker = () => {
      calls += 1;
      return Effect.succeed(true);
    };
    const more = [1, 2, 3, 4].map((id) => ({
      ...offering,
      sale_namespace_activation_id: `activation-${id}`,
    }));
    expect(
      await Effect.runPromise(filterCurrentSpacesOfferings(db, checker, [...more, hns])),
    ).toEqual([...more.slice(0, 3), hns]);
    expect(calls).toBe(3);
    const next = { ...offering, sale_namespace_activation_generation: 2 };
    expect(
      await Effect.runPromise(
        filterCurrentSpacesOfferings(
          db,
          (binding) => Effect.succeed(binding.activationGeneration === 1),
          [offering, next],
        ),
      ),
    ).toEqual([offering]);
  });
  test("retains completed roots when one root exhausts the shared deadline", async () => {
    const calls: string[] = [];
    const db: ControlPlaneTransaction = {
      execute: (() =>
        Effect.succeed({ rows: [row], rowCount: 1 })) as ControlPlaneTransaction["execute"],
    };
    const checker = (binding: { activationId: string }) => {
      calls.push(binding.activationId);
      return binding.activationId === "activation-1"
        ? Effect.tryPromise(() => new Promise<boolean>(() => {}))
        : Effect.succeed(true);
    };
    const candidates = [1, 2, 3, 4].map((id) => ({
      ...offering,
      sale_namespace_activation_id: `activation-${id}`,
    }));
    const began = performance.now();
    expect(
      await Effect.runPromise(filterCurrentSpacesOfferings(db, checker, [...candidates, hns])),
    ).toEqual([...candidates.slice(1, 3), hns]);
    expect(performance.now() - began).toBeLessThan(4000);
    expect(calls).toEqual(["activation-1", "activation-2", "activation-3"]);
  });
});
