/**
 * Fair turns across the provisioner's job classes.
 *
 * The loop used to be provisioning-first with observation as a fallback: a
 * backlog of provisioning starved every other class, and the lifecycle runner
 * had no caller at all. A round now offers each class one turn, so no class can
 * be starved by another's backlog, and the starting class rotates so no class is
 * permanently first when several are contended.
 *
 * Teardown is not a fourth class here. Teardown work is claimed by the same
 * function that claims readiness observation, which offers teardown first, so
 * teardown takes the observation turn. With lifecycle-managed operations now
 * excluded from the older readiness path, that turn is mostly teardown.
 *
 * Round outcomes are data, not effects: the caller decides what to log and how
 * long to wait. That keeps the scheduler testable without a database.
 */

export const HNS_EXECUTOR_CLASSES_V1 = ["lifecycle", "provisioning", "observation"] as const;

export type HnsExecutorClassV1 = (typeof HNS_EXECUTOR_CLASSES_V1)[number];

/** One class's turn: whether it took work, and what to report about it. */
type HnsExecutorTurnResultV1 = Readonly<{
  readonly claimed: boolean;
  readonly outcome: string;
  readonly detail?: unknown;
}>;

export type HnsExecutorRunnersV1 = Readonly<
  Record<HnsExecutorClassV1, () => Promise<HnsExecutorTurnResultV1>>
>;

export type HnsExecutorRoundV1 = Readonly<{
  readonly next_cursor: number;
  readonly idle: boolean;
  readonly turns: readonly Readonly<{
    readonly executor_class: HnsExecutorClassV1;
    readonly result: HnsExecutorTurnResultV1;
  }>[];
}>;

/** The class order for one round, rotated by the cursor. */
export function hnsExecutorRoundOrderV1(cursor: number): readonly HnsExecutorClassV1[] {
  const size = HNS_EXECUTOR_CLASSES_V1.length;
  const start = ((Math.trunc(cursor) % size) + size) % size;
  return Array.from({ length: size }, (_unused, offset) => {
    const executorClass = HNS_EXECUTOR_CLASSES_V1[(start + offset) % size];
    if (executorClass === undefined) throw new Error("HNS executor class rotation is invalid");
    return executorClass;
  });
}

/**
 * Runs one turn of every class, in rotated order.
 *
 * A class that throws does not cancel the round: the other classes still get
 * their turn and the failure is reported as that class's outcome. One provider
 * being unreachable must not stop unrelated work, which is the same reason the
 * runner treats an outage as evidence about the provider rather than the name.
 */
export async function runHnsExecutorRoundV1(
  cursor: number,
  runners: HnsExecutorRunnersV1,
): Promise<HnsExecutorRoundV1> {
  const turns: {
    readonly executor_class: HnsExecutorClassV1;
    readonly result: HnsExecutorTurnResultV1;
  }[] = [];
  for (const executorClass of hnsExecutorRoundOrderV1(cursor)) {
    let result: HnsExecutorTurnResultV1;
    try {
      result = await runners[executorClass]();
    } catch (error) {
      result = {
        claimed: false,
        outcome: "error",
        detail: error instanceof Error ? error.message : "unknown",
      };
    }
    turns.push({ executor_class: executorClass, result });
  }
  return {
    next_cursor: Math.trunc(cursor) + 1,
    idle: turns.every((turn) => !turn.result.claimed),
    turns,
  };
}
