import { describe, expect, test } from "bun:test";

import { assertChecksummedLedgerPrefix } from "./m3-staging-preflight";

const plan = [
  { version: "0001_one.sql", checksum: "a" },
  { version: "0002_two.sql", checksum: "b" },
];

describe("M3 staging preflight", () => {
  test("accepts only an exact checksummed migration prefix", () => {
    expect(() => assertChecksummedLedgerPrefix(plan.slice(0, 1), plan)).not.toThrow();
    expect(() =>
      assertChecksummedLedgerPrefix([{ version: "0001_one.sql", checksum: "changed" }], plan),
    ).toThrow("checksum mismatch");
    expect(() => assertChecksummedLedgerPrefix([plan[1] as (typeof plan)[number]], plan)).toThrow(
      "not the repository prefix",
    );
    expect(() => assertChecksummedLedgerPrefix([...plan, ...plan], plan)).toThrow(
      "ahead of this source",
    );
  });
});
