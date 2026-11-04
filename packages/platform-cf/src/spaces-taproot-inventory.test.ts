import { describe, expect, test } from "bun:test";
import {
  collectEmbeddedTaprootWallets,
  reconcileEmbeddedTaprootWallets,
} from "./spaces-taproot-inventory.ts";

const address = "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0";
const wallet = {
  type: "wallet",
  chain_type: "bitcoin-taproot",
  wallet_client: "privy",
  wallet_client_type: "privy",
  connector_type: "embedded",
  imported: false,
  id: "wallet_01",
  wallet_index: 0,
  address,
  public_key: `02${"11".repeat(32)}`,
};

describe("Spaces embedded Taproot inventory", () => {
  test("admits only an exact provider-owned wallet and derives its script", () => {
    const list = collectEmbeddedTaprootWallets(
      { linked_accounts: [{ type: "email" }, wallet] },
      "mainnet",
    );
    expect(list).toEqual([
      {
        providerId: "wallet_01",
        index: 0,
        address,
        outputScriptHex: "512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
        publicKeyHex: wallet.public_key,
      },
    ]);
  });

  test("rejects external, imported, wrong-network and duplicate wallets", () => {
    for (const variant of [
      { ...wallet, wallet_client: "external" },
      { ...wallet, imported: true },
      { ...wallet, wallet_index: -1 },
      { ...wallet, id: null },
    ]) {
      expect(() =>
        collectEmbeddedTaprootWallets({ linked_accounts: [variant] }, "mainnet"),
      ).toThrow();
    }
    expect(() =>
      collectEmbeddedTaprootWallets({ linked_accounts: [wallet] }, "testnet4"),
    ).toThrow();
    expect(() =>
      collectEmbeddedTaprootWallets({ linked_accounts: [wallet, wallet] }, "mainnet"),
    ).toThrow();
  });

  test("unknown creation is read-only pending until one new provider ID appears", () => {
    const before = collectEmbeddedTaprootWallets({ linked_accounts: [] }, "mainnet");
    expect(reconcileEmbeddedTaprootWallets(before, before)).toEqual({ kind: "pending" });
    const after = collectEmbeddedTaprootWallets({ linked_accounts: [wallet] }, "mainnet");
    const candidate = after[0];
    if (candidate === undefined) throw new Error("missing fixture wallet");
    expect(reconcileEmbeddedTaprootWallets(before, after)).toEqual({
      kind: "candidate",
      wallet: candidate,
    });
    expect(reconcileEmbeddedTaprootWallets(after, before)).toEqual({ kind: "ambiguous" });
    expect(reconcileEmbeddedTaprootWallets(after, [{ ...candidate, address: "changed" }])).toEqual({
      kind: "ambiguous",
    });
    expect(
      reconcileEmbeddedTaprootWallets(before, [
        candidate,
        { ...candidate, providerId: "wallet_02" },
      ]),
    ).toEqual({ kind: "ambiguous" });
  });
});
