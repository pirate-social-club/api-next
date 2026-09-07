import { expect, test } from "bun:test";
import { videoReservationLifetimeSeconds } from "./publication.ts";

test("reservation includes transfer time rounded up at 32 KiB/s with a six-hour cap", () => {
  expect(videoReservationLifetimeSeconds(1)).toBe(3601);
  expect(videoReservationLifetimeSeconds(32768)).toBe(3601);
  expect(videoReservationLifetimeSeconds(32769)).toBe(3602);
  expect(videoReservationLifetimeSeconds(500 * 1024 * 1024)).toBe(19600);
  expect(videoReservationLifetimeSeconds(32768 * 18000)).toBe(21600);
  expect(videoReservationLifetimeSeconds(32768 * 18000 + 1)).toBe(21600);
});

test("reservation lifetime refuses invalid declared sizes", () => {
  for (const size of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(() => videoReservationLifetimeSeconds(size)).toThrow();
});
