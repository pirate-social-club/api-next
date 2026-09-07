import { expect, test } from "bun:test";
import {
  assertSessionDiagnostic,
  describeSessionDiagnostic,
  describeSessionDiagnostics,
} from "./staging-persona-session-diagnostic";

const session = {
  pid: 42,
  userOid: "12345",
  role: "runtime",
  applicationName: "hyperdrive-client",
  backendType: "client backend",
  clientAddress: "192.0.2.10",
  backendStart: "2026-09-07T01:02:03.123456Z",
  state: "idle in transaction",
  queryStart: "2026-09-07T01:02:04Z",
} as const;

test("retains redacted session attribution without assuming Hyperdrive", () => {
  const result = describeSessionDiagnostic(session);
  expect(result).toMatchObject({
    pid: 42,
    user_oid: "12345",
    backend_start: "2026-09-07T01:02:03.123Z",
    query_start: "2026-09-07T01:02:04.000Z",
    state: "idle in transaction",
    attribution: "unresolved",
  });
  expect(result.role_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.application_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.backend_type_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.client_address_sha256).toMatch(/^[a-f0-9]{64}$/);
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("runtime");
  expect(serialized).not.toContain("hyperdrive");
  expect(serialized).not.toContain("SELECT");
  assertSessionDiagnostic(result);
});

test("keeps null identity fields and rejects malformed diagnostics", () => {
  expect(
    describeSessionDiagnostic({
      ...session,
      userOid: null,
      role: null,
      applicationName: null,
      backendType: null,
      clientAddress: null,
      backendStart: null,
      queryStart: null,
      state: null,
    }),
  ).toMatchObject({
    user_oid: null,
    role_sha256: null,
    application_sha256: null,
    backend_type_sha256: null,
    client_address_sha256: null,
    backend_start: null,
    query_start: null,
    state: null,
  });
  for (const change of [
    { pid: 0 },
    { userOid: "role" },
    { backendStart: "2026-09-07T01:02:03+00:00" },
    { state: "running;drop" },
  ]) {
    expect(() => describeSessionDiagnostic({ ...session, ...change })).toThrow();
  }
});

test("sorts and rejects duplicate backend PIDs", () => {
  expect(
    describeSessionDiagnostics([
      { ...session, pid: 2 },
      { ...session, pid: 1 },
    ]).map((v) => v.pid),
  ).toEqual([1, 2]);
  expect(() => describeSessionDiagnostics([session, session])).toThrow("duplicate_pid");
});
