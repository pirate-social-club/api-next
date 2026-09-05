import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { VideoSubmissionState } from "../../../domain/src/video-submission.ts";
import { providers, services, transform } from "./analysis.test-fixtures.ts";
import {
  runOriginalVideoAnalysis,
  VideoAnalysisPending,
  VideoAnalysisRetryable,
} from "./analysis.ts";

describe("original-video trusted analysis runtime", () => {
  test("attempt-store failure escapes without consuming an author retry", async () => {
    let failures = 0;
    const runtime = services({
      providers: providers(),
      onFailure: () => failures++,
      transformAttempts: {
        loadOrCreate: async () => {
          throw new Error("database unavailable");
        },
        advance: async () => {
          throw new Error("unexpected advance");
        },
      },
    });
    await expect(
      runOriginalVideoAnalysis(
        {
          submissionId: "video-analysis-submission",
          operationId: "video-analysis-operation",
        },
        runtime,
      ),
    ).rejects.toThrow("database unavailable");
    expect(failures).toBe(0);
  });

  test("persists provider progress and defers without recording a technical failure", async () => {
    const advanced: Array<string | undefined> = [];
    let failures = 0;
    const pendingTransform = transform({
      probe: (input) =>
        Effect.succeed({
          status: "processing",
          attempt: {
            ...input.attempt,
            providerJobId: input.binding.requestId,
            providerJobPhase: "started",
          },
        }),
    });
    const runtime = services({
      providers: providers(),
      transform: pendingTransform,
      transformAttempts: {
        loadOrCreate: async ({ initialAttempt }) => initialAttempt,
        advance: async ({ attempt }) => {
          advanced.push(attempt.providerJobPhase);
          return attempt;
        },
      },
      onFailure: () => failures++,
    });

    await expect(
      runOriginalVideoAnalysis(
        { submissionId: "video-analysis-submission", operationId: "video-analysis-operation" },
        runtime,
      ),
    ).rejects.toBeInstanceOf(VideoAnalysisPending);
    expect(advanced).toEqual(["allocated", "submitting", "started", "started"]);
    expect(failures).toBe(0);
  });

  test("leaves a retryable provider failure to the durable execution retry policy", async () => {
    let failures = 0;
    const retryableTransform = transform({
      probe: (input) =>
        Effect.succeed({
          status: "retryable_failure",
          reason: "transport",
          attempt: input.attempt,
        }),
    });

    await expect(
      runOriginalVideoAnalysis(
        { submissionId: "video-analysis-submission", operationId: "video-analysis-operation" },
        services({
          providers: providers(),
          transform: retryableTransform,
          onFailure: () => failures++,
        }),
      ),
    ).rejects.toBeInstanceOf(VideoAnalysisRetryable);
    expect(failures).toBe(0);
  });

  test("uses the persisted poster timestamp and publishes one closed trusted bundle", async () => {
    const decisions: VideoSubmissionState[] = [];
    const result = await runOriginalVideoAnalysis(
      { submissionId: "video-analysis-submission", operationId: "video-analysis-operation" },
      services({ providers: providers(), onDecision: (state) => decisions.push(state) }),
    );
    expect(result.status).toBe("published");
    expect(decisions[0]?.analysis?.frames.extracted[0]).toMatchObject({
      requestedTimestampMs: 1_500,
      timestampMs: 1_500,
    });
    expect(decisions[0]?.analysis?.safetyRequest.captionSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("routes ACR exhaustion and safety adapter absence to review, never implicit allow", async () => {
    const decisions: VideoSubmissionState[] = [];
    const result = await runOriginalVideoAnalysis(
      { submissionId: "video-analysis-submission", operationId: "video-analysis-operation" },
      services({
        providers: providers({
          identifySoundtrack: async () => {
            throw new Error("provider exhausted");
          },
          moderate: async () => {
            throw new Error("safety unavailable");
          },
        }),
        onDecision: (state) => decisions.push(state),
      }),
    );
    expect(result.status).toBe("manual_review");
    expect(decisions[0]?.reviewReasons).toContain("soundtrack_exhausted");
    expect(decisions[0]?.reviewReasons).toContain("safety_adapter_unavailable");
  });

  test("records poster extraction responsibility without discarding the sealed revision", async () => {
    const failures: string[] = [];
    const result = await runOriginalVideoAnalysis(
      { submissionId: "video-analysis-submission", operationId: "video-analysis-operation" },
      services({
        providers: providers(),
        transform: transform({
          extractVideoFrames: (input) =>
            Effect.succeed({
              status: "rejected",
              reason: "poster_timestamp_out_of_range",
              attempt: input.attempt,
            }),
        }),
        onFailure: (code) => failures.push(code),
      }),
    );
    expect(result).toMatchObject({
      status: "processing_failed",
      reason_code: "poster_timestamp_out_of_range",
      video_revision: 1,
    });
    expect(failures).toEqual(["poster_timestamp_out_of_range"]);
  });
});
