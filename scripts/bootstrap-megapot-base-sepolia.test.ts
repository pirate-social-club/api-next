import { describe, expect, test } from "bun:test";

import { loadMegapotBaseSepoliaBootstrapManifest } from "./bootstrap-megapot-base-sepolia";

describe("Base Sepolia Megapot authority bootstrap", () => {
  test("loads the reviewed deployment manifest", async () => {
    await expect(loadMegapotBaseSepoliaBootstrapManifest()).resolves.toMatchObject({
      domain: "pirate.megapot-deployment-bootstrap.v1",
      attestation_id: "megapot-base-sepolia-v2",
      environment: "staging",
      chain_id: 84_532,
      jackpot_address: "0x465da3c859f193a3807386387bee941b2a4c3279",
      usdc_address: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
      ticket_nft_address: "0x45084829ac63f9dc6a3d4981a46fa896f9180ecd",
      abi_version: "megapot_v2",
    });
  });
});
