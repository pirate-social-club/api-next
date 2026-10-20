import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { decodeDanceReviewCommandReceiptV1 } from "../../../../contracts/src/dance-review.ts";
import {
  initializeModeratorReview,
  type ModeratorReview,
  type ReviewActor,
  type ReviewFacts,
  type ReviewIntent,
  type SealedReviewCapture,
} from "../../../../domain/src/dance/moderator-review.ts";
import {
  type DanceReviewAction,
  DanceReviewServiceFailure,
  type DanceReviewServices,
  type DanceReviewTransaction,
  executeDanceReviewCommand,
  processDanceReviewTask,
  projectPrivateDanceReview,
} from "./moderator-review-services.ts";

const h = (c: string) => c.repeat(64);
function fixture() {
  const capture: SealedReviewCapture = {
    reviewId: "review",
    sessionId: "session",
    attemptId: "attempt",
    accountId: "dancer",
    personaId: "persona",
    communityId: "community",
    songPostId: "song",
    audioRevision: 1,
    choreographyId: "dance",
    choreographyRevision: 1,
    segmentId: "segment",
    termsHash: h("3"),
    accountFenceRevision: 1,
    uploadId: "upload",
    sourceDigest: h("4"),
    normalizedDigest: h("5"),
    analysisRevision: 1,
    firstStoredAtMs: 500,
    uploadedAtMs: 1000,
    captureExpiresAtMs: 5000,
    bodyStartMs: 2000,
    bodyEndMs: 12000,
    cueId: "cue",
    cueStartMs: 0,
    cueEndMs: 2000,
    cueHoldMs: 1000,
    timezone: "UTC",
    timezoneVersion: "tz-v1",
    rewardMode: "practice",
    objectives: [],
    policy: {
      version: "moderator-review-policy-v1",
      hash: h("a"),
      qualificationVersion: "qualification-v1",
      qualificationHash: h("b"),
      rubricVersion: "rubric-v1",
      rubricHash: h("c"),
      disclosureVersion: "disclosure-v1",
      consentVersion: "consent-v1",
      consentHash: h("d"),
      normalizationVersion: "normalization-v1",
      normalizationHash: h("e"),
      safetyHash: h("f"),
      retentionHash: h("1"),
      reviewWindowMs: 604800000,
      admission: "streak_admitted",
      admissionVersion: "admission-v1",
      admissionHash: h("2"),
      producerId: "moderator-producer",
    },
    consent: {
      receiptId: "consent",
      uploadId: "upload",
      recordedAtMs: 0,
      accountId: "dancer",
      personaId: "persona",
      termsHash: h("3"),
      version: "consent-v1",
      policyHash: h("d"),
    },
  };
  const facts: ReviewFacts = {
    accountActive: true,
    accountFenceRevision: 1,
    workerAuthorized: true,
    ownedPersona: {
      active: true,
      accountId: "dancer",
      personaId: "persona",
      communityId: "community",
    },
    owner: {
      accountId: "owner",
      communityId: "community",
      assignmentId: "assignment",
      revision: 1,
      canInspect: true,
    },
    referenceCutoffAtMs: null,
    media: {
      accepted: true,
      sourceDigest: h("4"),
      normalizedDigest: h("5"),
      normalizationVersion: "normalization-v1",
      normalizationHash: h("e"),
    },
    safety: {
      status: "accepted",
      persisted: true,
      sourceDigest: h("4"),
      analysisRevision: 1,
      policyHash: h("f"),
      frameDigests: [h("6"), h("7"), h("8")],
    },
    integrity: {
      status: "unique",
      persisted: true,
      sourceDigest: h("4"),
      normalizedDigest: h("5"),
      policyHash: h("e"),
    },
    disposition: {
      accepted: true,
      version: "disposition-v1",
      hash: h("1"),
      validUntilMs: 10000000000,
      cleanupWithinMs: 1000,
      temporaryCleanupWithinMs: 500,
      transferWithinMs: 100,
      hold: null,
    },
    submissionDay: null,
    qualification: {
      admitted: true,
      producerId: "moderator-producer",
      policyVersion: "qualification-v1",
      policyHash: h("b"),
      admissionVersion: "admission-v1",
      admissionHash: h("2"),
    },
  };
  const state = initializeModeratorReview(capture, facts, 1000);
  if (!state) throw new Error("Invalid fictional offline fixture");
  return { state, facts };
}

/** Per-test port implementation only. Serialized draft/commit and injected
 * lost acknowledgements do not prove actual SQL isolation, media or deletion.
 */
class MemoryPorts implements DanceReviewServices {
  state: ModeratorReview;
  factsValue: ReviewFacts;
  actor: ReviewActor = { kind: "account", accountId: "dancer" };
  now = 2000;
  readonly trace: string[] = [];
  readonly effects = new Map<string, ReviewIntent>();
  readonly receipts = new Map<string, { requestHash: string; receipt: unknown }>();
  transactions = 0;
  commits = 0;
  factReads = 0;
  clockReads = 0;
  lookupUnknown = false;
  factsUnavailable = false;
  clockUnavailable = false;
  privateReadDenied = false;
  loseCommitAck = false;
  failCommit = false;
  onLock: (() => void) | null = null;
  onCommit: (() => void) | null = null;
  private tail: Promise<void> = Promise.resolve();
  constructor() {
    const f = fixture();
    this.state = f.state;
    this.factsValue = f.facts;
  }
  readonly authenticateAccount = () =>
    Effect.sync(() => {
      this.trace.push("authenticate-account");
      return this.actor;
    });
  readonly authenticateWorker = () =>
    Effect.sync(() => {
      this.trace.push("authenticate-worker");
      return this.actor;
    });
  private key(a: DanceReviewAction) {
    return JSON.stringify([a.actor.kind, a.actor.accountId, a.operation, a.idempotencyKey]);
  }
  readonly withTransaction = <A, E, R>(
    use: (tx: DanceReviewTransaction) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | DanceReviewServiceFailure, R> => {
    const self = this;
    return Effect.acquireUseRelease(
      Effect.promise(async () => {
        const prior = self.tail;
        let release = () => {};
        self.tail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await prior;
        return release;
      }),
      () =>
        Effect.gen(function* () {
          self.transactions++;
          let draft = structuredClone(self.state);
          const receipts = new Map(self.receipts),
            effects = new Map(self.effects);
          let committed = false;
          const tx: DanceReviewTransaction = {
            lockAndAuthorizeRead: (a) =>
              Effect.suspend(() => {
                self.trace.push("lock-and-private-read");
                self.onLock?.();
                const owner = self.factsValue.owner;
                if (
                  self.privateReadDenied ||
                  a.reviewId !== draft.capture.reviewId ||
                  a.communityId !== draft.capture.communityId ||
                  (a.actor.kind === "account" &&
                    (!self.factsValue.accountActive ||
                      self.factsValue.accountFenceRevision !==
                        draft.capture.accountFenceRevision)) ||
                  (a.actor.kind === "account" &&
                    a.actor.accountId !== draft.capture.accountId &&
                    !(
                      a.operation === "verdict" &&
                      owner?.accountId === a.actor.accountId &&
                      owner.canInspect &&
                      owner.communityId === draft.capture.communityId &&
                      self.factsValue.safety?.status === "accepted"
                    ))
                )
                  return Effect.fail(new DanceReviewServiceFailure({ reason: "not_found" }));
                return Effect.succeed(draft);
              }),
            findReceipt: (a) =>
              Effect.suspend(() => {
                self.trace.push("lookup");
                return self.lookupUnknown
                  ? Effect.fail(new DanceReviewServiceFailure({ reason: "outcome_unknown" }))
                  : Effect.succeed(receipts.get(self.key(a)) ?? null);
              }),
            clockAfterLocks: () =>
              Effect.suspend(() => {
                self.trace.push("clock-after-locks");
                self.clockReads++;
                return self.clockUnavailable
                  ? Effect.fail(new DanceReviewServiceFailure({ reason: "unavailable" }))
                  : Effect.succeed(self.now);
              }),
            facts: (_s, _a, _o, now) =>
              Effect.suspend(() => {
                self.trace.push("facts");
                self.factReads++;
                return self.factsUnavailable
                  ? Effect.fail(new DanceReviewServiceFailure({ reason: "unavailable" }))
                  : Effect.succeed({
                      ...self.factsValue,
                      submissionDay: {
                        atMs: now,
                        day: "1970-01-01",
                        timezone: "UTC",
                        timezoneVersion: "tz-v1",
                      },
                    });
              }),
            commit: (p) =>
              Effect.suspend(() => {
                self.trace.push("commit");
                self.onCommit?.();
                if (self.failCommit)
                  return Effect.fail(new DanceReviewServiceFailure({ reason: "unavailable" }));
                if (
                  draft.revision !== p.beforeReviewRevision ||
                  draft.publicationRevision !== p.beforePublicationRevision ||
                  draft.capture.accountFenceRevision !== p.captureAccountFenceRevision ||
                  self.factsValue.accountFenceRevision !== p.observedAccountFenceRevision ||
                  self.factsValue.accountActive !== p.observedAccountActive ||
                  receipts.has(self.key(p.action))
                )
                  return Effect.fail(new DanceReviewServiceFailure({ reason: "outcome_unknown" }));
                draft = structuredClone(p.transition.state);
                receipts.set(self.key(p.action), {
                  requestHash: p.action.requestHash,
                  receipt: structuredClone(p.receipt),
                });
                for (const i of p.transition.intents)
                  if (!effects.has(i.key)) effects.set(i.key, structuredClone(i));
                committed = true;
                return Effect.void;
              }),
          };
          const value = yield* use(tx);
          if (committed) {
            self.commits++;
            self.state = draft;
            self.receipts.clear();
            for (const [k, v] of receipts) self.receipts.set(k, v);
            self.effects.clear();
            for (const [k, v] of effects) self.effects.set(k, v);
            if (self.loseCommitAck) {
              self.loseCommitAck = false;
              return yield* new DanceReviewServiceFailure({ reason: "outcome_unknown" });
            }
          }
          return value;
        }),
      (release) => Effect.sync(release),
    );
  };
}
const common = { community_id: "community", review_id: "review" };
const submit = {
  ...common,
  version: "dance-review-submit-v1",
  operation: "submit",
  idempotency_key: "submit",
  expected_review_revision: 1,
  show_publicly_if_passed: true,
  publication_disclosure_version: "disclosure-v1",
};
const run = (body: unknown, p: MemoryPorts) =>
  Effect.runPromise(executeDanceReviewCommand(body, p));
const task = (body: unknown, p: MemoryPorts) => Effect.runPromise(processDanceReviewTask(body, p));
async function ready(p: MemoryPorts) {
  await run(submit, p);
  p.actor = { kind: "worker", accountId: "worker" };
  p.now = 3000;
  await task(
    {
      ...common,
      version: "dance-review-task-v1",
      operation: "screen",
      idempotency_key: "screen",
      expected_review_revision: p.state.revision,
    },
    p,
  );
  p.actor = { kind: "account", accountId: "owner" };
  p.now = 4000;
}
const verdict = (p: MemoryPorts, key = "verdict", choice = "passed") => ({
  ...common,
  version: "dance-owner-verdict-attestation-v1",
  operation: "verdict",
  idempotency_key: key,
  expected_review_revision: p.state.revision,
  verdict: choice,
});

describe("offline moderated Dance application ports", () => {
  test("authenticate before strict decode; browser cannot provide actor, worker evidence or scores", async () => {
    const p = new MemoryPorts();
    for (const extra of [
      { actor_account_id: "owner" },
      { score_bps: 10000 },
      { safety_accepted: true },
      { reward_mode: "reward_eligible" },
    ])
      await expect(run({ ...submit, ...extra }, p)).rejects.toMatchObject({
        reason: "invalid_request",
      });
    await expect(
      run(
        {
          ...common,
          version: "dance-review-task-v1",
          operation: "screen",
          idempotency_key: "forged",
          expected_review_revision: 1,
        },
        p,
      ),
    ).rejects.toMatchObject({ reason: "invalid_request" });
    expect(p.transactions).toBe(0);
    expect(p.trace.every((e) => e === "authenticate-account")).toBe(true);
  });
  test("Submit replay is immutable after edits and bypasses NEW clock/evidence rules; changed same-key body conflicts", async () => {
    const p = new MemoryPorts();
    const first = await run(submit, p);
    await run(
      {
        ...common,
        version: "dance-review-visibility-v1",
        operation: "visibility",
        idempotency_key: "off",
        expected_review_revision: p.state.revision,
        show_publicly_if_passed: false,
        publication_disclosure_version: "disclosure-v1",
      },
      p,
    );
    expect(p.state.initialSubmit?.showPublicly).toBe(true);
    expect(projectPrivateDanceReview(p.state).show_publicly_if_passed).toBe(false);
    const reads = [p.clockReads, p.factReads, p.commits, p.effects.size];
    p.clockUnavailable = true;
    p.factsUnavailable = true;
    expect(await run(submit, p)).toEqual(first);
    expect([p.clockReads, p.factReads, p.commits, p.effects.size]).toEqual(reads);
    await expect(run({ ...submit, show_publicly_if_passed: false }, p)).rejects.toMatchObject({
      reason: "idempotency_conflict",
    });
    p.privateReadDenied = true;
    await expect(run(submit, p)).rejects.toMatchObject({ reason: "not_found" });
  });
  test("distinct-key same-value visibility stores only its receipt, not another revision or effect", async () => {
    const p = new MemoryPorts();
    await run(submit, p);
    const rev = p.state.revision,
      effects = p.effects.size;
    const same = {
      ...common,
      version: "dance-review-visibility-v1",
      operation: "visibility",
      idempotency_key: "same-choice",
      expected_review_revision: rev,
      show_publicly_if_passed: true,
      publication_disclosure_version: "disclosure-v1",
    };
    const receipt = await run(same, p);
    expect(receipt.outcome).toBe("applied");
    expect(p.state.revision).toBe(rev);
    expect(p.effects.size).toBe(effects);
    expect(p.receipts.size).toBe(2);
    expect(await run(same, p)).toEqual(receipt);
    expect(p.receipts.size).toBe(2);
  });
  test("lock precedes authoritative clock; a verdict waiting until deadline commits Not reviewed refusal", async () => {
    const p = new MemoryPorts();
    await ready(p);
    const body = verdict(p);
    p.onLock = () => {
      p.now = p.state.reviewDeadlineMs;
    };
    const receipt = await run(body, p);
    expect(receipt.outcome).toBe("refused");
    expect(receipt.refusal_code).toBe("review_deadline_reached");
    expect(p.state.state).toBe("review_expired");
    expect(p.state.verdict).toBeNull();
    expect(p.trace.lastIndexOf("lock-and-private-read")).toBeLessThan(
      p.trace.lastIndexOf("clock-after-locks"),
    );
    expect([...p.effects.values()].some((i) => i.kind === "qualification")).toBe(false);
  });
  test("current owner transfer and inspection gates preserve no-self-review", async () => {
    const p = new MemoryPorts();
    await ready(p);
    const previousOwner = p.factsValue.owner;
    if (previousOwner === null) throw new Error("Expected fixture owner");
    p.factsValue = {
      ...p.factsValue,
      owner: { ...previousOwner, accountId: "new-owner", revision: 2 },
    };
    await expect(run(verdict(p), p)).rejects.toMatchObject({ reason: "not_found" });
    p.actor = { kind: "account", accountId: "new-owner" };
    expect((await run(verdict(p), p)).result.verdict).toBe("passed");
    expect(p.state.attestation?.assignmentRevision).toBe(2);
    const q = new MemoryPorts();
    await ready(q);
    q.actor = { kind: "account", accountId: "dancer" };
    const nextOwner = q.factsValue.owner;
    if (nextOwner === null) throw new Error("Expected fixture owner");
    q.factsValue = { ...q.factsValue, owner: { ...nextOwner, accountId: "dancer" } };
    expect((await run(verdict(q), q)).refusal_code).toBe("self_review");
  });
  test("competing terminal commands produce one result/qualification/handoff under serialized fake ports", async () => {
    const p = new MemoryPorts();
    await ready(p);
    const pass = verdict(p, "pass", "passed"),
      fail = verdict(p, "fail", "not_passed");
    const results = await Promise.all([run(pass, p), run(fail, p)]);
    expect(results.filter((r) => r.outcome === "applied")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "refused")).toHaveLength(1);
    for (const kind of ["result", "qualification", "handoff_release"])
      expect([...p.effects.values()].filter((i) => i.kind === kind)).toHaveLength(1);
    expect(p.state.attestation?.cue).toBe("affirmed");
    expect(
      [...p.effects.values()].find((i) => i.kind === "qualification")?.qualification?.score_bps,
    ).toBeNull();
  });
  test("unknown COMMIT acknowledgement never triggers an automatic callback or new effect; original receipt recovers", async () => {
    const p = new MemoryPorts();
    p.loseCommitAck = true;
    await expect(run(submit, p)).rejects.toMatchObject({ reason: "outcome_unknown" });
    expect(p.transactions).toBe(1);
    expect(p.commits).toBe(1);
    expect(p.state.state).toBe("screening");
    expect(p.receipts.size).toBe(1);
    expect(p.effects.size).toBe(1);
    const stored = [...p.receipts.values()][0];
    if (stored === undefined) throw new Error("Expected committed receipt");
    const original = decodeDanceReviewCommandReceiptV1(stored.receipt);
    p.clockUnavailable = true;
    p.factsUnavailable = true;
    expect(await run(submit, p)).toEqual(original);
    expect(p.commits).toBe(1);
    expect(p.effects.size).toBe(1);
    const q = new MemoryPorts();
    q.lookupUnknown = true;
    await expect(run(submit, q)).rejects.toMatchObject({ reason: "outcome_unknown" });
    expect(q.clockReads).toBe(0);
    expect(q.commits).toBe(0);
    expect(q.state.state).toBe("uploaded");
  });
  test("a failed atomic persistence call cannot expose success or leave a partial receipt/state/effect", async () => {
    const p = new MemoryPorts();
    p.failCommit = true;
    await expect(run(submit, p)).rejects.toMatchObject({ reason: "unavailable" });
    expect(p.state.state).toBe("uploaded");
    expect(p.receipts.size).toBe(0);
    expect(p.effects.size).toBe(0);
  });
  test("withdrawal and later publication failure preserve their original private results and effect identities", async () => {
    const p = new MemoryPorts();
    await ready(p);
    p.actor = { kind: "account", accountId: "dancer" };
    const body = {
      ...common,
      version: "dance-review-withdraw-v1",
      operation: "withdraw",
      idempotency_key: "withdraw",
      expected_review_revision: p.state.revision,
    };
    const withdrawn = await run(body, p);
    expect(withdrawn.result.state).toBe("withdrawn");
    expect(await run(body, p)).toEqual(withdrawn);
    expect(p.state.qualificationRef).toBeNull();
    const q = new MemoryPorts();
    await ready(q);
    const passed = await run(verdict(q), q);
    const rev = q.state.revision;
    q.actor = { kind: "worker", accountId: "worker" };
    q.now = 4001;
    const failure = {
      ...common,
      version: "dance-review-task-v1",
      operation: "publication_failed",
      idempotency_key: "publication-failure",
      expected_review_revision: rev,
      handoff_generation: q.state.generation,
    };
    const result = await task(failure, q);
    expect(result.result.verdict).toBe("passed");
    expect(result.result.qualification_ref).toBe(passed.result.qualification_ref);
    expect(result.result.publication_status).toBe("failed");
    expect(q.state.revision).toBe(rev);
    expect(await task(failure, q)).toEqual(result);
    expect([...q.effects.values()].filter((i) => i.kind === "qualification")).toHaveLength(1);
  });
  test("post-pass erasure reconciles only the handoff after invalidation and recovers its immutable receipt after lost COMMIT acknowledgement", async () => {
    const p = new MemoryPorts();
    await ready(p);
    const passed = await run(verdict(p), p);
    const priorReceipts = new Map(p.receipts);
    const priorEffects = new Map(p.effects);
    const originalState = p.state;
    p.actor = { kind: "worker", accountId: "worker" };
    p.now = 5000;
    p.factsValue = {
      ...p.factsValue,
      accountActive: false,
      accountFenceRevision: 2,
      disposition: null,
      media: null,
      safety: null,
      qualification: null,
    };
    const erase = {
      ...common,
      version: "dance-review-task-v1",
      operation: "erase",
      idempotency_key: "post-pass-erase",
      expected_review_revision: p.state.revision,
    };
    p.loseCommitAck = true;
    await expect(task(erase, p)).rejects.toMatchObject({ reason: "outcome_unknown" });
    expect(p.state).toEqual({
      ...originalState,
      publication: "cancelled",
      publicationRevision: originalState.publicationRevision + 1,
    });
    for (const [key, value] of priorReceipts) expect(p.receipts.get(key)).toEqual(value);
    for (const [key, value] of priorEffects) expect(p.effects.get(key)).toEqual(value);
    const cleanup = [...p.effects.values()].filter((i) => !priorEffects.has(i.key));
    expect(cleanup.map((i) => i.kind)).toEqual(["handoff_cancel", "cleanup_temporary"]);
    expect(
      cleanup.every(
        (i) =>
          i.deadlineMs === originalState.transferDeadlineMs &&
          i.generation === originalState.generation,
      ),
    ).toBe(true);
    const committed = [...p.receipts.values()].find(
      (r) => decodeDanceReviewCommandReceiptV1(r.receipt).operation === "erase",
    );
    if (committed === undefined) throw new Error("Expected erasure receipt");
    const original = decodeDanceReviewCommandReceiptV1(committed.receipt);
    expect(original.result.verdict).toBe(passed.result.verdict);
    expect(original.result.qualification_ref).toBe(passed.result.qualification_ref);
    expect(original.result.initial_submit_receipt).toEqual(passed.result.initial_submit_receipt);
    const effectCount = p.effects.size;
    const counts = [p.commits, p.clockReads, p.factReads, effectCount, p.receipts.size];
    p.clockUnavailable = true;
    p.factsUnavailable = true;
    p.factsValue = { ...p.factsValue, accountFenceRevision: 3 };
    expect(await task(erase, p)).toEqual(original);
    expect([p.commits, p.clockReads, p.factReads, p.effects.size, p.receipts.size]).toEqual(counts);
    p.clockUnavailable = false;
    p.factsUnavailable = false;
    p.now = 9000;
    expect((await task({ ...erase, idempotency_key: "same-drain-new-command" }, p)).outcome).toBe(
      "applied",
    );
    expect(p.effects.size).toBe(effectCount);
    expect(p.state.publicationRevision).toBe(originalState.publicationRevision + 1);
    p.actor = { kind: "account", accountId: "dancer" };
    await expect(run(submit, p)).rejects.toMatchObject({ reason: "not_found" });
  });
  test("changed-fence failed transfer rejects stale generations and cannot create another result, qualification or release", async () => {
    const p = new MemoryPorts();
    await ready(p);
    const passed = await run(verdict(p), p);
    const original = p.state;
    const effects = p.effects.size;
    p.actor = { kind: "worker", accountId: "worker" };
    p.now = 5000;
    p.factsValue = { ...p.factsValue, accountFenceRevision: 2, disposition: null };
    const failure = {
      ...common,
      version: "dance-review-task-v1",
      operation: "publication_failed",
      idempotency_key: "current-failed-transfer",
      expected_review_revision: p.state.revision,
      handoff_generation: p.state.generation,
    };
    const stale = await task(
      { ...failure, idempotency_key: "stale-transfer", handoff_generation: p.state.generation + 1 },
      p,
    );
    expect(stale.refusal_code).toBe("stale_generation");
    expect(p.effects.size).toBe(effects);
    expect(p.state).toEqual(original);
    const failed = await task(failure, p);
    expect(failed.result.publication_status).toBe("failed");
    expect(failed.result.verdict).toBe("passed");
    expect(failed.result.qualification_ref).toBe(passed.result.qualification_ref);
    expect(p.state).toEqual({
      ...original,
      publication: "failed",
      publicationRevision: original.publicationRevision + 1,
    });
    for (const kind of ["result", "qualification", "handoff_release"])
      expect([...p.effects.values()].filter((i) => i.kind === kind)).toHaveLength(1);
    const count = p.effects.size;
    p.clockUnavailable = true;
    p.factsUnavailable = true;
    expect(await task(failure, p)).toEqual(failed);
    expect(p.effects.size).toBe(count);
  });
  test("cleanup commit compares the observed lifecycle revision AND active status, rather than requiring the original capture fence", async () => {
    for (const change of ["revision", "active"] as const) {
      const p = new MemoryPorts();
      await ready(p);
      await run(verdict(p), p);
      p.actor = { kind: "worker", accountId: "worker" };
      p.now = 5000;
      p.factsValue = { ...p.factsValue, accountFenceRevision: 2 };
      const before = p.state;
      const effectCount = p.effects.size;
      const counts = [p.commits, effectCount, p.receipts.size];
      const failure = {
        ...common,
        version: "dance-review-task-v1",
        operation: "publication_failed",
        idempotency_key: "racing-cleanup",
        expected_review_revision: p.state.revision,
        handoff_generation: p.state.generation,
      };
      p.onCommit = () => {
        p.factsValue =
          change === "revision"
            ? { ...p.factsValue, accountFenceRevision: 3 }
            : { ...p.factsValue, accountActive: false };
      };
      await expect(task(failure, p)).rejects.toMatchObject({ reason: "outcome_unknown" });
      expect(p.state).toEqual(before);
      expect([p.commits, p.effects.size, p.receipts.size]).toEqual(counts);
      p.onCommit = null;
      expect((await task(failure, p)).result.publication_status).toBe("failed");
      expect(p.effects.size).toBe(effectCount + 2);
    }
  });
  test("missing current disposition/evidence stays unavailable and never creates a preview/qualification promise", async () => {
    const p = new MemoryPorts();
    p.factsValue = { ...p.factsValue, disposition: null };
    const refusal = await run(submit, p);
    expect(refusal.refusal_code).toBe("disposition_unavailable");
    expect(p.state.state).toBe("uploaded");
    expect(p.effects.size).toBe(0);
    const text = JSON.stringify(refusal);
    for (const key of ["signed_url", "object_key", "wallet", "reviewerAccountId"])
      expect(text).not.toContain(key);
  });
});
