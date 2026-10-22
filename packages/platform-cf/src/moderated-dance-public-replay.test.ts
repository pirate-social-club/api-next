import { describe, expect, test } from "bun:test";
import { moderatedDanceReplayDigests } from "./moderated-dance-normalization.ts";
import {
  bindModeratedDanceReplayKeys,
  decodeModeratedDanceReplayKeys,
  makeModeratedDancePublicReplay,
} from "./moderated-dance-public-replay.ts";

const keys = new Map([["epoch", new Uint8Array(32).fill(1)]]);
const work = {
  choreographyId: "public-reference",
  revision: 1,
  scope: "global-body-v1",
  normalizationHash: "a".repeat(64),
  sourceSha256: "b".repeat(64),
  frames: ["c".repeat(64)],
  epoch: "epoch",
  token: "lease",
};
describe("public-only replay indexing with offline persistence", () => {
  test("the same key binds consistently and a changed key has a distinct fixed-context commitment", async () => {
    const seen: unknown[] = [];
    const call = async (_label: string, _sql: string, values: readonly unknown[]) => {
      seen.push(JSON.parse(String(values[0])));
    };
    await bindModeratedDanceReplayKeys(call, keys);
    await bindModeratedDanceReplayKeys(call, keys);
    await bindModeratedDanceReplayKeys(call, new Map([["epoch", new Uint8Array(32).fill(2)]]));
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0]).not.toEqual(seen[2]);
    expect(JSON.stringify(seen)).not.toContain(
      btoa(String.fromCharCode(...new Uint8Array(32).fill(1))),
    );
  });
  test("only the leased public descriptor is hashed, with both original domains and one exact commit", async () => {
    const calls: Array<{ label: string; values: readonly unknown[] }> = [];
    const runner = makeModeratedDancePublicReplay({
      keys,
      randomId: () => "lease",
      call: async (label, _sql, values) => {
        calls.push({ label, values });
        return label === "dance.replay.public.claim" ? work : null;
      },
    });
    expect(await runner.run()).toEqual({ outcome: "indexed" });
    expect(calls.map((c) => c.label)).toEqual([
      "dance.replay.keys.bind",
      "dance.replay.public.claim",
      "dance.replay.public.commit",
    ]);
    const expected = await moderatedDanceReplayDigests({
      scope: work.scope,
      sourceSha256: work.sourceSha256,
      frames: work.frames,
      keys,
    });
    expect(calls[2]?.values).toEqual([
      work.choreographyId,
      1,
      "epoch",
      "lease",
      JSON.stringify(expected.claims),
    ]);
  });
  test("an unknown lease COMMIT escapes before any hash publication; no retry occurs in the invocation", async () => {
    const calls: string[] = [];
    const runner = makeModeratedDancePublicReplay({
      keys,
      call: async (label) => {
        calls.push(label);
        if (label === "dance.replay.public.claim")
          throw new Error("offline COMMIT outcome unknown");
        return null;
      },
    });
    await expect(runner.run()).rejects.toThrow("offline COMMIT outcome unknown");
    expect(calls).toEqual(["dance.replay.keys.bind", "dance.replay.public.claim"]);
  });
  test("substituted lease, missing epoch and oversized descriptor never reach publication", async () => {
    for (const invalid of [
      { ...work, token: "substituted" },
      { ...work, epoch: "missing" },
      { ...work, frames: Array.from({ length: 3601 }, () => "c".repeat(64)) },
    ]) {
      const calls: string[] = [];
      const runner = makeModeratedDancePublicReplay({
        keys,
        randomId: () => "lease",
        call: async (label) => {
          calls.push(label);
          return label === "dance.replay.public.claim" ? invalid : null;
        },
      });
      await expect(runner.run()).rejects.toBeDefined();
      expect(calls).not.toContain("dance.replay.public.commit");
    }
  });
  test("empty, short and oversized configured rings are refused without creating keys", () => {
    for (const ring of [
      "{}",
      JSON.stringify({ epoch: "AQ==" }),
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 33 }, (_, i) => [
            `epoch${i}`,
            btoa(String.fromCharCode(...new Uint8Array(32))),
          ]),
        ),
      ),
    ])
      expect(() => decodeModeratedDanceReplayKeys(ring)).toThrow();
    const decoded = decodeModeratedDanceReplayKeys(
      JSON.stringify({ epoch: btoa(String.fromCharCode(...new Uint8Array(32).fill(1))) }),
    );
    expect([...decoded]).toEqual([...keys]);
  });
});
