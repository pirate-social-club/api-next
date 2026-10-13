// Driver-boundary causality only. Root's genuine native producer/financial
// acceptance must prove these controlled leaves and marker semantics separately.
import { expect, test } from "bun:test";
import { ControlPlaneDb } from "@pirate/application";
import { Effect } from "effect";
import { makeControlPlaneAccountOwnerRewardHooks, withAccountOwnerRewardMutation } from "./account-owner-reward-hooks.ts";
import { makeDirectPostgresControlPlaneLayer, type PostgresClientLike, type PostgresQueryConfig } from "./postgres.ts";

const owner = "owner_00000000-0000-4000-8000-000000000001";
const fence = "f".repeat(64);
const request = {
  accountId: "account-original", communityId: "community-original", family: "study_v2" as const,
  sessionId: "session-original", producer: "v2_choice" as const,
  payload: { idempotencyKey: "answer-original", requestHash: "a".repeat(64) },
};
const original = {
  mainOperationId: "account_reward_original", sourceOwnerId: owner,
  sourceFamily: "study_v2", sessionId: request.sessionId, operationKind: "study_answer",
  idempotencyKey: request.payload.idempotencyKey, requestHash: request.payload.requestHash,
  qualificationId: "qualification-original", accountId: request.accountId,
  communityId: request.communityId, producerKind: request.producer, commandRef: null,
  state: "captured", completion: null, holdPresent: true, holdState: "pending",
  attemptFence: fence, attemptStarted: false, noAdmission: null,
};
function fixture(options: { unknownMarkerCommit?: boolean; foreignHash?: boolean; oldOrdinary?: boolean } = {}) {
  const queries: PostgresQueryConfig[] = [];
  const logs: unknown[] = [];
  let commits = 0;
  const client: PostgresClientLike = {
    connect: async () => {}, end: async () => {},
    query: async query => {
      queries.push(query);
      if (query.text === "COMMIT") {
        commits++;
        if (options.unknownMarkerCommit && commits === 2) throw new Error("opaque fixture driver text");
      }
      if (query.text.startsWith("SELECT current_setting")) return {
        rows: [{ transaction: "3s", lock: "250ms", statement: "2s", idle: "2s" }], rowCount: 1,
      };
      if (query.text.startsWith("SELECT prepare_account_owner_reward_action_v1")) return {
        rows: [{ result: options.oldOrdinary ? null : { ...original, requestHash: options.foreignHash ? "b".repeat(64) : original.requestHash } }], rowCount: 1,
      };
      if (query.text.startsWith("SELECT start_account_owner_reward_attempt_v1")) return {
        rows: [{ result: { ...original, attemptStarted: true } }], rowCount: 1,
      };
      if (query.text.startsWith("SELECT complete_account_owner_reward_action_v1")) return {
        rows: [{ result: { answer: { object: "fixture-actual-body" }, participation: { state: "not_yet_qualified" } } }], rowCount: 1,
      };
      if (query.text.startsWith("SELECT read_account_owner_reward_terms_private_v1")) return {
        rows: [{ result: null }], rowCount: 1,
      };
      return { rows: [], rowCount: 0 };
    },
  };
  const runtime = makeDirectPostgresControlPlaneLayer("postgres://fixture.invalid/account-reward-hooks", {
    clientFactory: () => client,
    logger: { info: (event, fields) => logs.push({ event, fields }), error: (event, fields) => logs.push({ event, fields }) },
  });
  return { queries, logs, runtime, hooks: makeControlPlaneAccountOwnerRewardHooks(runtime, null) };
}
test("original marker callback commits before owning body and carried fence reaches draw and completion", async () => {
  const f = fixture();
  const prepared = await Effect.runPromise(f.hooks.prepare(request));
  expect(prepared?.attemptFence).toBe(fence);
  expect(prepared?.attemptStarted).toBe(true);
  expect(f.queries.filter(q => q.text === "COMMIT")).toHaveLength(2);
  let bodyRan = false;
  const result = await Effect.runPromise(Effect.gen(function* () {
    const db = yield* ControlPlaneDb;
    return yield* db.withTransaction(tx => withAccountOwnerRewardMutation(f.hooks, tx, prepared,
      Effect.gen(function* () { yield* f.hooks.draw(tx, prepared); bodyRan = true; return { object: "fixture-actual-body" }; })));
  }).pipe(Effect.provide(f.runtime)));
  expect(result.object).toBe("fixture-actual-body");
  expect(bodyRan).toBe(true);
  const draw = f.queries.find(q => q.text.startsWith("SELECT lock_account_owner_reward_draw_v1"));
  const complete = f.queries.find(q => q.text.startsWith("SELECT complete_account_owner_reward_action_v1"));
  expect(draw?.values).toEqual([original.mainOperationId, fence]);
  expect(complete?.values?.slice(0, 2)).toEqual([original.mainOperationId, fence]);
});
test("marker COMMIT acknowledgment loss propagates typed unknown and never authorizes owning body", async () => {
  const f = fixture({ unknownMarkerCommit: true });
  const result = await Effect.runPromise(Effect.result(f.hooks.prepare(request)));
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(result.failure._tag).toBe("ControlPlaneTransactionOutcomeUnknown");
  expect(f.queries.some(q => /SELECT (enter_account|lock_account_owner_reward_draw|complete_account_owner_reward)/u.test(q.text))).toBe(false);
  expect(JSON.stringify(f.logs)).not.toContain("opaque fixture driver text");
});
test("coherent foreign request hash is refused before marker or owning invocation", async () => {
  const f = fixture({ foreignHash: true });
  const result = await Effect.runPromise(Effect.result(f.hooks.prepare(request)));
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(result.failure._tag).toBe("ControlPlaneStatementFailed");
  expect(f.queries.some(q => q.text.startsWith("SELECT start_account_owner_reward_attempt_v1"))).toBe(false);
});
test("retained ordinary2 source absence returns null without any new marker or producer authority", async () => {
  const f = fixture({ oldOrdinary: true });
  expect(await Effect.runPromise(f.hooks.prepare(request))).toBeNull();
  expect(f.queries.filter(q => q.text.startsWith("SELECT start_account_owner_reward_attempt_v1"))).toHaveLength(0);
  expect(f.queries.filter(q => q.text === "COMMIT")).toHaveLength(1);
});

const previewInput = {
  accountId: "account-original", personaId: "persona-original", communityId: "community-original",
  postId: "post-original", audioRevision: 1, lyricsRevision: 1,
  qualificationPolicyRevision: "study_session_first_pass_v2@1", disclosureVersion: "disclosure-original",
};
test("missing or invalid NEW-only server margin suppresses financial preview before any native invocation", async () => {
  for (const margin of [null, 0, 86401, Number.NaN]) {
    const f = fixture();
    expect(await Effect.runPromise(f.hooks.preview({ ...previewInput, purchaseSafetyMarginSeconds: margin }))).toBeNull();
    expect(f.queries).toHaveLength(0);
  }
});
test("valid NEW-only server margin reaches the exact ten-argument native quote without altering original metadata", async () => {
  const f = fixture();
  expect(await Effect.runPromise(f.hooks.preview({ ...previewInput, purchaseSafetyMarginSeconds: 300 }))).toBeNull();
  const leaf = f.queries.find(query => query.text.startsWith("SELECT read_account_owner_reward_terms_private_v1"));
  expect(leaf?.values).toEqual([previewInput.accountId, previewInput.personaId, previewInput.communityId,
    previewInput.postId, previewInput.audioRevision, previewInput.lyricsRevision,
    previewInput.qualificationPolicyRevision, previewInput.disclosureVersion, 300]);
  expect(leaf?.text).toContain("$9");
});
