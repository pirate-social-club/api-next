import { describe, expect, test } from "bun:test";
import {
  ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneStatementFailed,
} from "@pirate/application";
import { Effect, Layer } from "effect";
import { makeControlPlaneOwnerMegapotSettlementStore } from "./owner-megapot-settlement-store.ts";

// Decoder boundary tests only. The trap returns no fabricated SQL row/result.
function fixture() {
  let databaseCalls = 0;
  const original = new ControlPlaneStatementFailed({
    label: "actual-db-trap",
    sqlState: null,
    constraint: null,
    outcomeCertainty: "completed",
  });
  const refuse = () =>
    Effect.sync(() => {
      databaseCalls++;
    }).pipe(Effect.andThen(Effect.fail(original)));
  const runtime = Layer.succeed(ControlPlaneDb, { execute: refuse, withTransaction: refuse });
  return {
    store: makeControlPlaneOwnerMegapotSettlementStore(runtime),
    calls: () => databaseCalls,
    original,
  };
}
const ids = [
  "a b",
  "a\tb",
  "a\u0001b",
  "a\u007fb",
  "a\u00a0b",
  "a\ufeffb",
  "x".repeat(129),
  "😀".repeat(65),
  "a\ud800b",
  "a\udc00b",
];
const hash = "03".repeat(32);

describe("owner settlement exact identifier boundary", () => {
  test("all supplied source/effect/snapshot identifiers reject invalid original UTF16 before database work", async () => {
    const f = fixture();
    for (const id of ids) {
      const attempts: readonly Effect.Effect<unknown, ControlPlaneError>[] = [
        f.store.freeze({ poolLegId: id, drawingId: "7" }, null),
        f.store.readCommitment({ poolLegId: id, drawingId: "7" }),
        f.store.allocate({ poolLegId: id, drawingId: "7" }),
        f.store.prepareCommitment({
          poolLegId: "pool_fixture",
          drawingId: "7",
          snapshotId: id,
          payload: "{}",
          payloadHash: hash,
          signingKeyId: "key",
          signature: "signature",
        }),
        f.store.confirmPublished({
          poolLegId: "pool_fixture",
          drawingId: "7",
          commitmentEffectId: id,
          payloadHash: hash,
          publicReference: "https://commitment.invalid",
          publishedAt: "2026-10-13T00:00:00.000Z",
        }),
      ];
      for (const effect of attempts) {
        const rejected = await Effect.runPromise(Effect.flip(effect));
        expect(rejected).toMatchObject({ _tag: "ControlPlaneStatementFailed" });
        expect(rejected).not.toBe(f.original);
      }
    }
    expect(f.calls()).toBe(0);
  });
  test("128UTF16/64astral and permitted NEL reach the original database trap without invented success", async () => {
    const f = fixture();
    for (const id of ["x".repeat(128), "😀".repeat(64), "a\u0085b"])
      expect(
        await Effect.runPromise(
          Effect.flip(f.store.freeze({ poolLegId: id, drawingId: "7" }, null)),
        ),
      ).toBe(f.original);
    expect(f.calls()).toBe(3);
  });
});
