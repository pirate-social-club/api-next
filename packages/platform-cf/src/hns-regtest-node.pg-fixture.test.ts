import { describe, expect, test } from "bun:test";
import {
  hsdRegtestEndpointError,
  hsdRegtestGenesis,
  hsdRegtestIdentityError,
  probeHsdRegtestIdentity,
  probeHsdRegtestWallet,
  requireHsdRegtestChain,
} from "./hns-regtest-node.pg-fixture.ts";

describe("required HSD regtest identity", () => {
  test("chain-only preflight needs no database and refuses a mainnet node before wallet access", async () => {
    const methods: string[] = [];
    await expect(
      requireHsdRegtestChain(async (_url, method) => {
        methods.push(method);
        return method === "getblockchaininfo" ? { chain: "main" } : hsdRegtestGenesis;
      }),
    ).rejects.toThrow("HSD regtest required");
    expect(methods).toEqual(["getblockchaininfo", "getblockhash"]);
  });
  test("refuses non-loopback and non-HTTP fixture endpoints", () => {
    expect(hsdRegtestEndpointError("node", "http://127.0.0.1:14037/")).toBeNull();
    expect(hsdRegtestEndpointError("node", "https://127.0.0.1:14037/")).toContain(
      "http://127.0.0.1",
    );
    expect(hsdRegtestEndpointError("node", "http://regtest.example:14037/")).toContain(
      "http://127.0.0.1",
    );
  });

  test("accepts only the pinned regtest network and genesis", () => {
    expect(hsdRegtestIdentityError({ chain: "regtest", genesis: hsdRegtestGenesis })).toBeNull();
    expect(hsdRegtestIdentityError({ chain: "main", genesis: hsdRegtestGenesis })).toContain(
      "HSD regtest required",
    );
    expect(hsdRegtestIdentityError({ chain: "regtest", genesis: "wrong" })).toContain(
      "genesis mismatch",
    );
  });

  test("propagates an unavailable node instead of treating it as an identity", async () => {
    await expect(
      probeHsdRegtestIdentity(async () => {
        throw new Error("fixture unavailable");
      }),
    ).rejects.toThrow("fixture unavailable");
  });

  test("requires a reachable wallet with structured readiness data", async () => {
    await expect(probeHsdRegtestWallet(async () => null)).rejects.toThrow(
      "wallet returned malformed readiness data",
    );
    await expect(
      probeHsdRegtestWallet(async () => {
        throw new Error("wallet unavailable");
      }),
    ).rejects.toThrow("wallet unavailable");
    await expect(probeHsdRegtestWallet(async () => ({ id: "primary" }))).resolves.toBeUndefined();
  });
});
