import { expect, test } from "bun:test";
import { ControlPlaneAcquireFailed, ControlPlaneDb } from "@pirate/application";
import { Effect } from "effect";
import { makeSongFundingConnection, songFundingLane } from "./song-funding-connection.ts";

const posture = { API_NEXT_ENV: "staging", SAFE_POOL_PRODUCTION_ENABLED: false };
const general = { connectionString: "postgres://dance@127.0.0.1:1/fixture" };
const funding = { connectionString: "postgres://funding@127.0.0.1:1/fixture" };

test("the selected lane admits Safe alone, EOA alone and neither, and refuses both", () => {
  for (const [eoa, safe, expected] of [
    [false, false, null],
    [true, false, "eoa"],
    [false, true, "safe"],
  ] as const)
    expect(
      songFundingLane({ ...posture, MEGAPOT_REWARDS_ENABLED: eoa, SAFE_POOL_PILOT_ENABLED: safe }),
    ).toBe(expected);
  expect(() =>
    songFundingLane({ ...posture, MEGAPOT_REWARDS_ENABLED: true, SAFE_POOL_PILOT_ENABLED: true }),
  ).toThrow();
});

test("Safe production admission requires its own switch", () => {
  expect(
    songFundingLane({
      API_NEXT_ENV: "production",
      SAFE_POOL_PRODUCTION_ENABLED: false,
      MEGAPOT_REWARDS_ENABLED: false,
      SAFE_POOL_PILOT_ENABLED: true,
    }),
  ).toBeNull();
  expect(
    songFundingLane({
      API_NEXT_ENV: "production",
      SAFE_POOL_PRODUCTION_ENABLED: true,
      MEGAPOT_REWARDS_ENABLED: false,
      SAFE_POOL_PILOT_ENABLED: true,
    }),
  ).toBe("safe");
});

test("neither enabled lane can fall back to Dance or accept an aliased binding", () => {
  for (const lane of ["safe", "eoa"] as const)
    for (const binding of [undefined, {}, general, { connectionString: "" }])
      expect(() => makeSongFundingConnection(binding, general, lane)).toThrow(
        "Dedicated song funding",
      );
});

test("Rewards off leaves unrelated composition usable without database access", async () => {
  const layer = makeSongFundingConnection(undefined, general, null);
  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* ControlPlaneDb;
      }).pipe(Effect.provide(layer)),
    ),
  ).rejects.toBeInstanceOf(ControlPlaneAcquireFailed);
});

test("a configured funding connection remains available when off for immutable receipt replay", async () => {
  const calls: string[] = [];
  const layer = makeSongFundingConnection(funding, general, null, {
    clientFactory: (url) => {
      calls.push(url);
      return {
        connect: async () => {},
        end: async () => {},
        query: async () => ({ rows: [], rowCount: 0 }),
      };
    },
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      yield* db.execute({ label: "fixture.receipt", text: "SELECT 1", values: [], readonly: true });
    }).pipe(Effect.provide(layer)),
  );
  expect(calls).toEqual([funding.connectionString]);
});
