import { describe, expect, test } from "bun:test";
import { type AttendanceConfig, evaluateAttendance } from "./attendance";

// The old repo had no unit suite for booking-attendance-evaluator.ts; these
// invariants were characterized against its observed behavior (2026-08-15)
// before the port and must keep holding here.

const SLOT_START = "2026-07-02T10:00:00.000Z";
const SLOT_END = "2026-07-02T11:00:00.000Z";

// Samples every 30s for the full hour => one continuous interval.
function continuous(from = SLOT_START, to = SLOT_END): string[] {
  const samples: string[] = [];
  const start = Date.parse(from);
  const end = Date.parse(to);
  for (let t = start; t <= end; t += 30_000) samples.push(new Date(t).toISOString());
  return samples;
}

// Default config: required overlap = min(10min, 50% of 60min) = 10min; a solo
// presence must last at least 60s to count as attended.
describe("evaluateAttendance", () => {
  test("both parties present for the slot with sufficient overlap completes the booking", () => {
    const samples = continuous();
    const result = evaluateAttendance({
      hostSamplesUtc: samples,
      bookerSamplesUtc: samples,
      slotStartUtc: SLOT_START,
      slotEndUtc: SLOT_END,
    });
    expect(result).toMatchObject({
      outcome: "completed",
      hostAttended: true,
      bookerAttended: true,
      requiredOverlapMs: 600_000,
    });
    expect(result.overlapMs).toBeGreaterThanOrEqual(600_000);
  });

  test("host alone for the slot is a booker no-show", () => {
    const samples = continuous();
    const result = evaluateAttendance({
      hostSamplesUtc: samples,
      bookerSamplesUtc: [],
      slotStartUtc: SLOT_START,
      slotEndUtc: SLOT_END,
    });
    expect(result).toMatchObject({
      outcome: "no_show_booker",
      hostAttended: true,
      bookerAttended: false,
    });
  });

  test("booker alone for the slot is a host no-show", () => {
    const samples = continuous();
    const result = evaluateAttendance({
      hostSamplesUtc: [],
      bookerSamplesUtc: samples,
      slotStartUtc: SLOT_START,
      slotEndUtc: SLOT_END,
    });
    expect(result).toMatchObject({
      outcome: "no_show_host",
      hostAttended: false,
      bookerAttended: true,
    });
  });

  test("nobody present or sub-minute presence is ambiguous", () => {
    const brief = [SLOT_START, "2026-07-02T10:00:20.000Z"];
    expect(
      evaluateAttendance({
        hostSamplesUtc: [],
        bookerSamplesUtc: [],
        slotStartUtc: SLOT_START,
        slotEndUtc: SLOT_END,
      }).outcome,
    ).toBe("ambiguous");
    expect(
      evaluateAttendance({
        hostSamplesUtc: brief,
        bookerSamplesUtc: brief,
        slotStartUtc: SLOT_START,
        slotEndUtc: SLOT_END,
      }).outcome,
    ).toBe("ambiguous");
  });

  test("samples outside the slot are clipped and cannot manufacture attendance", () => {
    const outside = continuous("2026-07-02T08:00:00.000Z", "2026-07-02T09:59:00.000Z");
    const result = evaluateAttendance({
      hostSamplesUtc: outside,
      bookerSamplesUtc: outside,
      slotStartUtc: SLOT_START,
      slotEndUtc: SLOT_END,
    });
    expect(result).toMatchObject({
      outcome: "ambiguous",
      hostAttended: false,
      bookerAttended: false,
      overlapMs: 0,
    });
  });

  test("a heartbeat gap beyond staleMs splits presence into separate intervals", () => {
    // Two 4-minute shared stretches with a long gap: the LONGEST interval,
    // not the total, decides attendance (each party is attended), and the
    // summed 8-minute overlap stays below the 10-minute requirement.
    const first = continuous("2026-07-02T10:00:00.000Z", "2026-07-02T10:04:00.000Z");
    const second = continuous("2026-07-02T10:30:00.000Z", "2026-07-02T10:34:00.000Z");
    const result = evaluateAttendance({
      hostSamplesUtc: [...first, ...second],
      bookerSamplesUtc: [...first, ...second],
      slotStartUtc: SLOT_START,
      slotEndUtc: SLOT_END,
    });
    expect(result).toMatchObject({
      outcome: "ambiguous",
      hostAttended: true,
      bookerAttended: true,
      overlapMs: 480_000,
    });
    expect(result.overlapMs).toBeLessThan(result.requiredOverlapMs);
  });

  test("overlap below the requirement with both attended is ambiguous, not completed", () => {
    const host = continuous("2026-07-02T10:00:00.000Z", "2026-07-02T10:10:00.000Z");
    const booker = continuous("2026-07-02T10:45:00.000Z", "2026-07-02T10:55:00.000Z");
    const result = evaluateAttendance({
      hostSamplesUtc: host,
      bookerSamplesUtc: booker,
      slotStartUtc: SLOT_START,
      slotEndUtc: SLOT_END,
    });
    expect(result).toMatchObject({
      outcome: "ambiguous",
      hostAttended: true,
      bookerAttended: true,
      overlapMs: 0,
    });
  });

  test("required overlap scales down with a short slot via overlapSlotFraction", () => {
    const samples = continuous("2026-07-02T10:00:00.000Z", "2026-07-02T10:04:00.000Z");
    const result = evaluateAttendance({
      hostSamplesUtc: samples,
      bookerSamplesUtc: samples,
      slotStartUtc: "2026-07-02T10:00:00.000Z",
      slotEndUtc: "2026-07-02T10:04:00.000Z",
    });
    // min(10min, floor(4min * 0.5)) = 2min of overlap required.
    expect(result.requiredOverlapMs).toBe(120_000);
    expect(result.outcome).toBe("completed");
  });

  test("a zero-length slot can never complete (required overlap must be positive)", () => {
    const result = evaluateAttendance({
      hostSamplesUtc: [SLOT_START],
      bookerSamplesUtc: [SLOT_START],
      slotStartUtc: SLOT_START,
      slotEndUtc: SLOT_START,
    });
    expect(result.requiredOverlapMs).toBe(0);
    expect(result.outcome).toBe("ambiguous");
  });

  test("unparseable samples are ignored rather than failing the evaluation", () => {
    const samples = continuous();
    const result = evaluateAttendance({
      hostSamplesUtc: ["not-a-date", ...samples],
      bookerSamplesUtc: samples,
      slotStartUtc: SLOT_START,
      slotEndUtc: SLOT_END,
    });
    expect(result.outcome).toBe("completed");
  });

  test("honours a custom config: staleMs bounds the heartbeat gap", () => {
    const config: AttendanceConfig = {
      staleMs: 5_000,
      minOverlapMs: 600_000,
      overlapSlotFraction: 0.5,
      minSoloAttendanceMs: 60_000,
    };
    // 30s-spaced samples now exceed staleMs, so presence fragments into
    // 1-sample intervals and nobody is attended.
    const samples = continuous();
    const result = evaluateAttendance({
      hostSamplesUtc: samples,
      bookerSamplesUtc: samples,
      slotStartUtc: SLOT_START,
      slotEndUtc: SLOT_END,
      config,
    });
    expect(result).toMatchObject({
      outcome: "ambiguous",
      hostAttended: false,
      bookerAttended: false,
      overlapMs: 0,
    });
  });
});
