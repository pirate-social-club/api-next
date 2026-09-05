import { expect, test } from "vitest";
import { makeWorkerRequestDiagnostics } from "../../packages/platform-cf/src/worker-request-diagnostics.ts";

// Construction at module load must not call crypto.randomUUID outside a request.
const records: Readonly<Record<string, string | number | boolean | null>>[] = [];
const diagnostics = makeWorkerRequestDiagnostics({
  log: (record) => {
    records.push(record);
  },
});

test("workerd permits first-request UUID creation and preserves concurrent async contexts", async () => {
  expect(records).toHaveLength(0);
  const release = Promise.withResolvers<void>();
  const first = diagnostics.run("test-version", async () => {
    await release.promise;
    diagnostics.current()?.emit({ phase: "authority", outcome: "canceled" });
  });
  await diagnostics.run("test-version", async () => {
    await Promise.resolve();
    diagnostics.current()?.emit({ phase: "authority", outcome: "success" });
  });
  release.resolve();
  await first;
  expect(diagnostics.current()).toBeUndefined();
  expect(records.map((record) => record.request_sequence)).toEqual([1, 2, 2, 1]);
  expect(records.map((record) => record.first_request_on_instance)).toEqual([
    true,
    false,
    false,
    true,
  ]);
  const id = records[0]?.instance_id;
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  expect(records.every((record) => record.instance_id === id)).toBe(true);
});
