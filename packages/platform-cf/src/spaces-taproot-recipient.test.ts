import { describe, expect, test } from "bun:test";
import { spacesTaprootOutputScriptFromAddress } from "./spaces-taproot-recipient";

// BIP-350's fixed v1 witness vectors, including the output script in the BIP.
const MAINNET_ADDRESS = "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0";
const TESTNET_ADDRESS = "tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c";

describe("Spaces Taproot recipient address", () => {
  test("derives the exact P2TR script from independent BIP-350 vectors", () => {
    expect(spacesTaprootOutputScriptFromAddress(MAINNET_ADDRESS, "mainnet")).toBe(
      "512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    );
    expect(spacesTaprootOutputScriptFromAddress(TESTNET_ADDRESS, "testnet4")).toBe(
      "5120000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433",
    );
  });

  test("refuses the wrong network, witness kind, checksum, and case", () => {
    const invalid = [
      [MAINNET_ADDRESS, "testnet4"],
      [TESTNET_ADDRESS, "mainnet"],
      [MAINNET_ADDRESS.toUpperCase(), "mainnet"],
      [`${MAINNET_ADDRESS.slice(0, -1)}q`, "mainnet"],
      ["bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "mainnet"],
      ["bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd", "mainnet"],
    ] as const;
    for (const [address, network] of invalid) {
      expect(() => spacesTaprootOutputScriptFromAddress(address, network)).toThrow(
        "invalid Taproot address",
      );
    }
  });
});
