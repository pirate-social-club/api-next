import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
} from "@pirate/application";
import { TelegramFailure } from "@pirate/application/telegram";
import { Effect, type Layer } from "effect";

export type TelegramRow = Record<string, unknown>;
export type TelegramQuery = (
  text: string,
  values?: readonly unknown[],
) => Promise<readonly TelegramRow[]>;
export type TelegramDatabase = {
  query: TelegramQuery;
  transaction: <A>(use: (query: TelegramQuery) => Promise<A>) => Promise<A>;
};

export function makeTelegramDatabase(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): TelegramDatabase {
  const queryFor =
    (transaction: ControlPlaneTransaction): TelegramQuery =>
    async (text, values = []) => {
      const result = await Effect.runPromise(
        transaction.execute<TelegramRow>({
          label: "community-telegram",
          text,
          values,
          readonly: /^\s*SELECT\b/iu.test(text),
        }),
      );
      return result.rows;
    };
  return {
    query: (text, values) =>
      Effect.runPromise(
        Effect.provide(runtime)(
          Effect.gen(function* () {
            const db = yield* ControlPlaneDb;
            return (yield* db.execute<TelegramRow>({
              label: "community-telegram",
              text,
              values: values ?? [],
              readonly: /^\s*SELECT\b/iu.test(text),
            })).rows;
          }),
        ),
      ),
    transaction: (use) =>
      Effect.runPromise(
        Effect.provide(runtime)(
          Effect.gen(function* () {
            const db = yield* ControlPlaneDb;
            return yield* db.withTransaction((transaction) =>
              Effect.tryPromise({
                try: () => use(queryFor(transaction)),
                catch: (error) =>
                  error instanceof TelegramFailure
                    ? error
                    : new TelegramFailure({ reason: "unavailable" }),
              }),
            );
          }),
        ),
      ),
  };
}
