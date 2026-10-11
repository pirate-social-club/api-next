import { expect, test } from "bun:test";
import { ControlPlaneDb } from "@pirate/application";
import { Effect } from "effect";
import { makeDirectPostgresControlPlaneLayer, type PostgresClientFactory } from "./postgres.ts";

function unansweredClose() {
  const events: string[] = [];
  let release: () => void = () => undefined;
  const clientFactory: PostgresClientFactory = () => ({
    connection: { stream: { destroy: () => events.push("destroy") } },
    connect: async () => undefined,
    query: async ({ text }) => {
      events.push(text);
      return { rows: [], rowCount: 0 };
    },
    end: () => {
      events.push("end");
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });
  return { events, clientFactory, release: () => release() };
}

const read = Effect.gen(function* () {
  const db = yield* ControlPlaneDb;
  yield* db.execute({ label: "fixture.read", text: "SELECT 1", values: [], readonly: true });
});
const quiet = { info: () => undefined, error: () => undefined };

test("a bounded close destroys the socket when the driver does not answer", async () => {
  const driver = unansweredClose();
  const startedAt = Date.now();
  await Effect.runPromise(
    Effect.provide(
      makeDirectPostgresControlPlaneLayer("postgres://close.invalid/fixture", {
        clientFactory: driver.clientFactory,
        closeTimeoutMs: 60,
        logger: quiet,
      }),
    )(read),
  );
  expect(Date.now() - startedAt).toBeLessThan(1_000);
  // The statement completed first; only the termination was abandoned.
  expect(driver.events).toEqual(["SELECT 1", "end", "destroy"]);
});

test("a bounded close that is answered in time destroys nothing", async () => {
  const events: string[] = [];
  await Effect.runPromise(
    Effect.provide(
      makeDirectPostgresControlPlaneLayer("postgres://close.invalid/fixture", {
        clientFactory: () => ({
          connection: { stream: { destroy: () => events.push("destroy") } },
          connect: async () => undefined,
          query: async () => ({ rows: [], rowCount: 0 }),
          end: async () => {
            events.push("end");
          },
        }),
        closeTimeoutMs: 60,
        logger: quiet,
      }),
    )(read),
  );
  expect(events).toEqual(["end"]);
});

test("without a close bound the session still waits for the driver", async () => {
  const driver = unansweredClose();
  let finished = false;
  const run = Effect.runPromise(
    Effect.provide(
      makeDirectPostgresControlPlaneLayer("postgres://close.invalid/fixture", {
        clientFactory: driver.clientFactory,
        logger: quiet,
      }),
    )(read),
  ).then(() => {
    finished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(finished).toBe(false);
  expect(driver.events).toEqual(["SELECT 1", "end"]);
  driver.release();
  await run;
  expect(finished).toBe(true);
});
