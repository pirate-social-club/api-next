import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { NodeFixture, docker } from "./fixture.ts";
import { agree } from "../../src/observation.ts";
import { observation, binding, hash } from "../fixtures.ts";
import { challengeRecord } from "../../src/records.ts";
test(
  "two real HSD nodes on partitioned branches produce Unavailable",
  { timeout: 120000 },
  async () => {
    const network = "hns-admission-fork-" + process.pid;
    docker("network", "create", "--internal", network);
    const a = new NodeFixture(),
      b = new NodeFixture();
    try {
      a.start(network);
      b.start(network);
      await a.ready();
      await b.ready();
      const mine = await a.acquire("partitiontest");
      a.rpc(
        "sendupdate",
        ["partitiontest", { records: [{ type: "TXT", txt: ["baseline"] }] }],
        true,
      );
      mine(10);
      const ip = docker(
        "inspect",
        "--format",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
        a.name,
      );
      b.rpc("addnode", [ip + ":14038", "onetry"]);
      const height = (a.rpc("getblockchaininfo") as { blocks: number }).blocks;
      for (let i = 0; i < 100; i++) {
        if (
          (b.rpc("getblockchaininfo") as { blocks: number }).blocks === height
        )
          break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(
        (b.rpc("getblockchaininfo") as { blocks: number }).blocks,
        height,
      );
      docker("network", "disconnect", network, a.name);
      a.rpc(
        "sendupdate",
        ["partitiontest", { records: [{ type: "TXT", txt: ["branch-a"] }] }],
        true,
      );
      mine(10);
      const address = b.rpc("getnewaddress", [], true);
      b.rpc("generatetoaddress", [10, address]);
      const ai = a.rpc("getblockchaininfo") as { bestblockhash: string },
        bi = b.rpc("getblockchaininfo") as { bestblockhash: string };
      assert.notEqual(ai.bestblockhash, bi.bestblockhash);
      const ar = a.encode(
        (a.rpc("getnameresource", ["partitiontest"]) as { records: unknown[] })
          .records,
      );
      const br = b.encode(
        (b.rpc("getnameresource", ["partitiontest"]) as { records: unknown[] })
          .records,
      );
      assert.notEqual(ar, br);
      const digest = (hex: string) =>
        "0x" +
        createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
      const first = {
        ...observation(),
        tipHash: "0x" + ai.bestblockhash,
        resourceDigest: digest(ar),
      };
      const second = {
        ...observation(),
        tipHash: "0x" + bi.bestblockhash,
        resourceDigest: digest(br),
      };
      const result = agree(first, second, 1000, {
        chainId: 6343,
        registry: binding.registry,
        controller: binding.controller,
        communityId: hash,
        network: "regtest",
        genesis: hash,
        challenge: challengeRecord(hash),
        resourceDigest: hash,
        ownershipEpoch: hash,
      });
      assert.deepEqual(result, {
        status: "unavailable",
        reason: "observer_disagreement",
      });
    } finally {
      a.close();
      b.close();
      docker("network", "rm", network);
    }
  },
);
