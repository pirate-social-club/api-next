import {
  DANCE_ATTEMPT_CALLBACK_KEY_VERSION_HEADER,
  DANCE_ATTEMPT_CALLBACK_SIGNATURE_HEADER,
  DANCE_ATTEMPT_CALLBACK_TIMESTAMP_HEADER,
  type DanceAttemptCallbackClaimStore,
  danceAttemptCallbackSigningBytes,
} from "@pirate/application/dance/attempt-callback";
import type {
  DanceAttemptProcessingClaim,
  DanceAttemptProcessingOutcome,
  DanceAttemptProcessingStore,
} from "@pirate/application/dance/attempt-processing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeDanceAttemptCallbackHandler } from "../../apps/media-processor-worker/src/dance-attempt-callback.ts";
import { makeDanceAttemptCallbackAuthenticator } from "../../packages/platform-cf/src/dance-attempt-callback-authenticator.ts";

const NOW_MS = 1_788_217_200_000;
const KEY_VERSION = "callback-key-v1";
const KEY = new TextEncoder().encode("dance-callback-test-key-material-32-bytes-minimum");
const HASH_A = "11".repeat(32);
const HASH_B = "22".repeat(32);
const HASH_C = "33".repeat(32);

const claim: DanceAttemptProcessingClaim = {
  frozenInput: {
    version: "frozen-dance-attempt-input-v1",
    attemptId: "attempt-1",
    sessionId: "session-1",
    inputDigest: HASH_A,
    privateMediaRef: "private/random/session-1",
    sealedMediaSha256: HASH_B,
    segmentId: "segment-1",
    choreographyId: "choreography-1",
    choreographyRevision: 1,
    referenceArtifactRef: "private/reference/artifact-1",
    referenceArtifactSha256: HASH_C,
    scoredWindowStartMs: 2_000,
    scoredWindowEndMs: 8_000,
    expectedScoredDurationMs: 6_000,
    policy: {
      capturedAdmissionState: "shadow",
      poseModelVersion: "pose-v1",
      featureSchemaVersion: "features-v1",
      scorerContractVersion: "scorer-v1",
      mirrorPolicyVersion: "mirror-v1",
      fingerprintPolicyVersion: "fingerprint-v1",
      fingerprintKeyVersion: "fingerprint-key-v1",
      integrityPolicyVersion: "integrity-v1",
      graderAdapterVersion: "grader-v1",
    },
  },
  binding: {
    version: "dance-attempt-processing-binding-v1",
    effectIdentity: "dance-attempt:attempt-1",
    attemptId: "attempt-1",
    inputDigest: HASH_A,
    attemptNumber: 1,
    claimOwner: "provider-operation-1",
    claimFence: 1,
  },
};

const outcome: DanceAttemptProcessingOutcome = {
  version: "dance-attempt-processing-outcome-v1",
  binding: claim.binding,
  gradeOutcome: "scored",
  qualificationOutcome: "suppressed_shadow",
  scoreBps: 7_250,
  rejectionCode: null,
  scoredWindowStartMs: 2_000,
  scoredWindowEndMs: 8_000,
  scoredDurationMs: 6_000,
  evidenceSummary: {
    schema_version: 1,
    usable_coverage_bps: 9_500,
    selected_mirror: "original",
    meaningful_motion_accepted: true,
    replay_outcome: "unique",
    subject_continuity: "stable",
  },
  evidenceDigest: HASH_C,
  fingerprint: {
    claimId: "fingerprint-claim-1",
    policyVersion: "fingerprint-v1",
    keyVersion: "fingerprint-key-v1",
    matchScope: "platform_wide",
    accountScopeId: null,
    wholeSequenceFingerprint: HASH_A,
    segmentFingerprints: [HASH_B],
  },
};

const payload = (selectedOutcome: DanceAttemptProcessingOutcome = outcome) => ({
  version: "dance-attempt-callback-v1" as const,
  operationIdentity: selectedOutcome.binding.effectIdentity,
  attemptId: selectedOutcome.binding.attemptId,
  inputDigest: selectedOutcome.binding.inputDigest,
  outcome: selectedOutcome,
});

function sameBinding(left: typeof claim.binding, right: typeof claim.binding): boolean {
  return (
    left.effectIdentity === right.effectIdentity &&
    left.attemptId === right.attemptId &&
    left.inputDigest === right.inputDigest &&
    left.attemptNumber === right.attemptNumber &&
    left.claimOwner === right.claimOwner &&
    left.claimFence === right.claimFence
  );
}

function callbackStore() {
  let terminalDigest: string | null = null;
  let conflicts = 0;
  let completions = 0;
  const store: DanceAttemptProcessingStore & DanceAttemptCallbackClaimStore = {
    claim: () => Effect.die(new Error("callback must not claim")),
    fail: () => Effect.die(new Error("callback must not fail the adapter")),
    resolveCallbackClaim: (binding) =>
      Effect.succeed(sameBinding(binding, claim.binding) ? claim : null),
    complete: (_acceptedClaim, acceptedOutcome) => {
      completions += 1;
      if (terminalDigest === null) {
        terminalDigest = acceptedOutcome.evidenceDigest;
        return Effect.succeed("committed");
      }
      if (terminalDigest === acceptedOutcome.evidenceDigest) return Effect.succeed("replayed");
      conflicts += 1;
      return Effect.succeed("conflict");
    },
  };
  return { store, counts: () => ({ completions, conflicts, terminalDigest }) };
}

const authenticator = makeDanceAttemptCallbackAuthenticator({
  keys: new Map([[KEY_VERSION, KEY]]),
  maxSkewMs: 30_000,
  nowMs: () => NOW_MS,
});

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function requestFor(
  callbackPayload: unknown,
  options: {
    readonly timestamp?: string;
    readonly signingBody?: unknown;
    readonly signature?: string;
    readonly keyVersion?: string;
  } = {},
): Promise<Request> {
  const keyVersion = options.keyVersion ?? KEY_VERSION;
  const timestamp = options.timestamp ?? String(NOW_MS);
  const rawBody = new TextEncoder().encode(JSON.stringify(callbackPayload));
  const signingBody = new TextEncoder().encode(
    JSON.stringify(options.signingBody ?? callbackPayload),
  );
  const key = await crypto.subtle.importKey("raw", KEY, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const generated = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      danceAttemptCallbackSigningBytes({ keyVersion, timestamp, rawBody: signingBody }),
    ),
  );
  return new Request("https://worker.test/internal/dance/attempt-callback", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [DANCE_ATTEMPT_CALLBACK_KEY_VERSION_HEADER]: keyVersion,
      [DANCE_ATTEMPT_CALLBACK_TIMESTAMP_HEADER]: timestamp,
      [DANCE_ATTEMPT_CALLBACK_SIGNATURE_HEADER]: options.signature ?? base64url(generated),
    },
    body: rawBody,
  });
}

describe("Dance attempt callback acceptance", () => {
  it("commits once, treats an identical terminal replay as harmless, and reports conflict", async () => {
    const state = callbackStore();
    const handler = makeDanceAttemptCallbackHandler({
      authenticator,
      store: state.store,
    });
    expect((await handler(await requestFor(payload()))).status).toBe(202);
    expect((await handler(await requestFor(payload()))).status).toBe(200);
    const conflicting = payload({ ...outcome, evidenceDigest: HASH_B });
    expect((await handler(await requestFor(conflicting))).status).toBe(409);
    expect(state.counts()).toEqual({ completions: 3, conflicts: 1, terminalDigest: HASH_C });
  });

  it("rejects a forged signature and an authenticated-body mutation before completion", async () => {
    const state = callbackStore();
    const handler = makeDanceAttemptCallbackHandler({ authenticator, store: state.store });
    const forged = await requestFor(payload(), { signature: "A".repeat(43) });
    expect((await handler(forged)).status).toBe(401);
    const altered = { ...payload(), attemptId: "attempt-altered" };
    expect((await handler(await requestFor(altered, { signingBody: payload() }))).status).toBe(401);
    expect(state.counts().completions).toBe(0);
  });

  it("rejects stale time and an unknown key version", async () => {
    const state = callbackStore();
    const handler = makeDanceAttemptCallbackHandler({ authenticator, store: state.store });
    expect(
      (await handler(await requestFor(payload(), { timestamp: String(NOW_MS - 30_001) }))).status,
    ).toBe(401);
    expect(
      (await handler(await requestFor(payload(), { keyVersion: "callback-key-unknown" }))).status,
    ).toBe(401);
    expect(state.counts().completions).toBe(0);
  });

  it("rejects a callback bound to another attempt or lease fence", async () => {
    const state = callbackStore();
    const handler = makeDanceAttemptCallbackHandler({ authenticator, store: state.store });
    const wrongAttempt = {
      ...outcome,
      binding: { ...outcome.binding, attemptId: "attempt-2" },
    };
    const wrongFence = {
      ...outcome,
      binding: { ...outcome.binding, claimFence: 2 },
    };
    expect((await handler(await requestFor(payload(wrongAttempt)))).status).toBe(400);
    expect((await handler(await requestFor(payload(wrongFence)))).status).toBe(400);
    expect(state.counts().completions).toBe(0);
  });
});
