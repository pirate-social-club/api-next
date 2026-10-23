import { expect, test } from "bun:test";
import { makeWorkerRequestDiagnostics } from "./worker-request-diagnostics.ts";

test("initializes once at first request and isolates overlapping request contexts", async () => {
  const records: Readonly<Record<string, string | number | boolean | null>>[] = [];
  let generated = 0;
  const diagnostics = makeWorkerRequestDiagnostics({
    randomUUID: () => {
      generated += 1;
      return "opaque-instance";
    },
    now: () => 42,
    log: (record) => {
      records.push(record);
    },
  });
  expect(generated).toBe(0);
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const run = (wait: Promise<void>) =>
    diagnostics.run("version", async () => {
      const entry = diagnostics.current();
      await wait;
      expect(diagnostics.current()).toBe(entry);
      diagnostics.current()?.emit({ phase: "authority", outcome: "success" });
    });
  const a = run(first.promise);
  const b = run(second.promise);
  expect(diagnostics.current()).toBeUndefined();
  second.resolve();
  await b;
  first.resolve();
  await a;
  expect(generated).toBe(1);
  expect(
    records.map((record) => [
      record.request_sequence,
      record.first_request_on_instance,
      record.phase,
    ]),
  ).toEqual([
    [1, true, "request_entry"],
    [2, false, "request_entry"],
    [2, false, "authority"],
    [1, true, "authority"],
  ]);
  expect(new Set(records.map((record) => record.instance_id)).size).toBe(1);
});

test("diagnostic sink failure cannot fail a request", () => {
  const diagnostics = makeWorkerRequestDiagnostics({
    randomUUID: () => "opaque-instance",
    log: () => {
      throw new Error("sink unavailable");
    },
  });
  expect(diagnostics.run(null, () => "accepted")).toBe("accepted");
});

test("operation correlation preserves request identity, restores its parent and leaves explicit ownership intact", async () => {
  let generated = 0;
  const records: unknown[] = [];
  const diagnostics = makeWorkerRequestDiagnostics({
    randomUUID: () => `opaque-${++generated}`,
    log: (record) => records.push(record),
  });
  expect(diagnostics.correlateDatabase(() => diagnostics.current())).toBeUndefined();
  expect(generated).toBe(0);
  await diagnostics.run("version", async () => {
    const parent = diagnostics.current();
    await diagnostics.correlateDatabase(async () => {
      await Promise.resolve();
      const child = diagnostics.current();
      expect(child).toMatchObject({ ...parent, database_correlation_id: "opaque-2" });
      expect(diagnostics.correlateDatabase(() => diagnostics.current())).toBe(child);
      await expect(
        diagnostics.correlateDatabase(async () => {
          throw new Error("private");
        }),
      ).rejects.toThrow("private");
      expect(diagnostics.current()).toBe(child);
    });
    expect(diagnostics.current()).toBe(parent);
  });
  diagnostics.run(
    "version",
    () => {
      const parent = diagnostics.current();
      expect(diagnostics.correlateDatabase(() => diagnostics.current())).toBe(parent);
    },
    "existing-owner",
  );
  expect(generated).toBe(2);
  expect(records).toHaveLength(2);
  expect(diagnostics.current()).toBeUndefined();
});

test("an unavailable operation correlation cannot retry or fail the actual operation", () => {
  let generated = 0,
    invoked = 0;
  const diagnostics = makeWorkerRequestDiagnostics({
    randomUUID: () => {
      if (++generated > 1) throw new Error("unavailable");
      return "instance";
    },
    log: () => {},
  });
  expect(
    diagnostics.run(null, () =>
      diagnostics.correlateDatabase(() => {
        invoked++;
        expect(diagnostics.current()?.database_correlation_id).toBeUndefined();
        return "accepted";
      }),
    ),
  ).toBe("accepted");
  expect(invoked).toBe(1);
});
