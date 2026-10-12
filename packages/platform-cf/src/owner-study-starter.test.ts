// Outside proposal: adopt only through root. Mock driver exercises the actual
// Postgres transaction owner/typed failure bridge, not a mock withTransaction.
import { expect, test } from "bun:test";
import type { OwnerAwareStudyV2Store } from "@pirate/application";
import { GuestStudySessionV1, StudySessionV2 } from "@pirate/contracts";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { makeControlPlaneOwnerStudyStarter } from "./owner-study-starter.ts";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresClientLike,
  type PostgresQueryConfig,
} from "./postgres.ts";
import { projectStudySessionItemV2 } from "./study-v2-item-projection.ts";

type Start = Parameters<OwnerAwareStudyV2Store["startSession"]>[0];
const owner = "owner_00000000-0000-0000-0000-000000000001";
const foreignOwner = "owner_00000000-0000-0000-0000-000000000002";
const origin = "https://community.example";
const originalSessionId = "original-reservation-session";
const disclosure = {
  version: "reviewed-fixture-disclosure",
  text: "Synthetic reviewed fixture disclosure, no production policy.",
};
const policy = {
  version: "mock-policy-v1",
  costPolicyVersion: "mock-cost-v1",
  maximumOwnerActiveSessions: 2,
  maximumOwnerReservedPaidCallsPerRollingDay: 60,
  maximumGlobalActiveSessions: 100,
  maximumGlobalPaidCallsPerRollingDay: 1000,
  maximumGlobalCostMicrosPerRollingDay: "1000000",
  maximumOwnerCostMicrosPerRollingDay: "1000000",
  maximumTrustedEdgeSessionsPerWindow: 100,
  trustedEdgeWindowSeconds: 60,
  maximumProviderCallCostMicros: "1000",
};
const access: Start["access"] = {
  kind: "guest",
  ownerId: owner,
  credentialId: "AAAAAAAAAAAAAAAAAAAAAA",
  origin,
  leaseUntil: "2026-10-12T21:00:00.000Z",
};
const input: Start = {
  access,
  source: { kind: "guest", ownerId: owner },
  operation: {
    sourceOwnerId: owner,
    kind: "study_start",
    idempotencyKey: "original-start-key",
    requestHash: "a".repeat(64),
  },
  communityId: "study-community",
  postId: "study-post",
  sessionId: "fresh-unused-candidate",
  idempotencyKey: "original-start-key",
  requestHash: "a".repeat(64),
  createdAt: "2026-10-12T20:15:00.000Z",
  targetLanguage: null,
  learnerBand: null,
  timezone: "UTC",
  rewardMode: "practice_only",
  rewardTerms: null,
  disclosure: { version: disclosure.version, accepted: true },
  resourceReservationId: "original-reservation",
};
const preparedRows = Array.from({ length: 4 }, (_, index) => ({
  exercise_version_id: `exercise-${index + 1}`,
  exercise_review_key: `review-${index + 1}`,
  exercise_type: "say_it_back",
  exercise_variant: "spoken-recall-v2",
  community_id: input.communityId,
  post_id: input.postId,
  audio_revision: 1,
  lyrics_revision: 1,
  lyric_line_id: `line-${index + 1}`,
  line_version: 1,
  line_source_hash: "b".repeat(64),
  study_unit_id: `unit-${index + 1}`,
  learning_language: "en",
  target_language: null,
  learner_band: null,
  language_profile_revision: 1,
  presentation: {
    kind: "say_it_back",
    reference_text: `Prepared line ${index + 1}`,
    capture: "microphone_audio",
  },
  answer_visibility: "always_visible",
  feedback_release: "every_graded_attempt",
  grader_policy_revision: "script_aware_token_phonetic_v2",
  feedback_policy_revision: "spoken-feedback-v1",
  quality_policy_revision: "accepted-source-v1",
  ordinal: index + 1,
}));
const candidate = {
  state: "candidate",
  reservationId: input.resourceReservationId,
  sourceOwnerId: owner,
  sessionId: originalSessionId,
  targetLanguage: null,
  learnerBand: null,
  paidAttemptUnits: 24,
  catalogue: [
    {
      exercise_type: "say_it_back",
      learning_language: "en",
      target_language: null,
      learner_band: null,
      count: 4,
    },
  ],
  rows: preparedRows,
};
function guestSession(
  sessionId = originalSessionId,
  sourceOwner = owner,
  communityId = input.communityId,
  postId = input.postId,
) {
  const items = preparedRows.map((row, ordinal) =>
    projectStudySessionItemV2({ ...row, post_id: postId }, sessionId, ordinal),
  );
  return Schema.decodeUnknownSync(GuestStudySessionV1, { onExcessProperty: "error" })({
    object: "guest_study_session_v1",
    actor: { kind: "guest" },
    owner_id: sourceOwner,
    session_id: sessionId,
    community_id: communityId,
    post_id: postId,
    audio_revision: 1,
    lyrics_revision: 1,
    languages: { learning_language: "en", target_language: null },
    learner_band: null,
    study_profile_revision: 1,
    language_profile_revision: 1,
    source_set_revision: 1,
    selection_policy_revision: "study_selection_v1",
    qualification_policy_revision: "study_session_first_pass_v2@1",
    timezone: "UTC",
    status: "active",
    items,
    progress: {
      qualifying_exercise_count: 4,
      answered_exercise_count: 0,
      first_pass_correct: 0,
      required_correct: 3,
      score_bps: null,
    },
    lesson: {
      current: {
        session_item_id: items[0]?.session_item_id,
        presentation_number: 1,
        is_reappearance: false,
        presented_at: "2026-10-12T20:00:00.000Z",
      },
      resolved_card_count: 0,
      total_card_count: 4,
      presentation_count: 0,
      presentation_cap: 12,
      completion_reason: null,
    },
    created_at: "2026-10-12T20:00:00.000Z",
    completed_at: null,
    expires_at: "2026-10-13T20:00:00.000Z",
    reward_mode: "practice_only",
    reward_terms: null,
    participation: { state: "practice_only" },
  });
}
function guestResult(
  sessionId = originalSessionId,
  sourceOwner = owner,
  communityId = input.communityId,
  postId = input.postId,
) {
  return {
    source: { kind: "guest", ownerId: sourceOwner },
    session: guestSession(sessionId, sourceOwner, communityId, postId),
  };
}
function accountResult(accountId = "account-one", personaId = "persona-one") {
  const {
    actor: _actor,
    owner_id: _owner,
    expires_at: _expiry,
    reward_mode: _mode,
    reward_terms: _terms,
    participation: _participation,
    ...common
  } = guestSession();
  return {
    source: { kind: "account", ownerId: foreignOwner, accountId, personaId },
    session: Schema.decodeUnknownSync(StudySessionV2)({
      ...common,
      object: "study_session_v2",
      persona_id: personaId,
    }),
  };
}
const resolved = {
  state: "completed",
  operationId: "original-start-operation",
  result: guestResult(),
};
function fixture(
  options: {
    prepare?: unknown;
    commit?: unknown;
    read?: unknown;
    lookup?: unknown;
    limits?: Record<string, unknown>;
    commitFails?: boolean;
    rollbackFails?: boolean;
    extraEnvelope?: boolean;
    configuration?: typeof disclosure | null;
    rawPolicy?: unknown;
  } = {},
) {
  const queries: PostgresQueryConfig[] = [];
  const logs: unknown[] = [];
  const client: PostgresClientLike = {
    connect: async () => {},
    end: async () => {},
    query: async (query) => {
      queries.push(query);
      if (query.text === "COMMIT" && options.commitFails)
        throw new Error("opaque private COMMIT driver text");
      if (query.text === "ROLLBACK" && options.rollbackFails)
        throw new Error("opaque private ROLLBACK driver text");
      if (query.text.startsWith("SELECT current_setting"))
        return {
          rows: [
            options.limits === undefined
              ? { transaction: "3s", lock: "250ms", statement: "2s", idle: "2s" }
              : options.limits,
          ],
          rowCount: 1,
        };
      let result: unknown;
      if (query.text.startsWith("SELECT prepare_guest_study_start_v1"))
        result = options.prepare ?? candidate;
      else if (query.text.startsWith("SELECT commit_guest_study_start_v1"))
        result = options.commit ?? { ...resolved, operationId: "fresh-start-operation" };
      else if (query.text.startsWith("SELECT read_owner_study_session_snapshot_v1"))
        result = Object.hasOwn(options, "read") ? options.read : guestResult();
      else if (query.text.startsWith("SELECT find_guest_study_start_operation_v1"))
        result = options.lookup ?? { state: "completed", session: guestSession() };
      else return { rows: [], rowCount: 0 };
      return {
        rows: [options.extraEnvelope ? { result, private_grader: "never-public" } : { result }],
        rowCount: 1,
      };
    },
  };
  const runtime = makeDirectPostgresControlPlaneLayer("postgres://fixture.invalid/study", {
    clientFactory: () => client,
    logger: {
      info: (event, fields) => logs.push({ event, fields }),
      error: (event, fields) => logs.push({ event, fields }),
    },
  });
  return {
    store: makeControlPlaneOwnerStudyStarter(
      runtime,
      options.configuration === undefined ? disclosure : options.configuration,
      Object.hasOwn(options, "rawPolicy") ? options.rawPolicy : policy,
      () => "fresh-start-operation",
    ),
    queries,
    logs,
  };
}
async function failure(effect: Effect.Effect<unknown, unknown>) {
  const exit = await Effect.runPromiseExit(effect);
  if (!Exit.isFailure(exit)) throw new Error("expected typed failure");
  const error = Cause.findErrorOption(exit.cause);
  if (!Option.isSome(error)) throw new Error("expected typed failure");
  return error.value;
}
function rolledBack(f: ReturnType<typeof fixture>, error: unknown) {
  expect(error).toMatchObject({ _tag: "ControlPlaneStatementFailed" });
  expect(f.queries.at(-1)?.text).toBe("ROLLBACK");
  expect(f.queries.some((q) => q.text === "COMMIT")).toBe(false);
  expect(JSON.stringify(error)).not.toContain("never-public");
  expect(JSON.stringify(f.logs)).not.toContain("never-public");
}

test("new capture publishes reservation's original session only after acknowledged COMMIT; fresh server draws are ignored", async () => {
  const f = fixture();
  let published = 0;
  const result = await Effect.runPromise(
    f.store.startSession(input).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(f.queries.at(-1)?.text).toBe("COMMIT");
          published += 1;
        }),
      ),
    ),
  );
  expect(result).toMatchObject({
    state: "completed",
    operation: input.operation,
    result: { session: { session_id: originalSessionId, created_at: "2026-10-12T20:00:00.000Z" } },
  });
  expect(published).toBe(1);
  const commit = f.queries.find((q) => q.text.startsWith("SELECT commit_guest_study_start_v1"));
  expect(commit?.values?.[4]).toBe(input.resourceReservationId);
  expect(JSON.stringify(commit?.values)).not.toContain(input.sessionId);
  expect(JSON.stringify(commit?.values)).not.toContain(input.createdAt);
});
test("coherent foreign Guest session/source/community and Account account/persona output cannot cross read transaction", async () => {
  const accountAccess = {
    kind: "account",
    accountId: "account-one",
    sessionBinding: "fixture-authenticated-session",
  } as const;
  const wrongPersona = accountResult();
  wrongPersona.source.personaId = "persona-foreign";
  const cases = [
    { reply: guestResult("foreign-session"), access },
    { reply: guestResult(originalSessionId, foreignOwner), access },
    { reply: guestResult(originalSessionId, owner, "foreign-community"), access },
    { reply: { ...guestResult(), source: { kind: "guest", ownerId: foreignOwner } }, access },
    { reply: accountResult("foreign-account"), access: accountAccess },
    { reply: wrongPersona, access: accountAccess },
    { reply: guestResult(), access: accountAccess },
  ];
  for (const { reply, access: selectedAccess } of cases) {
    const f = fixture({ read: reply });
    rolledBack(
      f,
      await failure(
        f.store.getSession({
          access: selectedAccess,
          communityId: input.communityId,
          sessionId: originalSessionId,
        }),
      ),
    );
  }
  const valid = fixture({ read: accountResult() });
  expect(
    (
      await Effect.runPromise(
        valid.store.getSession({
          access: accountAccess,
          communityId: input.communityId,
          sessionId: originalSessionId,
        }),
      )
    )?.source.kind,
  ).toBe("account");
  const absent = fixture({ read: null });
  expect(
    await Effect.runPromise(
      absent.store.getSession({
        access,
        communityId: input.communityId,
        sessionId: originalSessionId,
      }),
    ),
  ).toBeNull();
});
test("completed lookup rejects coherent foreign owner/community/post; original empty-alias abort/absence is read-only", async () => {
  const lookup = {
    access,
    sourceOwnerId: owner,
    communityId: input.communityId,
    postId: input.postId,
    idempotencyKey: input.idempotencyKey,
  };
  for (const session of [
    guestSession(originalSessionId, foreignOwner),
    guestSession(originalSessionId, owner, "foreign-community"),
    guestSession(originalSessionId, owner, input.communityId, "foreign-post"),
  ]) {
    const f = fixture({ lookup: { state: "completed", session } });
    rolledBack(f, await failure(f.store.findStartOperation(lookup)));
  }
  // Mock SQL states represent actual independently-proved alias authorization;
  // this unit cannot establish SQL ownership. Real alias PG proof is separate.
  for (const state of ["not_started", "pending_confirmation"] as const) {
    const f = fixture({ lookup: { state, session: null } });
    const result = await Effect.runPromise(
      f.store.findStartOperation({ ...lookup, sourceOwnerId: foreignOwner }),
    );
    expect(result).toEqual({ state, session: null });
    expect(f.queries.filter((q) => q.text.includes("_guest_study_start_v1")).length).toBe(0);
    const query = f.queries.find((q) =>
      q.text.startsWith("SELECT find_guest_study_start_operation_v1"),
    );
    expect(query?.values?.[1]).toBe(foreignOwner);
    expect(f.queries.at(-1)?.text).toBe("COMMIT");
  }
});
test("NEW completed commit bound to original reservation rejects schema-valid wrong session and rolls back", async () => {
  const f = fixture({
    commit: {
      ...resolved,
      operationId: "fresh-start-operation",
      result: guestResult("foreign-session"),
    },
  });
  rolledBack(f, await failure(f.store.startSession(input)));
  expect(f.queries.some((q) => q.text.startsWith("SELECT commit_guest_study_start_v1"))).toBe(true);
});
test("closed prepared SELECT rejects extra/missing/private and foreign source/revision fields before commit", async () => {
  const firstRow = preparedRows[0];
  if (firstRow === undefined) throw new Error("prepared fixture row missing");
  const { community_id: _community, ...missingCommunity } = firstRow;
  const changes = [
    { ...preparedRows[0], private_grader: "never-public" },
    missingCommunity,
    { ...preparedRows[0], community_id: "foreign-community" },
    { ...preparedRows[0], post_id: "foreign-post" },
    { ...preparedRows[0], audio_revision: 2 },
    { ...preparedRows[0], language_profile_revision: null },
    { ...preparedRows[0], audio_revision: 9007199254740992 },
    { ...preparedRows[0], learner_band: "A0" },
  ];
  for (const changed of changes) {
    const f = fixture({ prepare: { ...candidate, rows: [changed, ...preparedRows.slice(1)] } });
    rolledBack(f, await failure(f.store.startSession(input)));
    expect(f.queries.some((q) => q.text.startsWith("SELECT commit_guest_study_start_v1"))).toBe(
      false,
    );
  }
});
test("strict unknown limit/envelope decoding fails inside transaction and preserves safe private errors", async () => {
  for (const limits of [
    { transaction: null, lock: "250ms", statement: "2s", idle: "2s" },
    { transaction: "3s", lock: "250ms", statement: "2s", idle: "2s", secret: "never-public" },
    { transaction: "3s", lock: "250ms", statement: "2s", idle: "20s" },
  ]) {
    const f = fixture({ limits });
    rolledBack(f, await failure(f.store.startSession(input)));
    expect(f.queries.some((q) => q.text.startsWith("SELECT prepare_guest_study_start_v1"))).toBe(
      false,
    );
  }
  const envelope = fixture({ extraEnvelope: true });
  rolledBack(envelope, await failure(envelope.store.startSession(input)));
});
test("completed original receipt survives changed current config/disclosure and fresh candidate without recapture", async () => {
  const f = fixture({
    prepare: resolved,
    rawPolicy: null,
    configuration: { ...disclosure, version: "current-disclosure-v2" },
  });
  const result = await Effect.runPromise(
    f.store.startSession({
      ...input,
      sessionId: "another-fresh-draw",
      disclosure: { version: "old-reviewed-disclosure", accepted: false },
    }),
  );
  expect(result).toMatchObject({
    state: "completed",
    result: { session: { session_id: originalSessionId } },
  });
  expect(f.queries.some((q) => q.text.startsWith("SELECT commit_guest_study_start_v1"))).toBe(
    false,
  );
});
test("sent COMMIT and rollback acknowledgment loss never publish a completed result", async () => {
  for (const options of [
    { commitFails: true },
    {
      commit: {
        ...resolved,
        operationId: "fresh-start-operation",
        result: guestResult("foreign-session"),
      },
      rollbackFails: true,
    },
  ]) {
    const f = fixture(options);
    let published = 0;
    const error = await failure(
      f.store.startSession(input).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            published += 1;
          }),
        ),
      ),
    );
    expect(error).toMatchObject({ _tag: "ControlPlaneTransactionOutcomeUnknown" });
    expect(published).toBe(0);
    expect(JSON.stringify(error)).not.toContain("opaque private");
    expect(JSON.stringify(f.logs)).not.toContain("opaque private");
  }
});

test("new commit rejects an unrelated durable outcome locator for the valid original source and session", async () => {
  const f = fixture({ commit: { ...resolved, operationId: "foreign-start-operation" } });
  rolledBack(f, await failure(f.store.startSession(input)));
});

test("missing current disclosure and policy preserve original receipt; missing disclosure rejects NEW before capture", async () => {
  const old = fixture({ prepare: resolved, configuration: null, rawPolicy: null });
  expect(await Effect.runPromise(old.store.startSession(input))).toMatchObject({
    state: "completed",
    result: { session: { session_id: originalSessionId } },
  });
  expect(old.queries.at(-1)?.text).toBe("COMMIT");
  expect(old.queries.some((q) => q.text.startsWith("SELECT commit_guest_study_start_v1"))).toBe(
    false,
  );
  const fresh = fixture({ configuration: null });
  expect(await failure(fresh.store.startSession(input))).toMatchObject({
    _tag: "GuestParticipationStoreRejected",
    reason: "resource-policy-unavailable",
  });
  expect(fresh.queries.at(-1)?.text).toBe("ROLLBACK");
  expect(fresh.queries.some((q) => q.text.startsWith("SELECT commit_guest_study_start_v1"))).toBe(
    false,
  );
});
