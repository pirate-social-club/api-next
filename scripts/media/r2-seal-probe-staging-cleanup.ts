import type { StagingCleanupKey, StagingOperation } from "./r2-seal-probe-staging-evidence";
import type { StagingDeleteResult, StagingHeadResult } from "./r2-seal-probe-staging-transport";

type CleanupTransport = Readonly<{
  deleteObject: (bucket: string, key: string) => Promise<StagingDeleteResult>;
  headObject: (bucket: string, key: string) => Promise<StagingHeadResult>;
}>;

export type CleanupResult = Readonly<{
  status: "complete" | "partial" | "not-attempted";
  keys: readonly StagingCleanupKey[];
}>;

export class CleanupResidualError extends Error {
  constructor(readonly result: CleanupResult) {
    super("staging cleanup left a run-owned object present");
    this.name = "CleanupResidualError";
  }
}

function operation(result: StagingOperation): StagingOperation {
  return { ...result, called: true };
}

export async function cleanupOwnedKeys(
  transport: CleanupTransport,
  bucket: string,
  prefix: string,
  ownedKeys: readonly string[],
): Promise<CleanupResult> {
  const keys = [...new Set(ownedKeys)];
  if (keys.length === 0) return { status: "not-attempted", keys: [] };
  const results: StagingCleanupKey[] = [];
  for (const key of keys) {
    if (!key.startsWith(prefix) || key === prefix || key.includes("..")) {
      throw new Error("cleanup key is outside the exact run-owned prefix");
    }
    const deletion = await transport.deleteObject(bucket, key);
    const absence = await transport.headObject(bucket, key);
    const absent = absence.kind === "missing" && absence.code === "NoSuchKey";
    results.push({
      key,
      delete: operation({ called: true, status: deletion.status, code: deletion.code }),
      absence: operation({ called: true, status: absence.status, code: absence.code }),
      absent,
    });
  }
  return {
    status: results.every(({ absent }) => absent) ? "complete" : "partial",
    keys: results,
  };
}

export function requireCompleteCleanup(result: CleanupResult): CleanupResult {
  if (result.status === "partial") throw new CleanupResidualError(result);
  return result;
}

/** Run the operation and cleanup independently; the operation failure wins if both fail. */
export async function runWithCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<CleanupResult>,
): Promise<Readonly<{ value: T; cleanup: CleanupResult }>> {
  let value: T | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    value = await operation();
  } catch (error: unknown) {
    operationFailed = true;
    operationError = error;
  }

  let cleanupResult: CleanupResult | undefined;
  let cleanupError: unknown;
  try {
    cleanupResult = await cleanup();
  } catch (error: unknown) {
    cleanupError = error;
  }
  const cleanupFailure =
    cleanupError ??
    (cleanupResult === undefined
      ? undefined
      : cleanupResult.status === "partial"
        ? new CleanupResidualError(cleanupResult)
        : undefined);

  if (operationFailed) {
    if (cleanupFailure !== undefined) {
      throw new AggregateError(
        [operationError, cleanupFailure],
        "staging operation failed and cleanup also failed",
      );
    }
    throw operationError;
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (value === undefined || cleanupResult === undefined) {
    throw new Error("staging workflow completed without an operation or cleanup result");
  }
  return { value, cleanup: cleanupResult };
}
