import { test } from "node:test";
import assert from "node:assert/strict";
import { docker, IMAGE } from "./fixture.ts";
import { safeEntryHeight } from "../../src/observation.ts";
test("actual HSD safe-root method matches fixed mainnet entry/root vectors", () => {
  const vectors = [
    [35, 35, 1],
    [36, 36, 1],
    [37, 36, 1],
    [47, 36, 1],
    [48, 48, 2],
    [71, 71, 2],
    [72, 72, 2],
    [73, 72, 2],
    [83, 72, 2],
    [84, 84, 3],
  ];
  const code =
    "const Chain=require('/usr/local/lib/node_modules/hsd/lib/blockchain/chain');" +
    "const entries=new Map([[35,1],[36,1],[37,2],[47,2],[48,2],[71,2],[72,2],[73,3],[83,3],[84,3]]);" +
    "(async()=>{const out=[];for(const [height]of " +
    JSON.stringify(vectors) +
    "){let selected;" +
    "const root=await Chain.prototype.getSafeRoot.call({height,network:{names:{treeInterval:36}}," +
    "getEntryByHeight:async h=>{selected=h;return {treeRoot:Buffer.alloc(32,entries.get(h))}}});" +
    "out.push([height,selected,root[0]]);}console.log(JSON.stringify(out));})().catch(e=>{console.error(e);process.exitCode=1})";
  const actual = JSON.parse(
    docker(
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "node",
      IMAGE,
      "-e",
      code,
    ),
  );
  assert.deepEqual(actual, vectors);
  for (const [height, selected] of vectors)
    assert.equal(safeEntryHeight(height, 36), selected);
});
