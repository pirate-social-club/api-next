import { describe, expect, test } from "bun:test";

import {
  assertMainLedger,
  privilegeViolations,
  RUNTIME_RELEASE_PRIVILEGES,
} from "./runtime-role-release-preflight.ts";

const facts = RUNTIME_RELEASE_PRIVILEGES.map((requirement) => ({
  object: requirement.object,
  privilege: requirement.privilege,
  expected: requirement.allowed,
  exists: true,
  allowed: requirement.allowed,
}));

describe("runtime role release preflight", () => {
  test("covers every direct table operation in the claim and sponsored-send repositories", async () => {
    const covered = new Set(
      RUNTIME_RELEASE_PRIVILEGES.filter((requirement) => requirement.allowed).map(
        (requirement) => `${requirement.object}:${requirement.privilege}`,
      ),
    );
    for (const source of [
      "megapot-claim-repository.ts",
      "reward-claim-verification-intent.ts",
      "wallet-sponsored-send-repository.ts",
    ]) {
      const body = await Bun.file(
        new URL(`../packages/platform-cf/src/${source}`, import.meta.url),
      ).text();
      for (const match of body.matchAll(/\b(FROM|JOIN|UPDATE|INTO)\s+([a-z][a-z0-9_]*)\b/gu)) {
        const operation =
          match[1] === "FROM" || match[1] === "JOIN"
            ? "SELECT"
            : match[1] === "INTO"
              ? "INSERT"
              : "UPDATE";
        expect(covered.has(`${match[2]}:${operation}`)).toBe(true);
      }
    }
  });

  test("accepts the reviewed claim and Wallet privilege contract", () => {
    expect(privilegeViolations(facts)).toEqual([]);
  });

  test("refuses a missing sponsored-send table grant before activation", () => {
    const withoutInsert = facts.map((fact) =>
      fact.object === "wallet_sponsored_sends" && fact.privilege === "INSERT"
        ? { ...fact, allowed: false }
        : fact,
    );
    expect(privilegeViolations(withoutInsert)).toEqual(["wallet_sponsored_sends: INSERT mismatch"]);
  });

  test("refuses a missing claim routine and unsafe direct claim-table write", () => {
    const broken = facts.map((fact) =>
      fact.object === "accept_megapot_participant_claim_v1(text,text)"
        ? { ...fact, exists: false, allowed: false }
        : fact.object === "megapot_participant_claims" && fact.privilege === "UPDATE"
          ? { ...fact, allowed: true }
          : fact,
    );
    expect(privilegeViolations(broken)).toEqual([
      "megapot_participant_claims: UPDATE mismatch",
      "accept_megapot_participant_claim_v1(text,text): EXECUTE object missing",
    ]);
  });

  test("requires the exact migration filenames and checksums of the release source", () => {
    const plan = [
      { version: "0226_reward_sponsored_send_reservations.sql", checksum: "a" },
      { version: "0227_wallet_sponsored_send_scope.sql", checksum: "b" },
    ];
    expect(() => assertMainLedger(plan, plan)).not.toThrow();
    expect(() =>
      assertMainLedger(
        [
          { version: "0225_reward_sponsored_send_reservations.sql", checksum: "a" },
          { version: "0226_wallet_sponsored_send_scope.sql", checksum: "b" },
        ],
        plan,
      ),
    ).toThrow("mismatch at position 1");
    expect(() => assertMainLedger(plan.slice(0, 1), plan)).toThrow("length mismatch");
    expect(() =>
      assertMainLedger(
        [plan[0] as (typeof plan)[number], { ...plan[1], checksum: "changed" }],
        plan,
      ),
    ).toThrow("mismatch at position 2");
  });
});
