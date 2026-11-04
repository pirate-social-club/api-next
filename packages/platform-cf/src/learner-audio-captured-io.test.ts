import { expect, test } from "bun:test";
import { ControlPlaneTransactionOutcomeUnknown } from "@pirate/application";
import { Effect } from "effect";
import {
  type CapturedLearnerAudioUploadStore,
  type LearnerAudioUploadCapture,
  makeCapturedR2StudyAudioArchive,
} from "./learner-audio-captured-io.ts";

const payload = new Uint8Array([1, 2, 3]);
const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", payload)), (n) =>
  n.toString(16).padStart(2, "0"),
).join("");
const capture: LearnerAudioUploadCapture = {
  uploadAttemptId: "upload",
  sourceOwnerId: "owner",
  artifactId: "artifact",
  sourceKind: "study",
  attemptRef: "attempt",
  commandRef: "command",
  reservationRef: "reservation",
  capturedRevision: 0,
  objectRef: `learner-audio/study/attempt/${hash}`,
  contentDigest: hash,
  contentType: "audio/wav",
  byteSize: 3,
  durationMs: 100,
};
const ledger = (
  overrides: Partial<CapturedLearnerAudioUploadStore> = {},
): CapturedLearnerAudioUploadStore => ({
  claim: () => Effect.succeed({ state: "write" }),
  mayContinue: () => Effect.succeed(true),
  noteMultipartId: () => Effect.void,
  settle: () => Effect.succeed(true),
  ...overrides,
});
const result = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.match({
        onFailure: (error) => ({ state: "error" as const, error }),
        onSuccess: (value) => ({ state: "success" as const, value }),
      }),
    ),
  );
test("payload mismatch refuses before claim or PUT", async () => {
  let calls = 0;
  const archive = makeCapturedR2StudyAudioArchive(
    ledger({
      claim: () => {
        calls++;
        return Effect.succeed({ state: "write" });
      },
    }),
    {
      put: async () => {
        calls++;
        return { size: 3 };
      },
    },
    () => {},
  );
  const actual = await result(archive.store({ capture, audio: new Uint8Array([3, 2, 1]) }));
  expect(actual.state).toBe("error");
  if (actual.state === "error") expect(actual.error._tag).toBe("LearnerAudioCaptureRejected");
  expect(calls).toBe(0);
});
test("already unknown capture issues no new PUT", async () => {
  let calls = 0;
  const archive = makeCapturedR2StudyAudioArchive(
    ledger({ claim: () => Effect.succeed({ state: "unknown" }) }),
    {
      put: async () => {
        calls++;
        return { size: 3 };
      },
    },
    () => {},
  );
  const actual = await result(archive.store({ capture, audio: payload }));
  expect(actual.state).toBe("error");
  if (actual.state === "error") expect(actual.error._tag).toBe("LearnerAudioStorageOutcomeUnknown");
  expect(calls).toBe(0);
});
test("late successful PUT is settled under its original capture and cannot publish after fence", async () => {
  let release: (value: { size: number }) => void = () => {};
  let issued: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    issued = resolve;
  });
  const put = new Promise<{ size: number }>((resolve) => {
    release = resolve;
  });
  let fenced = false;
  const settlements: Parameters<CapturedLearnerAudioUploadStore["settle"]>[0][] = [];
  const tasks: Promise<unknown>[] = [];
  const archive = makeCapturedR2StudyAudioArchive(
    ledger({
      settle: (input) => {
        settlements.push(input);
        return Effect.succeed(!fenced);
      },
    }),
    {
      put: () => {
        issued();
        return put;
      },
    },
    (task) => tasks.push(task),
  );
  const pending = result(archive.store({ capture, audio: payload }));
  await started;
  fenced = true;
  release({ size: 3 });
  const actual = await pending;
  await Promise.all(tasks);
  expect(actual.state).toBe("success");
  if (actual.state === "success")
    expect(actual.value).toEqual({ state: "failed", objectRef: null });
  expect(settlements).toHaveLength(1);
  expect(settlements[0]).toEqual({
    capture,
    disposition: "stored",
    knownNoMoreIo: true,
    multipartId: null,
    terminalFact: { contentDigest: hash, contentType: "audio/wav", byteSize: 3, durationMs: 100 },
  });
});
test("rejected PUT retains unknown instead of inventing failed archive", async () => {
  const settlements: Parameters<CapturedLearnerAudioUploadStore["settle"]>[0][] = [];
  const archive = makeCapturedR2StudyAudioArchive(
    ledger({
      settle: (input) => {
        settlements.push(input);
        return Effect.succeed(false);
      },
    }),
    {
      put: async () => {
        throw new Error("controlled transport loss");
      },
    },
    () => {},
  );
  const actual = await result(archive.store({ capture, audio: payload }));
  expect(actual.state).toBe("error");
  if (actual.state === "error") expect(actual.error._tag).toBe("LearnerAudioStorageOutcomeUnknown");
  expect(settlements).toEqual([
    { capture, disposition: "failed", knownNoMoreIo: false, multipartId: null },
  ]);
});
test("settlement COMMIT uncertainty is retained; successful PUT does not fabricate publication", async () => {
  const failure = new ControlPlaneTransactionOutcomeUnknown({
    phase: "commit",
    label: "controlled-test.settle",
    limitMs: 3000,
    elapsedMs: 3001,
  });
  const archive = makeCapturedR2StudyAudioArchive(
    ledger({ settle: () => Effect.fail(failure) }),
    { put: async () => ({ size: 3 }) },
    () => {},
  );
  const actual = await result(archive.store({ capture, audio: payload }));
  expect(actual.state).toBe("error");
  if (actual.state === "error") expect(actual.error).toBe(failure);
});
test("settled stored replay avoids another PUT", async () => {
  let calls = 0;
  const archive = makeCapturedR2StudyAudioArchive(
    ledger({ claim: () => Effect.succeed({ state: "stored", objectRef: capture.objectRef }) }),
    {
      put: async () => {
        calls++;
        return { size: 3 };
      },
    },
    () => {},
  );
  const actual = await result(archive.store({ capture, audio: payload }));
  expect(actual).toEqual({
    state: "success",
    value: { state: "stored", objectRef: capture.objectRef },
  });
  expect(calls).toBe(0);
});
