import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import {
  ControlPlaneDb,
  type ControlPlaneStatement,
  ControlPlaneStatementFailed,
  type ControlPlaneTransaction,
  ControlPlaneTransactionOutcomeUnknown,
} from "../../application/src/ports.ts";
import {
  executeDanceReviewCommand,
  projectPrivateDanceReview,
} from "../../application/src/use-cases/dance/moderator-review-services.ts";
import {
  type ModeratorReview,
  transitionModeratorReview,
} from "../../domain/src/dance/moderator-review.ts";
import { ModeratorReviewSchema } from "../../domain/src/dance/moderator-review-schema.ts";
import { moderatedDanceFixture } from "../../testing/src/moderated-dance-fixture.ts";
import { makeControlPlaneModeratorReviewStore } from "./dance-moderator-review-repository.ts";

/** SQL packet driver, not SQL isolation/authorization proof. The real application,
 * decoder, transaction wrapper and projection consumers run without sockets. */
function fixture() {
  const original = moderatedDanceFixture();
  let state = original.state;
  let actor = "dancer";
  let now = 2000;
  let facts = {
    ...original.facts,
    submissionDay: { atMs: 2000, day: "1970-01-01", timezone: "UTC", timezoneVersion: "tz-v1" },
  };
  let unavailableFacts = false;
  let denied = false;
  let loseCommit = false;
  let qualifiedId: string | null | undefined;
  let commitCalls = 0;
  const statements: ControlPlaneStatement[] = [];
  const receipts = new Map<string, { requestHash: string; receipt: unknown }>();
  const commandKey = (a: {
    actor: { kind: string; accountId: string };
    operation: string;
    idempotencyKey: string;
  }) => JSON.stringify([a.actor.kind, a.actor.accountId, a.operation, a.idempotencyKey]);
  const execute: ControlPlaneTransaction["execute"] = <Row>(statement: ControlPlaneStatement) =>
    Effect.gen(function* () {
      statements.push(statement);
      let value: unknown;
      switch (statement.label) {
        case "dance-review.authorized-lock":
          if (denied)
            return yield* new ControlPlaneStatementFailed({
              label: statement.label,
              sqlState: "DRV02",
              constraint: null,
              outcomeCertainty: "aborted",
            });
          value = state;
          break;
        case "dance-review.receipt.read": {
          const action = JSON.parse(String(statement.values[0]));
          value = receipts.get(commandKey(action)) ?? null;
          break;
        }
        case "dance-review.locked-clock":
          value = String(now);
          break;
        case "dance-review.current-facts":
          if (unavailableFacts)
            return yield* new ControlPlaneStatementFailed({
              label: statement.label,
              sqlState: null,
              constraint: null,
              outcomeCertainty: "aborted",
            });
          value = facts;
          break;
        case "dance-review.commit": {
          const input = JSON.parse(String(statement.values[0]));
          commitCalls++;
          state = input.transition.state;
          receipts.set(commandKey(input.action), {
            requestHash: input.action.requestHash,
            receipt: input.receipt,
          });
          value = {
            committed: true,
            qualificationId: qualifiedId === undefined ? state.qualificationRef : qualifiedId,
          };
          break;
        }
        case "dance-review.result.read":
          value = denied ? null : state;
          break;
        case "dance-review.latest.read":
          value = { latest: state, activeSessionId: null };
          break;
        default:
          if (!statement.label.startsWith("activity-qualification."))
            throw new Error(`Unexpected SQL ${statement.label}`);
          return { rows: [] as Row[], rowCount: 0 };
      }
      return { rows: [{ packet: value }] as Row[], rowCount: 1 };
    });
  const db = ControlPlaneDb.of({
    execute,
    withTransaction: (use) =>
      Effect.gen(function* () {
        const result = yield* use({ execute });
        if (loseCommit)
          return yield* new ControlPlaneTransactionOutcomeUnknown({
            phase: "commit",
            label: "COMMIT",
            limitMs: 100,
            elapsedMs: 100,
          });
        return result;
      }),
  });
  const store = makeControlPlaneModeratorReviewStore(Layer.succeed(ControlPlaneDb, db), {
    account: () => Effect.succeed({ kind: "account", accountId: actor }),
    worker: () => Effect.succeed({ kind: "worker", accountId: "review-worker" }),
  });
  return {
    store,
    statements,
    receipts,
    get state() {
      return state;
    },
    set state(s: ModeratorReview) {
      state = s;
    },
    get facts() {
      return facts;
    },
    set facts(f: typeof facts) {
      facts = f;
    },
    set actor(a: string) {
      actor = a;
    },
    set now(n: number) {
      now = n;
    },
    set unavailableFacts(v: boolean) {
      unavailableFacts = v;
    },
    set denied(v: boolean) {
      denied = v;
    },
    set loseCommit(v: boolean) {
      loseCommit = v;
    },
    set qualifiedId(v: string | null) {
      qualifiedId = v;
    },
    get commitCalls() {
      return commitCalls;
    },
  };
}
const submit = {
  version: "dance-review-submit-v1",
  operation: "submit",
  community_id: "community",
  review_id: "review",
  idempotency_key: "submit-key",
  expected_review_revision: 1,
  show_publicly_if_passed: false,
  publication_disclosure_version: "disclosure-v1",
} as const;
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe("real categorical review repository (offline SQL packets)", () => {
  test("known commit replays the private receipt before clock/facts, but cannot bypass private erasure access", async () => {
    const f = fixture();
    const first = await run(executeDanceReviewCommand(submit, f.store));
    expect(first.outcome).toBe("applied");
    expect(f.commitCalls).toBe(1);
    f.statements.length = 0;
    f.unavailableFacts = true;
    f.now = 900000000;
    expect(await run(executeDanceReviewCommand(submit, f.store))).toEqual(first);
    expect(f.statements.map((s) => s.label)).toEqual([
      "dance-review.authorized-lock",
      "dance-review.receipt.read",
    ]);
    expect(f.commitCalls).toBe(1);
    f.denied = true;
    await expect(run(executeDanceReviewCommand(submit, f.store))).rejects.toMatchObject({
      reason: "not_found",
    });
    expect(f.commitCalls).toBe(1);
  });
  test("changed same key conflicts without reading fresh facts or mutating", async () => {
    const f = fixture();
    await run(executeDanceReviewCommand(submit, f.store));
    f.unavailableFacts = true;
    f.statements.length = 0;
    await expect(
      run(executeDanceReviewCommand({ ...submit, show_publicly_if_passed: true }, f.store)),
    ).rejects.toMatchObject({ reason: "idempotency_conflict" });
    expect(f.statements.map((s) => s.label)).toEqual([
      "dance-review.authorized-lock",
      "dance-review.receipt.read",
    ]);
    expect(f.commitCalls).toBe(1);
  });
  test("unknown COMMIT is not success or a callback retry; original identity is recoverable", async () => {
    const f = fixture();
    f.loseCommit = true;
    await expect(run(executeDanceReviewCommand(submit, f.store))).rejects.toMatchObject({
      reason: "outcome_unknown",
    });
    expect(f.commitCalls).toBe(1);
    expect(f.receipts.size).toBe(1);
    f.loseCommit = false;
    f.unavailableFacts = true;
    const recovered = await run(executeDanceReviewCommand(submit, f.store));
    expect(recovered.outcome).toBe("applied");
    expect(f.commitCalls).toBe(1);
    expect(recovered.result).toEqual(await run(f.store.getOwnResult("community", "review")));
  });
  test("only confirmed categorical qualification is projected, with frozen submission day and verdict timestamp", async () => {
    const f = fixture();
    await run(executeDanceReviewCommand(submit, f.store));
    const screened = transitionModeratorReview(
      f.state,
      { kind: "screen" },
      { kind: "worker", accountId: "review-worker" },
      f.state.revision,
      3000,
      f.facts,
    );
    expect(screened.refusal).toBeNull();
    f.state = screened.state;
    f.actor = "owner";
    f.now = 90000000;
    f.facts = {
      ...f.facts,
      submissionDay: {
        atMs: 90000000,
        day: "1970-01-02",
        timezone: "UTC",
        timezoneVersion: "tz-v1",
      },
    };
    f.statements.length = 0;
    const verdict = {
      version: "dance-owner-verdict-attestation-v1",
      operation: "verdict",
      community_id: "community",
      review_id: "review",
      idempotency_key: "verdict-key",
      expected_review_revision: f.state.revision,
      verdict: "passed",
    } as const;
    const result = await run(executeDanceReviewCommand(verdict, f.store));
    expect(result.outcome).toBe("applied");
    expect(f.state.qualificationRef).toBe("review");
    const commit = f.statements.find((s) => s.label === "dance-review.commit");
    const payload = JSON.parse(String(commit?.values[0]));
    const qualification = payload.transition.intents.find(
      (i: { kind: string }) => i.kind === "qualification",
    ).qualification;
    expect(qualification.score_bps).toBeNull();
    expect(qualification.calibration).toBeNull();
    expect(qualification.floor).toBeNull();
    const day = f.statements.find((s) => s.label === "activity-qualification.song-day.insert");
    expect(day?.values).toContain("1970-01-01");
    expect(day?.values).toContain("1970-01-02T01:00:00.000Z");
    expect(f.statements.indexOf(commit!)).toBeLessThan(f.statements.indexOf(day!));
    expect(
      f.statements.filter((s) => s.label === "activity-qualification.song-day.insert"),
    ).toHaveLength(1);
    expect(result.result).toEqual(projectPrivateDanceReview(f.state));
  });
  test("strict storage decoding refuses missing authority and synthetic categorical scores", () => {
    const f = fixture();
    const decode = Schema.decodeUnknownSync(ModeratorReviewSchema, { onExcessProperty: "error" });
    expect(decode(f.state)).toEqual(f.state);
    expect(() => decode({ ...f.state, capture: { ...f.state.capture, policy: null } })).toThrow();
    expect(() => decode({ ...f.state, scoreBps: 10000 })).toThrow();
  });
});
