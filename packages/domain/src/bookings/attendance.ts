export type AttendanceOutcome = "completed" | "no_show_host" | "no_show_booker" | "ambiguous";
export type AttendanceConfig = {
  staleMs: number;
  minOverlapMs: number;
  overlapSlotFraction: number;
  minSoloAttendanceMs: number;
};
export type AttendanceEvaluation = {
  outcome: AttendanceOutcome;
  hostAttended: boolean;
  bookerAttended: boolean;
  overlapMs: number;
  requiredOverlapMs: number;
};
const DEFAULTS: AttendanceConfig = {
  staleMs: 90_000,
  minOverlapMs: 600_000,
  overlapSlotFraction: 0.5,
  minSoloAttendanceMs: 60_000,
};
type Interval = readonly [number, number];
function intervals(
  samples: readonly string[],
  staleMs: number,
  lo: number,
  hi: number,
): Interval[] {
  const timestamps = samples
    .map(Date.parse)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const first = timestamps[0];
  if (first === undefined) return [];
  const raw: Array<[number, number]> = [];
  let start = first;
  let previous = start;
  for (const timestamp of timestamps.slice(1)) {
    if (timestamp - previous <= staleMs) previous = timestamp;
    else {
      raw.push([start, previous]);
      start = timestamp;
      previous = timestamp;
    }
  }
  raw.push([start, previous]);
  return raw.map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)] as const).filter(([a, b]) => b > a);
}
function longest(values: readonly Interval[]): number {
  return values.reduce((max, [a, b]) => Math.max(max, b - a), 0);
}
function overlap(a: readonly Interval[], b: readonly Interval[]): number {
  return a.reduce(
    (sum, [as, ae]) =>
      sum +
      b.reduce((inner, [bs, be]) => inner + Math.max(0, Math.min(ae, be) - Math.max(as, bs)), 0),
    0,
  );
}
export function evaluateAttendance(input: {
  hostSamplesUtc: readonly string[];
  bookerSamplesUtc: readonly string[];
  slotStartUtc: string;
  slotEndUtc: string;
  config?: AttendanceConfig;
}): AttendanceEvaluation {
  const config = input.config ?? DEFAULTS;
  const start = Date.parse(input.slotStartUtc);
  const end = Date.parse(input.slotEndUtc);
  const requiredOverlapMs = Math.min(
    config.minOverlapMs,
    Math.floor(Math.max(0, end - start) * config.overlapSlotFraction),
  );
  const host = intervals(input.hostSamplesUtc, config.staleMs, start, end);
  const booker = intervals(input.bookerSamplesUtc, config.staleMs, start, end);
  const hostAttended = longest(host) >= config.minSoloAttendanceMs;
  const bookerAttended = longest(booker) >= config.minSoloAttendanceMs;
  const overlapMs = overlap(host, booker);
  const outcome =
    overlapMs >= requiredOverlapMs && requiredOverlapMs > 0
      ? "completed"
      : hostAttended && !bookerAttended
        ? "no_show_booker"
        : bookerAttended && !hostAttended
          ? "no_show_host"
          : "ambiguous";
  return { outcome, hostAttended, bookerAttended, overlapMs, requiredOverlapMs };
}
