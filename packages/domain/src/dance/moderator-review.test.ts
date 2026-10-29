import { describe, expect, test } from "bun:test";
import {
  authorizeModeratorPublication,
  initializeModeratorReview,
  type ModeratorReview,
  type ReviewFacts,
  type SealedReviewCapture,
  transitionModeratorReview,
} from "./moderator-review.ts";

// Fictional accepted evidence/finite values exercise only the pure reducer.
function fixture() {
  const h = (c: string) => c.repeat(64);
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
  const facts = {
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
      assignmentId: "owner-assignment",
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
    submissionDay: { atMs: 2000, day: "1970-01-01", timezone: "UTC", timezoneVersion: "tz-v1" },
    qualification: {
      admitted: true,
      producerId: "moderator-producer",
      policyVersion: "qualification-v1",
      policyHash: h("b"),
      admissionVersion: "admission-v1",
      admissionHash: h("2"),
    },
  } satisfies ReviewFacts;
  const state = initializeModeratorReview(capture, facts, 1000);
  if (!state) throw new Error("Invalid fictional fixture");
  return { capture, facts, state };
}
const dancer = { kind: "account", accountId: "dancer" } as const;
const owner = { kind: "account", accountId: "owner" } as const;
const worker = { kind: "worker", accountId: "worker" } as const;
function submit(s: ModeratorReview, f: ReviewFacts, showPublicly = true) {
  const r = transitionModeratorReview(
    s,
    { kind: "submit", receiptId: "submit", showPublicly, disclosureVersion: "disclosure-v1" },
    dancer,
    s.revision,
    2000,
    f,
  );
  expect(r.refusal).toBeNull();
  return r.state;
}
function ready(s: ModeratorReview, f: ReviewFacts, showPublicly = true) {
  const submitted = submit(s, f, showPublicly);
  const r = transitionModeratorReview(
    submitted,
    { kind: "screen" },
    worker,
    submitted.revision,
    3000,
    f,
  );
  expect(r.refusal).toBeNull();
  return r.state;
}
const verdict = {
  kind: "verdict",
  version: "dance-owner-verdict-attestation-v1",
  verdict: "passed",
} as const;

describe("pure offline moderated Dance review", () => {
  test("no media profile, consent-before-storage, exact persona, finite disposition or policy => no initial authority", () => {
    const { capture: c, facts: f } = fixture();
    for (const facts of [
      { ...f, media: null },
      { ...f, media: { ...f.media, accepted: false } },
      { ...f, disposition: null },
      { ...f, disposition: { ...f.disposition, cleanupWithinMs: 0 } },
      { ...f, ownedPersona: { ...f.ownedPersona, communityId: "foreign" } },
      { ...f, owner: { ...f.owner, accountId: c.accountId } },
    ])
      expect(initializeModeratorReview(c, facts, 1000)).toBeNull();
    for (const capture of [
      { ...c, consent: { ...c.consent, recordedAtMs: 500 } },
      { ...c, consent: { ...c.consent, uploadId: "foreign" } },
      { ...c, policy: { ...c.policy, reviewWindowMs: 1000 } },
      { ...c, policy: { ...c.policy, normalizationHash: "" } },
    ])
      expect(initializeModeratorReview(capture, f, 1000)).toBeNull();
  });
  test("Submit freezes immutable choice/time/day and capture expiry cannot end submitted review", () => {
    const { state: s, facts: f } = fixture();
    const before = JSON.stringify(s);
    const pending = submit(s, f, false);
    expect(JSON.stringify(s)).toBe(before);
    expect(pending.initialSubmit).toMatchObject({
      showPublicly: false,
      submittedAtMs: 2000,
      uploadId: "upload",
    });
    expect(pending.submissionDay?.day).toBe("1970-01-01");
    const screened = transitionModeratorReview(
      pending,
      { kind: "screen" },
      worker,
      pending.revision,
      6000,
      f,
    );
    expect(screened.state.state).toBe("awaiting_review");
    const passed = transitionModeratorReview(
      screened.state,
      verdict,
      owner,
      screened.state.revision,
      7000,
      f,
    );
    expect(passed.state.verdict).toBe("passed");
    expect(passed.state.attestation).toMatchObject({
      cue: "affirmed",
      producer: "owner_verdict_attestation",
      sourceDigest: s.capture.sourceDigest,
      committedAtMs: 7000,
    });
    expect(passed.intents.find((i) => i.kind === "qualification")?.qualification).toMatchObject({
      score_bps: null,
      calibration: null,
      floor: null,
      qualifiedAtMs: 7000,
      submissionDay: "1970-01-01",
    });
    expect(passed.intents.some((i) => i.kind === "handoff_release")).toBe(false);
    expect(
      transitionModeratorReview(
        s,
        {
          kind: "submit",
          receiptId: "late",
          showPublicly: false,
          disclosureVersion: "disclosure-v1",
        },
        dancer,
        s.revision,
        5000,
        f,
      ).state.state,
    ).toBe("expired");
  });
  test("before deadline passes; equality/after becomes Not reviewed, never a failure or qualification", () => {
    const { state: s, facts: f } = fixture();
    const r = ready(s, f);
    expect(
      transitionModeratorReview(r, verdict, owner, r.revision, r.reviewDeadlineMs - 1, f).state
        .verdict,
    ).toBe("passed");
    for (const now of [r.reviewDeadlineMs, r.reviewDeadlineMs + 1]) {
      const x = transitionModeratorReview(r, verdict, owner, r.revision, now, f);
      expect(x.state.state).toBe("review_expired");
      expect(x.state.verdict).toBeNull();
      expect(x.refusal).toBe("review_deadline_reached");
      expect(
        x.intents.some((i) => i.kind === "qualification" || i.kind === "handoff_release"),
      ).toBe(false);
    }
  });
  test("current owner/rating and no-self-review are rechecked; no client role marker is authority", () => {
    const { state: s, facts: f } = fixture();
    const r = ready(s, f);
    for (const facts of [
      { ...f, owner: null },
      { ...f, owner: { ...f.owner, accountId: "new-owner", revision: 2 } },
      { ...f, owner: { ...f.owner, canInspect: false } },
      { ...f, owner: { ...f.owner, communityId: "foreign" } },
    ])
      expect(transitionModeratorReview(r, verdict, owner, r.revision, 4000, facts).refusal).toBe(
        "not_authorized",
      );
    const transferred = { ...f, owner: { ...f.owner, accountId: "new-owner", revision: 2 } };
    expect(
      transitionModeratorReview(
        r,
        verdict,
        { kind: "account", accountId: "new-owner" },
        r.revision,
        4000,
        transferred,
      ).state.attestation?.assignmentRevision,
    ).toBe(2);
    const self = { ...f, owner: { ...f.owner, accountId: "dancer" } };
    expect(transitionModeratorReview(r, verdict, dancer, r.revision, 4000, self).refusal).toBe(
      "self_review",
    );
    expect(
      transitionModeratorReview(
        r,
        { ...verdict, verdict: "not_passed" },
        dancer,
        r.revision,
        4000,
        self,
      ).refusal,
    ).toBe("self_review");
  });
  test("three persisted sample positions may have identical pixels without losing their safety evidence", () => {
    const { state: s, facts: f } = fixture();
    const r = submit(s, f);
    const facts = {
      ...f,
      safety: {
        ...f.safety,
        frameDigests: ["6".repeat(64), "6".repeat(64), "6".repeat(64)] as const,
      },
    };
    const screened = transitionModeratorReview(
      r,
      { kind: "screen" },
      worker,
      r.revision,
      3000,
      facts,
    );
    expect(screened.refusal).toBeNull();
    expect(screened.state.state).toBe("awaiting_review");
  });
  test("incomplete, mismatched, failed and uncertain evidence never grants preview/review; held has no owner resolver", () => {
    const { state: s, facts: f } = fixture();
    const r = submit(s, f);
    for (const facts of [
      { ...f, safety: null },
      { ...f, safety: { ...f.safety, status: "unknown" as const } },
      { ...f, safety: { ...f.safety, persisted: false } },
      { ...f, safety: { ...f.safety, sourceDigest: "9".repeat(64) } },
      { ...f, integrity: null },
      { ...f, media: null },
    ]) {
      const x = transitionModeratorReview(r, { kind: "screen" }, worker, r.revision, 3000, facts);
      expect(x.refusal).toBe("evidence_unavailable");
      expect(x.state).toBe(r);
    }
    const flagged = { ...f, safety: { ...f.safety, status: "flagged" as const } };
    expect(
      transitionModeratorReview(r, { kind: "screen" }, worker, r.revision, 3000, flagged).refusal,
    ).toBe("disposition_unavailable");
    const boundedHold = {
      ...flagged,
      disposition: {
        ...f.disposition,
        hold: {
          accepted: true,
          authorityRef: "existing-platform-hold",
          policyHash: "9".repeat(64),
          disposeByMs: 9000,
        },
      },
    };
    const held = transitionModeratorReview(
      r,
      { kind: "screen" },
      worker,
      r.revision,
      3000,
      boundedHold,
    );
    expect(held.state.state).toBe("held");
    expect(held.intents.some((i) => i.kind === "hold_review" && i.deadlineMs === 9000)).toBe(true);
    expect(held.intents.some((i) => i.kind === "cleanup_review")).toBe(false);
    expect(
      transitionModeratorReview(held.state, verdict, owner, held.state.revision, 4000, boundedHold)
        .refusal,
    ).toBe("review_closed");
    expect(
      transitionModeratorReview(r, { kind: "screen" }, worker, r.revision, 3000, {
        ...f,
        safety: { ...f.safety, status: "failed" },
      }).state.state,
    ).toBe("processing_failed");
    expect(
      transitionModeratorReview(r, { kind: "screen" }, worker, r.revision, 3000, {
        ...f,
        integrity: { ...f.integrity, status: "blocked" },
      }).state.state,
    ).toBe("processing_failed");
  });
  test("choice no-op has no revision/effects; edits retain Submit and fence stale verdict/hand-off generations", () => {
    const { state: s, facts: f } = fixture();
    const r = ready(s, f, true);
    const initial = r.initialSubmit;
    const noop = transitionModeratorReview(
      r,
      { kind: "visibility", showPublicly: true, disclosureVersion: "disclosure-v1" },
      dancer,
      r.revision,
      4000,
      f,
    );
    expect(noop.state).toBe(r);
    expect(noop.intents).toEqual([]);
    const off = transitionModeratorReview(
      r,
      { kind: "visibility", showPublicly: false, disclosureVersion: "disclosure-v1" },
      dancer,
      r.revision,
      4000,
      f,
    );
    expect(off.state.initialSubmit).toBe(initial);
    expect(off.state.generation).toBe(r.generation + 1);
    expect(off.intents.map((i) => i.kind)).toEqual(["handoff_cancel", "cleanup_temporary"]);
    expect(transitionModeratorReview(off.state, verdict, owner, r.revision, 4001, f).refusal).toBe(
      "revision_conflict",
    );
    const on = transitionModeratorReview(
      off.state,
      { kind: "visibility", showPublicly: true, disclosureVersion: "disclosure-v1" },
      dancer,
      off.state.revision,
      4001,
      f,
    ).state;
    const passed = transitionModeratorReview(on, verdict, owner, on.revision, 4002, f).state;
    const mapping = {
      accepted: true,
      sourceDigest: s.capture.sourceDigest,
      outputDigest: "9".repeat(64),
      bodyStartMs: 2000,
      bodyEndMs: 12000,
      postGatesAccepted: true,
    };
    expect(authorizeModeratorPublication(passed, r.generation, 4003, f, mapping)).toBe(false);
    expect(authorizeModeratorPublication(passed, passed.generation, 4003, f, mapping)).toBe(true);
    if (passed.transferDeadlineMs === null) throw new Error("Expected transfer deadline");
    expect(
      authorizeModeratorPublication(
        passed,
        passed.generation,
        passed.transferDeadlineMs,
        f,
        mapping,
      ),
    ).toBe(false);
    expect(
      authorizeModeratorPublication(passed, passed.generation, 4003, f, {
        ...mapping,
        bodyStartMs: 0,
      }),
    ).toBe(false);
    expect(
      authorizeModeratorPublication(
        passed,
        passed.generation,
        4003,
        { ...f, accountFenceRevision: 2 },
        mapping,
      ),
    ).toBe(false);
    expect(
      transitionModeratorReview(
        passed,
        { kind: "visibility", showPublicly: false, disclosureVersion: "disclosure-v1" },
        dancer,
        passed.revision,
        4003,
        f,
      ).refusal,
    ).toBe("publication_choice_closed");
  });
  test("competing terminal commands cannot replace verdict, duplicate results, or reverse qualification on publication failure", () => {
    const { state: s, facts: f } = fixture();
    const r = ready(s, f);
    const passed = transitionModeratorReview(r, verdict, owner, r.revision, 4000, f);
    const q = passed.state.qualificationRef;
    for (const event of [
      { kind: "withdraw" } as const,
      { ...verdict, verdict: "not_passed" as const },
      { kind: "expire" } as const,
    ]) {
      const x = transitionModeratorReview(
        passed.state,
        event,
        event.kind === "expire" ? worker : owner,
        passed.state.revision,
        4001,
        f,
      );
      expect(x.state).toBe(passed.state);
      expect(x.intents).toEqual([]);
    }
    const failed = transitionModeratorReview(
      passed.state,
      { kind: "publication_failed", generation: passed.state.generation },
      worker,
      passed.state.revision,
      4001,
      f,
    );
    expect(failed.state.verdict).toBe("passed");
    expect(failed.state.qualificationRef).toBe(q);
    expect(failed.state.revision).toBe(passed.state.revision);
    expect(failed.state.publication).toBe("failed");
    expect(failed.intents.some((i) => i.kind === "result" || i.kind === "qualification")).toBe(
      false,
    );
    const withdrawn = transitionModeratorReview(
      r,
      { kind: "withdraw" },
      dancer,
      r.revision,
      4000,
      f,
    );
    expect(withdrawn.state.state).toBe("withdrawn");
    expect(
      transitionModeratorReview(withdrawn.state, verdict, owner, withdrawn.state.revision, 4001, f)
        .state,
    ).toBe(withdrawn.state);
    const failedVerdict = transitionModeratorReview(
      r,
      { ...verdict, verdict: "not_passed" },
      owner,
      r.revision,
      4000,
      f,
    );
    expect(failedVerdict.state.attestation?.cue).toBe("not_attested");
    expect(failedVerdict.intents.some((i) => i.kind === "qualification")).toBe(false);
  });
  test("immutable captured admission/objectives govern qualification; publicity and later promotion do not", () => {
    const { state: s, facts: f, capture: c } = fixture();
    const off = ready(s, f, false),
      on = ready(s, f, true);
    const qualify = (r: ModeratorReview) =>
      transitionModeratorReview(r, verdict, owner, r.revision, 4000, f).intents.find(
        (i) => i.kind === "qualification",
      )?.qualification;
    expect(qualify(off)).toEqual(qualify(on));
    const shadowCapture = { ...c, policy: { ...c.policy, admission: "shadow" as const } };
    const shadow = initializeModeratorReview(shadowCapture, f, 1000);
    if (shadow === null) throw new Error("Expected shadow fixture");
    expect(qualify(ready(shadow, f))).toBeUndefined();
    const r = ready(s, f);
    expect(
      transitionModeratorReview(r, verdict, owner, r.revision, 4000, { ...f, qualification: null })
        .state.qualificationRef,
    ).toBeNull();
    const rewardCapture: SealedReviewCapture = {
      ...c,
      rewardMode: "reward_eligible",
      policy: { ...c.policy, admission: "money_admitted" },
      objectives: [
        {
          id: "objective",
          version: "objective-v1",
          termsHash: "a".repeat(64),
          fundingPolicyHash: "b".repeat(64),
          gradingMode: "moderator_verdict",
        },
      ],
    };
    const reward = initializeModeratorReview(rewardCapture, f, 1000);
    if (reward === null) throw new Error("Expected reward fixture");
    expect(qualify(ready(reward, f))?.objectives).toEqual(rewardCapture.objectives);
    expect(initializeModeratorReview({ ...rewardCapture, objectives: [] }, f, 1000)).toBeNull();
  });
  test("post-pass erasure drains only the pending handoff after lifecycle invalidation, even with admission gone", () => {
    const { state: s, facts: f } = fixture();
    const pending = ready(s, f);
    const passed = transitionModeratorReview(
      pending,
      verdict,
      owner,
      pending.revision,
      4000,
      f,
    ).state;
    for (const active of [false, true]) {
      const invalidated: ReviewFacts = {
        ...f,
        accountActive: active,
        accountFenceRevision: 2,
        disposition: null,
        media: null,
        safety: null,
        qualification: null,
      };
      const erased = transitionModeratorReview(
        passed,
        { kind: "erase" },
        worker,
        passed.revision,
        5000,
        invalidated,
      );
      expect(erased.refusal).toBeNull();
      expect(erased.state).toEqual({
        ...passed,
        publication: "cancelled",
        publicationRevision: passed.publicationRevision + 1,
      });
      expect(erased.intents.map((i) => i.kind)).toEqual(["handoff_cancel", "cleanup_temporary"]);
      for (const i of erased.intents) {
        expect(i.generation).toBe(passed.generation);
        expect(i.deadlineMs).toBe(passed.transferDeadlineMs);
        expect(i.qualification).toBeNull();
      }
      const repeated = transitionModeratorReview(
        erased.state,
        { kind: "erase" },
        worker,
        erased.state.revision,
        9000,
        invalidated,
      );
      expect(repeated.state).toBe(erased.state);
      expect(repeated.intents).toEqual([]);
      expect(repeated.refusal).toBeNull();
      expect(
        authorizeModeratorPublication(erased.state, passed.generation, 5000, invalidated, null),
      ).toBe(false);
    }
    expect(
      transitionModeratorReview(passed, { kind: "erase" }, worker, passed.revision, 4001, f)
        .refusal,
    ).toBe("review_closed");
    expect(
      transitionModeratorReview(passed, { kind: "erase" }, dancer, passed.revision, 5000, {
        ...f,
        accountActive: false,
      }).refusal,
    ).toBe("not_authorized");
  });
  test("failed-transfer reconciliation fences generation/revision and never renews the original retention bound", () => {
    const { state: s, facts: f } = fixture();
    const pending = ready(s, f);
    const passed = transitionModeratorReview(
      pending,
      verdict,
      owner,
      pending.revision,
      4000,
      f,
    ).state;
    const invalidated = { ...f, accountFenceRevision: 2, disposition: null };
    const failure = { kind: "publication_failed", generation: passed.generation } as const;
    const stale = transitionModeratorReview(
      passed,
      { ...failure, generation: passed.generation + 1 },
      worker,
      passed.revision,
      5000,
      invalidated,
    );
    expect(stale.refusal).toBe("stale_generation");
    expect(stale.state).toBe(passed);
    expect(stale.intents).toEqual([]);
    expect(
      transitionModeratorReview(passed, failure, worker, passed.revision - 1, 5000, invalidated)
        .refusal,
    ).toBe("revision_conflict");
    expect(
      transitionModeratorReview(passed, failure, worker, passed.revision, 5000, {
        ...invalidated,
        workerAuthorized: false,
      }).refusal,
    ).toBe("not_authorized");
    const failed = transitionModeratorReview(
      passed,
      failure,
      worker,
      passed.revision,
      5000,
      invalidated,
    );
    expect(failed.refusal).toBeNull();
    expect(failed.state).toEqual({
      ...passed,
      publication: "failed",
      publicationRevision: passed.publicationRevision + 1,
    });
    expect(failed.intents.map((i) => i.kind)).toEqual(["handoff_cancel", "cleanup_temporary"]);
    expect(failed.intents.every((i) => i.deadlineMs === passed.transferDeadlineMs)).toBe(true);
    const muchLater = transitionModeratorReview(
      passed,
      failure,
      worker,
      passed.revision,
      1_000_000_000,
      invalidated,
    );
    expect(muchLater.intents).toEqual(failed.intents);
    const repeated = transitionModeratorReview(
      failed.state,
      failure,
      worker,
      failed.state.revision,
      9000,
      invalidated,
    );
    expect(repeated.refusal).toBe("stale_generation");
    expect(repeated.intents).toEqual([]);
    const erasedAfterFailure = transitionModeratorReview(
      failed.state,
      { kind: "erase" },
      worker,
      failed.state.revision,
      9000,
      invalidated,
    );
    expect(erasedAfterFailure.state).toBe(failed.state);
    expect(erasedAfterFailure.intents).toEqual([]);
    expect(
      transitionModeratorReview(
        { ...passed, transferDeadlineMs: null },
        failure,
        worker,
        passed.revision,
        5000,
        invalidated,
      ).refusal,
    ).toBe("invalid_state");
  });
  test("pre-Submit cutoff abandons, submitted-before-cutoff finishes privately, erasure fences every later effect", () => {
    const { state: s, facts: f } = fixture();
    const cutoff = { ...f, referenceCutoffAtMs: 1500 };
    expect(
      transitionModeratorReview(
        s,
        {
          kind: "submit",
          showPublicly: false,
          disclosureVersion: "disclosure-v1",
          receiptId: "submit",
        },
        dancer,
        s.revision,
        2000,
        cutoff,
      ).state.state,
    ).toBe("abandoned");
    const r = ready(s, f);
    const afterCutoff = { ...f, referenceCutoffAtMs: 2500 };
    expect(
      transitionModeratorReview(r, verdict, owner, r.revision, 4000, afterCutoff).state.verdict,
    ).toBe("passed");
    const erased = { ...f, accountActive: false, accountFenceRevision: 2 };
    expect(transitionModeratorReview(r, verdict, owner, r.revision, 4000, erased).refusal).toBe(
      "lifecycle_changed",
    );
    const closed = transitionModeratorReview(
      r,
      { kind: "erase" },
      worker,
      r.revision,
      4000,
      erased,
    );
    expect(closed.state.state).toBe("abandoned");
    expect(
      closed.intents.some((i) => i.kind === "qualification" || i.kind === "handoff_release"),
    ).toBe(false);
  });
});

describe("prospective no-pose moderator review", () => {
  function noPose() {
    const old = fixture();
    const capture: SealedReviewCapture = {
      ...old.capture,
      policy: { ...old.capture.policy, version: "moderator-review-policy-v2" },
      cueId: "none",
      cueStartMs: 0,
      cueEndMs: 0,
      cueHoldMs: 0,
      bodyStartMs: 0,
      bodyEndMs: 10000,
    };
    const state = initializeModeratorReview(capture, old.facts, 1000);
    if (!state) throw new Error("Invalid fictional no-pose capture");
    return { ...old, capture, state };
  }
  test.each(["passed", "not_passed"] as const)(
    "records truthful %s with no pose attestation",
    (result) => {
      const f = noPose(),
        pending = ready(f.state, f.facts, false);
      const changed = transitionModeratorReview(
        pending,
        { ...verdict, version: "dance-owner-verdict-attestation-v2", verdict: result },
        owner,
        pending.revision,
        4000,
        f.facts,
      );
      expect(changed.refusal).toBeNull();
      expect(changed.state.verdict).toBe(result);
      expect(changed.state.attestation?.cue).toBe("not_required");
      expect(changed.state.attestation?.version).toBe("dance-owner-verdict-attestation-v2");
      expect(changed.state.qualificationRef).toBe(result === "passed" ? f.capture.reviewId : null);
      expect(changed.intents.some((i) => i.kind === "qualification")).toBe(result === "passed");
      expect(changed.state.capture).toEqual(f.capture);
    },
  );
  test("keeps the distinct owner, real verdict, evidence and deadline gates", () => {
    const f = noPose(),
      pending = ready(f.state, f.facts);
    const command = { ...verdict, version: "dance-owner-verdict-attestation-v2" } as const;
    expect(
      transitionModeratorReview(pending, verdict, owner, pending.revision, 4000, f.facts).refusal,
    ).toBe("evidence_unavailable");
    expect(
      transitionModeratorReview(pending, command, dancer, pending.revision, 4000, {
        ...f.facts,
        owner: { ...f.facts.owner, accountId: dancer.accountId },
      }).refusal,
    ).toBe("self_review");
    expect(
      transitionModeratorReview(pending, command, owner, pending.revision, 4000, {
        ...f.facts,
        safety: null,
      }).state.qualificationRef,
    ).toBeNull();
    expect(
      transitionModeratorReview(
        pending,
        command,
        owner,
        pending.revision,
        pending.reviewDeadlineMs,
        f.facts,
      ).state.qualificationRef,
    ).toBeNull();
    for (const capture of [
      { ...f.capture, cueId: "arms_t" },
      { ...f.capture, cueHoldMs: 1 },
      { ...f.capture, bodyStartMs: 2000 },
      { ...f.capture, policy: fixture().capture.policy },
    ])
      expect(initializeModeratorReview(capture, f.facts, 1000)).toBeNull();
    const old = fixture(),
      oldPending = ready(old.state, old.facts);
    expect(
      transitionModeratorReview(oldPending, command, owner, oldPending.revision, 4000, old.facts)
        .refusal,
    ).toBe("evidence_unavailable");
    expect(
      transitionModeratorReview(oldPending, verdict, owner, oldPending.revision, 4000, old.facts)
        .state.attestation?.cue,
    ).toBe("affirmed");
  });
});
