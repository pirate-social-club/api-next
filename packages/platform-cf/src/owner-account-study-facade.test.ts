import { expect, test } from "bun:test";
import { Cause, Effect, Exit, Option } from "effect";
import { makeControlPlaneOwnerAccountStudyFacade } from "./owner-account-study-facade.ts";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresClientLike,
  type PostgresQueryConfig,
} from "./postgres.ts";

const body = {
  idempotency_key: "original-start",
  persona_id: "persona-original",
  target_language: null,
  learner_band: null,
  timezone: "UTC",
  reward_preview_terms_hash: "c".repeat(64),
  disclosure: { version: "original-disclosure", accepted: true as const },
};
function fixture(unknownCommit = false) {
  const queries: PostgresQueryConfig[] = [];
  let puts = 0;
  const client: PostgresClientLike = {
    connect: async () => {},
    end: async () => {},
    query: async (query) => {
      queries.push(query);
      if (query.text === "COMMIT" && unknownCommit)
        throw new Error("opaque driver acknowledgement");
      if (query.text.startsWith("SELECT current_setting"))
        return {
          rows: [{ transaction: "3s", lock: "250ms", statement: "2s", idle: "2s" }],
          rowCount: 1,
        };
      if (query.text.startsWith("SELECT find_account_owner_study_start_v1"))
        return { rows: [{ result: { state: "not_started", result: null } }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const runtime = makeDirectPostgresControlPlaneLayer(
    "postgres://fixture.invalid/owner-account119",
    { clientFactory: () => client },
  );
  const facade = makeControlPlaneOwnerAccountStudyFacade(
    runtime,
    { disclosure: null, purchaseSafetyMarginSeconds: null },
    {
      bucket: {
        put: async (_key, bytes) => {
          puts++;
          return { size: bytes.byteLength };
        },
      },
      transcriber: null,
      rerecordEnabled: false,
      retainTask: () => {},
    },
    { now: Effect.succeed(0) },
    { next: Effect.succeed("never-new") },
  );
  return { facade, queries, puts: () => puts };
}
function failure(exit: Awaited<ReturnType<typeof Effect.runPromiseExit>>) {
  if (!Exit.isFailure(exit)) throw new Error("Expected failure");
  const found = Cause.findErrorOption(exit.cause);
  if (!Option.isSome(found)) throw new Error("Expected typed failure");
  return found.value;
}
test("authoritative original start lookup works under missing current financial/provider/disclosure configuration", async () => {
  const f = fixture();
  expect(
    await Effect.runPromise(
      f.facade.findStart({
        accountId: "original-account",
        communityId: "community-original",
        postId: "post-original",
        idempotencyKey: "original-start",
      }),
    ),
  ).toEqual({ state: "not_started", result: null });
  expect(
    f.queries.find((q) => q.text.startsWith("SELECT find_account_owner_study_start_v1"))?.values,
  ).toEqual(["original-account", "community-original", "post-original", "original-start"]);
  expect(f.puts()).toBe(0);
});
test("NEW start refusal follows original locked lookup and acknowledged COMMIT; no preview/new session/provider before missing config refusal", async () => {
  const f = fixture();
  expect(
    failure(
      await Effect.runPromiseExit(
        f.facade.start({
          accountId: "original-account",
          communityId: "community-original",
          postId: "post-original",
          body,
        }),
      ),
    ),
  ).toMatchObject({ _tag: "StudyV2CommandRejected", reason: "provider-unavailable" });
  expect(f.queries.some((q) => q.text.startsWith("SELECT find_account_owner_study_start_v1"))).toBe(
    true,
  );
  expect(f.queries.some((q) => q.text === "COMMIT")).toBe(true);
  expect(
    f.queries.some(
      (q) =>
        q.text.includes("read_current_account_study_reward_preview") ||
        q.text.includes("INSERT INTO study_sessions"),
    ),
  ).toBe(false);
  expect(f.puts()).toBe(0);
});
test("lost original lookup COMMIT cannot become not_started/new authority or fallback path", async () => {
  const f = fixture(true);
  expect(
    failure(
      await Effect.runPromiseExit(
        f.facade.start({
          accountId: "original-account",
          communityId: "community-original",
          postId: "post-original",
          body,
        }),
      ),
    ),
  ).toMatchObject({ _tag: "ControlPlaneTransactionOutcomeUnknown" });
  expect(
    f.queries.some(
      (q) =>
        q.text.includes("read_current_account_study_reward_preview") ||
        q.text.includes("INSERT INTO study_sessions"),
    ),
  ).toBe(false);
  expect(f.puts()).toBe(0);
});
