import { describe, expect, it } from "bun:test";
import { boundaryFailureDiagnostic, redactDiagnosticText } from "./failure-diagnostics.ts";

const diagnostic = (error: unknown) =>
  boundaryFailureDiagnostic({
    requestId: "request-1",
    endpoint: "StartHnsRootImport",
    route: "/communities/:communityId/hns-root-imports",
    method: "POST",
    disposition: "replaced",
    error,
  });

describe("redactDiagnosticText", () => {
  it("removes a password from a connection string", () => {
    expect(redactDiagnosticText("connect postgres://reader:hunter2@db.internal:5432/app")).toBe(
      "connect postgres://reader:[redacted]@db.internal:5432/app",
    );
  });

  it("removes a presented HTTP credential", () => {
    expect(redactDiagnosticText("rejected Bearer abc.def-ghi_jkl")).toBe(
      "rejected Bearer [redacted]",
    );
  });

  it("removes a named secret assigned with either separator", () => {
    expect(redactDiagnosticText('cookie: pirate_session=value-1; password="p4ssw0rd"')).toBe(
      "cookie=[redacted]; password=[redacted]",
    );
  });

  it("removes a signed token presented without a name", () => {
    expect(redactDiagnosticText("rejected aaaaaaaaaa.bbbbbbbbbb.cccccccccc here")).toBe(
      "rejected [redacted] here",
    );
  });

  it("removes an undelimited opaque run", () => {
    expect(redactDiagnosticText(`value ${"a1b2c3d4".repeat(5)} rejected`)).toBe(
      "value [redacted] rejected",
    );
  });

  it("keeps the identifiers this product logs on purpose", () => {
    const text =
      "community_49b2e557-753b-4a58-9338-54d7c3c9dc4f violates unique constraint hns_one_open_parent (23505)";
    expect(redactDiagnosticText(text)).toBe(text);
  });

  it("collapses whitespace so one failure stays one log line", () => {
    expect(redactDiagnosticText("first\n  second\tthird ")).toBe("first second third");
  });
});

describe("boundaryFailureDiagnostic", () => {
  it("carries the correlation fields the response also returns", () => {
    expect(diagnostic(new Error("boom"))).toMatchObject({
      request_id: "request-1",
      endpoint: "StartHnsRootImport",
      route: "/communities/:communityId/hns-root-imports",
      method: "POST",
      disposition: "replaced",
      error_name: "Error",
      error_message: "boom",
    });
  });

  it("keeps a driver code and message from a database failure", () => {
    const failure = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
    });

    expect(diagnostic(failure)).toMatchObject({
      error_code: "23505",
      error_message: "duplicate key value violates unique constraint",
    });
  });

  it("keeps the tagged type of an Effect failure", () => {
    expect(diagnostic({ _tag: "HnsAdmissionFailure", message: "no open parent" })).toMatchObject({
      error_tag: "HnsAdmissionFailure",
      error_message: "no open parent",
    });
  });

  it("retains no field it was not asked for", () => {
    const failure = Object.assign(new Error("insert failed"), {
      code: "23505",
      // The shapes a driver attaches that carry caller data verbatim.
      detail: "Key (community_id)=(community_49b2e557) already exists.",
      query: "INSERT INTO hns_root_import_sessions (community_id) VALUES ($1)",
      parameters: ["community_49b2e557"],
      request: { headers: { cookie: "pirate_session=value-1" } },
    });
    const serialized = JSON.stringify(diagnostic(failure));

    expect(Object.keys(diagnostic(failure)).sort()).toEqual([
      "disposition",
      "endpoint",
      "error_code",
      "error_message",
      "error_name",
      "method",
      "request_id",
      "route",
      "stack",
    ]);
    expect(serialized).not.toContain("Key (community_id)");
    expect(serialized).not.toContain("INSERT INTO");
    expect(serialized).not.toContain("pirate_session");
  });

  it("redacts a credential a driver put into the message", () => {
    const failure = new Error("connection to postgres://reader:hunter2@db.internal failed");

    expect(diagnostic(failure).error_message).toBe(
      "connection to postgres://reader:[redacted]@db.internal failed",
    );
  });

  it("refuses a code field that is prose rather than a code", () => {
    const failure = Object.assign(new Error("failed"), {
      code: "the session cookie pirate_session=value-1 was rejected",
    });

    expect(diagnostic(failure).error_code).toBeUndefined();
  });

  it("truncates a long message instead of dropping it", () => {
    const failure = new Error("row rejected ".repeat(100));
    const message = diagnostic(failure).error_message ?? "";

    expect(message.endsWith("…[truncated]")).toBe(true);
    expect(message.length).toBeLessThan(400);
  });

  it("bounds the retained stack", () => {
    const frames = diagnostic(new Error("boom")).stack ?? [];

    expect(frames.length).toBeGreaterThan(0);
    expect(frames.length).toBeLessThanOrEqual(6);
    for (const frame of frames) expect(frame.startsWith("at ")).toBe(true);
  });

  it("follows the cause a handler preserved when it mapped the failure", () => {
    const storage = Object.assign(new Error("relation hns_root_import_sessions does not exist"), {
      _tag: "HnsCommunityRootImportStorageFailed",
      code: "42P01",
    });
    const wire = Object.assign(new Error("HNS community root import failed"), { cause: storage });

    expect(diagnostic(wire).causes).toEqual([
      {
        error_name: "Error",
        error_tag: "HnsCommunityRootImportStorageFailed",
        error_code: "42P01",
        error_message: "relation hns_root_import_sessions does not exist",
      },
    ]);
  });

  it("redacts a cause and bounds the chain it follows", () => {
    const root = Object.assign(new Error("connect postgres://reader:hunter2@db.internal failed"), {
      cause: new Error("depth 4 must not be retained"),
    });
    let wrapped: unknown = root;
    for (const label of ["depth 3", "depth 2", "depth 1"]) {
      wrapped = Object.assign(new Error(label), { cause: wrapped });
    }
    const causes = diagnostic(wrapped).causes ?? [];

    expect(causes).toHaveLength(3);
    expect(causes.at(-1)?.error_message).toBe(
      "connect postgres://reader:[redacted]@db.internal failed",
    );
    expect(JSON.stringify(causes)).not.toContain("depth 4");
  });

  it("survives a cause chain that points at itself", () => {
    const looping: { message: string; cause?: unknown } = { message: "looping failure" };
    looping.cause = looping;

    expect(diagnostic(looping).causes).toBeUndefined();
  });

  it("describes a thrown value that is not an error at all", () => {
    expect(diagnostic("plain string failure")).toMatchObject({
      error_name: "string",
      error_message: "plain string failure",
    });
    expect(diagnostic(undefined)).toMatchObject({ error_name: "undefined" });
  });
});
