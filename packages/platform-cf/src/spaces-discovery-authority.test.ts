import { describe, expect, test } from "bun:test";
import { bech32m } from "@scure/base";
import { Effect } from "effect";
import {
  assessSpacesDiscoveryAuthority,
  makeSpacesDiscoveryAuthority,
  observeSpacesDiscoveryRoots,
  type SpacesDiscoveryBinding,
  type SpacesDiscoveryObservation,
  spacesDiscoveryRootKey,
} from "./spaces-discovery-authority.ts";
import { spacesDelegationScriptV1 } from "./spaces-operator-assignment-repository.ts";
import type { SpacesRootAuthorityObserver } from "./spaces-owner-proof-repository.ts";
import { parseSpacesRootAuthorityEvidenceV1 } from "./spaces-root-authority-evidence.ts";
import { bytes, fixture } from "./spaces-root-authority-test-fixture.ts";

const delegationAddress = bech32m.encode("bcs", [
  1,
  ...bech32m.toWords(new Uint8Array(32).fill(7)),
]);
const binding: SpacesDiscoveryBinding = {
  network: "mainnet",
  canonicalRoot: "yahoo",
  rootKey: "22".repeat(32),
  outpoint: `${"11".repeat(32)}:1`,
  delegationAddress,
  commitmentCount: 0,
  latestRoot: null,
};
const verified = (changes: Record<string, unknown> = {}): SpacesRootAuthorityObserver => ({
  observe: async () => {
    const evidenceBytes = bytes({
      ...fixture(),
      operator_num_live: true,
      operator_num_outpoint: `${"55".repeat(32)}:0`,
      operator_num_holder_script_pubkey_hex: spacesDelegationScriptV1(delegationAddress),
      ...changes,
    });
    return {
      kind: "verified",
      evidence: parseSpacesRootAuthorityEvidenceV1(evidenceBytes, "yahoo", false),
      bytes: evidenceBytes,
    };
  },
});
const observe = (observer: SpacesRootAuthorityObserver) =>
  Effect.runPromise(makeSpacesDiscoveryAuthority(observer)(binding));
const assess = async (changes: Record<string, unknown> = {}) =>
  assessSpacesDiscoveryAuthority(binding, await observe(verified(changes)));

describe("Spaces discovery authority", () => {
  test("requires matching real publication and delegation for availability", async () => {
    expect(await assess()).toBe("available");
    for (const changes of [
      { commitment_count: 1, latest_commitment: { state_root: "66".repeat(32) } },
      { operator_num_holder_script_pubkey_hex: `5120${"77".repeat(32)}` },
      {
        operator_num_live: false,
        operator_num_outpoint: null,
        operator_num_holder_script_pubkey_hex: null,
      },
    ])
      expect(await assess(changes)).toBe("temporarily_unavailable");
  });

  test("verified exact-root key or outpoint loss is a separate outcome", async () => {
    expect(await assess({ outpoint: `${"77".repeat(32)}:0` })).toBe("verified_ownership_loss");
    expect(
      await assess({
        owner_xonly_key_hex: "77".repeat(32),
        owner_script_pubkey_hex: `5120${"77".repeat(32)}`,
      }),
    ).toBe("verified_ownership_loss");
  });

  test("pending, unavailable, malformed and foreign evidence prove no loss", async () => {
    for (const observer of [
      { observe: async () => ({ kind: "pending" as const }) },
      {
        observe: async () => {
          throw new Error("unavailable");
        },
      },
      verified({ commitment_count: 1, latest_commitment: {} }),
      verified({ root: "@other" }),
      verified({ network: "testnet" }),
    ])
      expect(assessSpacesDiscoveryAuthority(binding, await observe(observer))).toBe(
        "temporarily_unavailable",
      );
    const observation = await observe(verified());
    if (observation.kind !== "verified") throw new Error("missing fixture");
    for (const foreign of [{ network: "testnet" }, { canonicalRoot: "other" }])
      expect(
        assessSpacesDiscoveryAuthority(binding, {
          ...observation,
          ...foreign,
          rootKey: "77".repeat(32),
        }),
      ).toBe("temporarily_unavailable");
  });

  test("unwired and unsupported networks remain unavailable without a fetch", async () => {
    expect((await Effect.runPromise(observeSpacesDiscoveryRoots(null, [binding]))).size).toBe(0);
    let calls = 0;
    const authority = makeSpacesDiscoveryAuthority({
      observe: async () => {
        calls++;
        return { kind: "pending" };
      },
    });
    expect(await Effect.runPromise(authority({ ...binding, network: "testnet" }))).toEqual({
      kind: "temporarily_unavailable",
    });
    expect(calls).toBe(0);
  });

  test("deduplicates roots per batch, limits three roots and never caches across pages", async () => {
    const calls: string[] = [];
    const authority = (root: { canonicalRoot: string }) =>
      Effect.sync(() => {
        calls.push(root.canonicalRoot);
        return { kind: "temporarily_unavailable" as const };
      });
    const roots = [
      binding,
      binding,
      ...["two", "three", "four"].map((canonicalRoot) => ({ ...binding, canonicalRoot })),
    ];
    const first = await Effect.runPromise(observeSpacesDiscoveryRoots(authority, roots));
    expect(calls).toEqual(["yahoo", "two", "three"]);
    expect(first.has(spacesDiscoveryRootKey(roots[4]!))).toBe(false);
    await Effect.runPromise(observeSpacesDiscoveryRoots(authority, [binding]));
    expect(calls).toHaveLength(4);
  });

  test("one root consuming the shared deadline preserves completed results", async () => {
    const current = await observe(verified());
    const authority = (root: { canonicalRoot: string }) =>
      root.canonicalRoot === "yahoo" ? Effect.succeed(current) : Effect.never;
    const observations = await Effect.runPromise(
      observeSpacesDiscoveryRoots(authority, [binding, { ...binding, canonicalRoot: "slow" }]),
    );
    expect(observations.get(spacesDiscoveryRootKey(binding))).toEqual(current);
    expect(observations.size).toBe(1);
  }, 5000);

  test("caller cancellation propagates to an in-flight independent read", async () => {
    let aborted = false;
    const authority = makeSpacesDiscoveryAuthority({
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
    const pending = Effect.runPromise(observeSpacesDiscoveryRoots(authority, [binding]), {
      signal: controller.signal,
    });
    const timer = setTimeout(() => controller.abort(), 10);
    try {
      await expect(pending).rejects.toThrow();
    } finally {
      clearTimeout(timer);
    }
    expect(aborted).toBe(true);
  });

  test("a completed observation failure remains temporary", async () => {
    const observations = await Effect.runPromise(
      observeSpacesDiscoveryRoots(() => Effect.fail("unavailable"), [binding]),
    );
    expect(observations.get(spacesDiscoveryRootKey(binding))).toEqual({
      kind: "temporarily_unavailable",
    } satisfies SpacesDiscoveryObservation);
  });
});
