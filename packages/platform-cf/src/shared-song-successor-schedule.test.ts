import { expect, test } from "bun:test";
import type { MegapotV2DeploymentAttestation } from "./megapot-v2.ts";
import {
  hasSharedSongSuccessorFundingWindow,
  projectSharedSongSuccessor,
  SHARED_SONG_SUCCESSOR_RULE,
} from "./shared-song-successor-schedule.ts";

const input = {
  deployment: {
    ...SHARED_SONG_SUCCESSOR_RULE,
    environment: "test",
    attestationId: "fixture",
    usdcAddress: `0x${"1".repeat(40)}`,
    ticketNftAddress: `0x${"2".repeat(40)}`,
    custodyAddress: `0x${"3".repeat(40)}`,
    referrerAddress: `0x${"4".repeat(40)}`,
    ticketNftCodeHash: `0x${"a".repeat(64)}`,
    usdcCodeHash: `0x${"b".repeat(64)}`,
  } satisfies MegapotV2DeploymentAttestation,
  currentId: 42n,
  current: { drawingTime: 1801n, ticketPrice: 10000n, jackpotLock: false },
  recurrence: { durationSeconds: 1800n, ticketPrice: 10000n },
};

test("successor projection is conditional on the exact verified staging deployment and settings", () => {
  expect(projectSharedSongSuccessor(input)).toMatchObject({
    drawingId: "43",
    drawingTimeMs: 3_601_000,
    priceAtomic: 10000n,
    proofKind: "attested_recurrence",
  });
  for (const deployment of [
    { ...input.deployment, environment: "production" as const },
    { ...input.deployment, chainId: 8453 },
    { ...input.deployment, jackpotAddress: `0x${"f".repeat(40)}` },
    { ...input.deployment, jackpotCodeHash: `0x${"f".repeat(64)}` },
  ])
    expect(projectSharedSongSuccessor({ ...input, deployment })).toBeNull();
  for (const currentId of [0n, -1n, (1n << 256n) - 1n])
    expect(projectSharedSongSuccessor({ ...input, currentId })).toBeNull();
  expect(
    projectSharedSongSuccessor({ ...input, current: { ...input.current, jackpotLock: true } }),
  ).toBeNull();
  expect(
    projectSharedSongSuccessor({
      ...input,
      current: { ...input.current, drawingTime: 1n << 255n },
    }),
  ).toBeNull();
});

test("the final funding window includes quote age, reservation and safety at the exact boundary", () => {
  const plan = projectSharedSongSuccessor(input);
  if (plan === null) throw Error("Expected conditional plan");
  const boundary = {
    plan,
    observedAtMs: plan.purchaseDeadlineAtMs - 2_010_000,
    quoteMaxAgeMs: 120_000,
    reservationMs: 60_000,
    safetyMarginMs: 30_000,
  };
  expect(hasSharedSongSuccessorFundingWindow(boundary)).toBe(true);
  expect(
    hasSharedSongSuccessorFundingWindow({ ...boundary, observedAtMs: boundary.observedAtMs + 1 }),
  ).toBe(false);
  expect(hasSharedSongSuccessorFundingWindow({ ...boundary, quoteMaxAgeMs: 120_001 })).toBe(false);
  for (const invalid of [NaN, Infinity, -1, 0.5])
    expect(hasSharedSongSuccessorFundingWindow({ ...boundary, safetyMarginMs: invalid })).toBe(
      false,
    );
  expect(
    hasSharedSongSuccessorFundingWindow({ ...boundary, observedAtMs: Number.MAX_SAFE_INTEGER }),
  ).toBe(false);
});
