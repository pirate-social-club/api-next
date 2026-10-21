import { expect, spyOn, test } from "bun:test";
import { Effect } from "effect";
import {
  HnsAuthorityDiagnostic,
  makeHnsAuthorityDiagnostic,
  withHnsAuthoritySpan,
} from "./hns-authority-diagnostics.ts";
import { httpRequestDiagnostics } from "./worker-request-diagnostics.ts";

test("attaches a validated correlation to the current request without logging failure contents", async () => {
  const records: unknown[] = [];
  const logger = spyOn(console, "info").mockImplementation((_event, record) => {
    records.push(record);
  });
  const id = "12345678-1234-4234-8234-123456789abc";
  try {
    expect(makeHnsAuthorityDiagnostic(id)).toBeUndefined();
    await httpRequestDiagnostics.run("test-version", async () => {
      await Promise.resolve();
      expect(makeHnsAuthorityDiagnostic(null)).toBeUndefined();
      expect(makeHnsAuthorityDiagnostic("public-forgery")).toBeUndefined();
      const result = await Effect.runPromiseExit(
        withHnsAuthoritySpan("authority", Effect.fail("private-failure-detail")).pipe(
          Effect.provideService(HnsAuthorityDiagnostic, makeHnsAuthorityDiagnostic(id)),
        ),
      );
      expect(result._tag).toBe("Failure");
    });
    expect(records).toHaveLength(3);
    expect(records[1]).toMatchObject({
      phase: "authority",
      outcome: "started",
      correlation_id: id,
    });
    expect(records[2]).toMatchObject({ phase: "authority", outcome: "failed", correlation_id: id });
    expect(JSON.stringify(records)).not.toContain("private-failure-detail");
    expect(JSON.stringify(records)).not.toContain("public-forgery");
  } finally {
    logger.mockRestore();
  }
});

test("public-list timings stay request-local and explicit authority context takes priority", async () => {
  const records: Record<string, unknown>[] = [];
  const explicit: unknown[] = [];
  const logger = spyOn(console, "info").mockImplementation((_event, record) =>
    records.push(record),
  );
  const first = "12345678-1234-4234-8234-123456789abc";
  const second = "22345678-1234-4234-8234-123456789abc";
  try {
    await Promise.all(
      [first, second].map((id) =>
        httpRequestDiagnostics.run(
          "version",
          async () => {
            await Promise.resolve();
            await Effect.runPromise(withHnsAuthoritySpan("query", Effect.void));
            await Effect.runPromise(
              withHnsAuthoritySpan("authority", Effect.void).pipe(
                Effect.provideService(HnsAuthorityDiagnostic, {
                  correlation_id: "explicit",
                  emit: (fields) => explicit.push(fields),
                }),
              ),
            );
          },
          id,
        ),
      ),
    );
    expect(
      records
        .filter((record) => record.phase === "query")
        .map((record) => record.correlation_id)
        .sort(),
    ).toEqual([first, first, second, second].sort());
    expect(records.filter((record) => record.phase === "authority")).toHaveLength(0);
    expect(explicit).toHaveLength(4);
    expect(
      explicit.every(
        (record) =>
          typeof record === "object" &&
          record !== null &&
          "correlation_id" in record &&
          record.correlation_id === "explicit",
      ),
    ).toBe(true);
    const before = records.length;
    await httpRequestDiagnostics.run("version", () =>
      Effect.runPromise(withHnsAuthoritySpan("query", Effect.void)),
    );
    expect(records.length).toBe(before + 1);
    expect(httpRequestDiagnostics.current()).toBeUndefined();
  } finally {
    logger.mockRestore();
  }
});
