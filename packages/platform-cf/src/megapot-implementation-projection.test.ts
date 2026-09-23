import { describe, expect, test } from "bun:test";
import {
  megapotImplementationIdentityFromCandidate,
  megapotImplementationIdentityFromRow,
} from "./megapot-implementation-projection.ts";

const address = `0x${"a".repeat(40)}`;
const codeHash = `0x${"b".repeat(64)}`;

describe("Megapot USDC implementation projection", () => {
  test("keeps staging optional but rejects a query that omits the columns", () => {
    expect(
      megapotImplementationIdentityFromRow(
        { usdc_implementation_address: null, usdc_implementation_code_hash: null },
        "staging",
      ),
    ).toEqual({});
    expect(() => megapotImplementationIdentityFromRow({}, "staging")).toThrow();
  });

  test("requires complete production evidence and preserves the pair", () => {
    const row = {
      usdc_implementation_address: address,
      usdc_implementation_code_hash: codeHash,
    };
    expect(() =>
      megapotImplementationIdentityFromRow(
        { ...row, usdc_implementation_code_hash: null },
        "production",
      ),
    ).toThrow();
    const identity = megapotImplementationIdentityFromRow(row, "production");
    expect(identity).toEqual({
      usdcImplementationAddress: address,
      usdcImplementationCodeHash: codeHash,
    });
    expect(megapotImplementationIdentityFromCandidate(identity)).toEqual(identity);
    expect(() =>
      megapotImplementationIdentityFromCandidate({ usdcImplementationAddress: address }),
    ).toThrow();
  });
});
