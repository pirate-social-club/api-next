import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

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
  test("covers direct table operations in every reward, Megapot and Wallet repository", async () => {
    const covered = new Set(
      RUNTIME_RELEASE_PRIVILEGES.filter((requirement) => requirement.allowed).map(
        (requirement) => `${requirement.object}:${requirement.privilege}`,
      ),
    );
    const schema = await Bun.file(new URL("../db/postgres/schema.sql", import.meta.url)).text();
    const tables = new Set(
      [
        ...schema.matchAll(
          /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:api_next\.)?"?([a-z][a-z0-9_]*)"?/giu,
        ),
      ].map((match) => match[1]),
    );
    expect(tables.has("wallet_sponsored_sends")).toBe(true);
    const directory = new URL("../packages/platform-cf/src/", import.meta.url);
    const repositories = (await readdir(directory, { recursive: true }))
      .filter((source) => /(?:^|\/)(reward|megapot|wallet)-.*-repository\.ts$/u.test(source))
      .sort();
    for (const required of [
      "megapot-purchase-repository.ts",
      "megapot-sweep-repository.ts",
      "reward-gas-topup-repository.ts",
      "reward-payout-repository.ts",
      "reward-refund-repository.ts",
      "wallet-sponsored-send-repository.ts",
    ]) {
      expect(repositories).toContain(required);
    }
    const sources = [...repositories, "reward-claim-verification-intent.ts"];
    const missing = new Set<string>();
    for (const source of sources) {
      const body = await Bun.file(new URL(source, directory)).text();
      for (const match of body.matchAll(
        /\b(FROM|JOIN|UPDATE|INTO|DELETE\s+FROM)\s+([a-z][a-z0-9_]*)\b/gu,
      )) {
        const table = match[2];
        if (!table || !tables.has(table)) continue;
        const operation =
          match[1] === "FROM" || match[1] === "JOIN"
            ? "SELECT"
            : match[1] === "INTO"
              ? "INSERT"
              : match[1]?.startsWith("DELETE")
                ? "DELETE"
                : "UPDATE";
        if (!covered.has(`${table}:${operation}`)) missing.add(`${source}: ${table}:${operation}`);
      }
    }
    expect([...missing].sort()).toEqual([]);
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
