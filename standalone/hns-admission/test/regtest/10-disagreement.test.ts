import { test } from "node:test";
import assert from "node:assert/strict";
import { make } from "@alchemy.run/domain/InMemory";
import { Clock, Effect, Layer } from "effect";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { AdmissionModel } from "../../src/model.ts";
import { observerLayer } from "../../src/hsd-observer.ts";
import {
  HnsObserver,
  create,
  consent,
  instructions,
  observe,
} from "../../src/service.ts";
import { consentData } from "../../src/protocol.ts";
import { NodeFixture, docker } from "./fixture.ts";

import { binding, hash } from "../fixtures.ts";

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
        [
          "partitiontest",
          {
            records: [
              { type: "NS", ns: "ns1.example." },
              {
                type: "DS",
                keyTag: 1234,
                algorithm: 13,
                digestType: 2,
                digest: "ab".repeat(32),
              },
            ],
          },
        ],
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
      const sync = async () => {
        const target = (a.rpc("getblockchaininfo") as { blocks: number })
          .blocks;
        for (let i = 0; i < 100; i++) {
          if (
            (b.rpc("getblockchaininfo") as { blocks: number }).blocks === target
          )
            return;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error("fixture_sync_timeout");
      };
      const account = privateKeyToAccount(generatePrivateKey());
      const selected = {
        ...binding,
        tld: "partitiontest",
        controller: account.address.toLowerCase(),
      };
      const transport: typeof fetch = async (url, init) => {
        const node = String(url).includes("observer-a") ? a : b;
        const request = JSON.parse(init!.body as string);
        return Response.json({
          id: request.id,
          error: null,
          result: node.rpc(request.method, request.params),
        });
      };
      const adapter = observerLayer(
        {
          network: "regtest",
          genesis: String(a.rpc("getblockhash", [0])),
          treeInterval: 5,
          nodes: [
            { url: "http://observer-a.test", authorization: "fixture-only" },
            { url: "http://observer-b.test", authorization: "fixture-only" },
          ],
        },
        transport,
      );
      const chainNow = () => {
        const tip = a.rpc("getblockchaininfo") as { bestblockhash: string };
        const header = a.rpc("getblockheader", [tip.bestblockhash, true]) as {
          time: number;
        };
        return Math.max(Date.now(), header.time * 1000 + 1000);
      };
      let clockMillis = chainNow();
      const memory = make({ now: () => clockMillis });
      const layers = Layer.merge(
        adapter,
        AdmissionModel.layer(Layer.empty).pipe(Layer.provide(memory.layer)),
      );
      const actual = await Effect.runPromise(Clock.Clock);
      const clock: Clock.Clock = Object.assign(Object.create(actual), {
        currentTimeMillisUnsafe: () => clockMillis,
        currentTimeMillis: Effect.sync(() => clockMillis),
      });
      let retained:
        | ReturnType<typeof import("../fixtures.ts").state>
        | undefined;
      await Effect.runPromise(
        Effect.gen(function* () {
          const s = yield* create({ binding: selected, idempotencyKey: hash });
          const signature = yield* Effect.promise(() =>
            account.signTypedData(
              consentData(selected, {
                ceremonyId: s.id,
                bindingDigest: s.bindingDigest,
                resourceDigest: s.resourceDigest,
                nonce: s.nonce,
                issuedAt: s.createdAt,
                deadline: s.consentDeadline,
              }),
            ),
          );
          const accepted = yield* consent(s.id, {
            expectedRevision: s.revision,
            issuedAt: s.createdAt,
            deadline: s.consentDeadline,
            signature,
          });
          const publication = yield* instructions(accepted);
          assert.ok(publication);
          assert.deepEqual(
            publication.records.slice(0, 2).map((r) => r.type),
            ["NS", "DS"],
          );
          // The operator's manual action is accelerated locally, not a product wallet feature.
          a.rpc(
            "sendupdate",
            ["partitiontest", { records: publication.records }],
            true,
          );
          mine(10);
          yield* Effect.promise(sync);
          // Regtest's rapid mining pushes timestamps ahead of wall time. Move
          // the service and Domain clocks together; no production maturity rule changes.
          clockMillis = chainNow();
          retained = yield* observe(s.id);
          assert.equal(retained.phase, "ReadyToSubmit", retained.condition);
          assert.equal(retained.condition, "submission_not_enabled");
        }).pipe(
          Effect.provide(layers),
          Effect.provideService(Clock.Clock, clock),
        ),
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
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const observer = yield* HnsObserver;
          return yield* observer.observe(retained!).pipe(Effect.flip);
        }).pipe(
          Effect.provide(adapter),
          Effect.provideService(Clock.Clock, clock),
        ),
      );
      assert.equal(result.reason, "observer_disagreement");
    } finally {
      a.close();
      b.close();
      docker("network", "rm", network);
    }
  },
);
