import type { StagingCleanupKey, StagingOperation } from "./r2-seal-probe-staging-evidence";
import type { StagingDeleteResult, StagingHeadResult } from "./r2-seal-probe-staging-transport";

type CleanupTransport = Readonly<{
  deleteObject: (bucket: string, key: string) => Promise<StagingDeleteResult>;
  headObject: (bucket: string, key: string) => Promise<StagingHeadResult>;
}>;

function operation(result: StagingOperation): StagingOperation {
  return { ...result, called: true };
}

export async function cleanupOwnedKeys(
  transport: CleanupTransport,
  bucket: string,
  prefix: string,
  ownedKeys: readonly string[],
): Promise<Readonly<{ status: "complete" | "partial" | "not-attempted"; keys: readonly StagingCleanupKey[] }>> {
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
