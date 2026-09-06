import { expect, test } from "bun:test";
import {
  assertRehearsalProviderRole,
  assertRehearsalSessionHeadroom,
  assertRehearsalSessions,
  describeRehearsalSessions,
} from "./staging-persona-rehearsal-sessions";

const provider = [
  {
    pid: 1,
    usename: "pscale_admin",
    application_sha256: "4d610df279c4c8ef752e6ce9ba073967a3ea23cc7d09024922ac9da4f17cf930",
  },
  {
    pid: 2,
    usename: "pscale_admin",
    application_sha256: "a2f5ec7abc29f65a8dfc0527aaca0fe6140718ccec2828d243c8ada40c5fe7e3",
  },
] as const;
const operator = { pid: 3, usename: "operator", application_sha256: null };

test("failure observations retain hashes and owned PIDs without role strings", () => {
  const described = describeRehearsalSessions(
    [operator, { pid: 4, usename: null, application_sha256: null }],
    [3],
  );
  expect(described[0]).toMatchObject({ pid: 3, owned: true, application_sha256: null });
  expect(described[0]?.role_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(described[1]).toEqual({
    pid: 4,
    owned: false,
    role_sha256: null,
    application_sha256: null,
    user_oid: null,
    backend_type_sha256: null,
  });
  expect(JSON.stringify(described)).not.toContain("operator");
  expect(JSON.stringify(described)).not.toContain("usename");
  expect(
    describeRehearsalSessions(
      [{ pid: 5, usename: null, user_oid: "12345", application_sha256: null }],
      [3],
    )[0]?.user_oid,
  ).toBe("12345");
});

test("accepts the observed provider baseline plus only the known operator connections", () => {
  expect(assertRehearsalSessions([...provider, operator], "operator", [3])).toMatchObject({
    provider_sessions: 2,
    operator_sessions: 1,
    total_sessions: 3,
    execution_authorized: false,
  });
  expect(
    assertRehearsalSessions([...provider, operator, { ...operator, pid: 4 }], "operator", [3, 4])
      .total_sessions,
  ).toBe(4);
});

test("refuses unexpected runtime and operator connections, not just other role names", () => {
  for (const usename of ["runtime", "operator", null]) {
    expect(() =>
      assertRehearsalSessions(
        [...provider, operator, { ...operator, pid: 4, usename }],
        "operator",
        [3],
      ),
    ).toThrow("unexpected_session");
  }
});

test("allows known provider applications to stop, reconnect or have several instances", () => {
  for (const sessions of [
    [operator],
    [provider[0], operator],
    [...provider, { ...provider[0], pid: 5 }, operator],
  ]) {
    expect(assertRehearsalSessions(sessions, "operator", [3]).total_sessions).toBe(sessions.length);
  }
});

test("refuses unattributed sessions even with an absent user OID and empty label", () => {
  const internal = {
    pid: 6,
    usename: null,
    user_oid: null,
    application_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  };
  expect(() => assertRehearsalSessions([...provider, operator, internal], "operator", [3])).toThrow(
    "unexpected_session",
  );
  for (const change of [
    { user_oid: "12345" },
    { application_sha256: null },
    { application_sha256: "a".repeat(64) },
  ]) {
    expect(() =>
      assertRehearsalSessions([...provider, operator, { ...internal, ...change }], "operator", [3]),
    ).toThrow("unexpected_session");
  }
});

test("records changed or hidden provider labels as observations", () => {
  expect(
    assertRehearsalSessions(
      [{ ...provider[0], application_sha256: "0".repeat(64) }, provider[1], operator],
      "operator",
      [3],
    ).provider_sessions,
  ).toBe(2);
  expect(
    assertRehearsalSessions(
      [{ ...provider[0], application_sha256: null }, provider[1], operator],
      "operator",
      [3],
    ).application_fingerprints,
  ).toContain(null);
});

test("refuses missing runner sessions and changed provider role flags", () => {
  expect(() => assertRehearsalSessions([...provider, operator], "operator", [3, 4])).toThrow(
    "owned_session_missing",
  );
  const role = {
    rolname: "pscale_admin",
    rolsuper: true,
    rolreplication: true,
    rolcreaterole: true,
    rolcreatedb: true,
    rolcanlogin: true,
  };
  expect(() => assertRehearsalProviderRole(role)).not.toThrow();
  for (const key of Object.keys(role)) {
    expect(() =>
      assertRehearsalProviderRole({ ...role, [key]: key === "rolname" ? "operator" : false }),
    ).toThrow("provider_role_changed");
    expect(() => assertRehearsalProviderRole({ ...role, [key]: undefined })).toThrow(
      "provider_role_changed",
    );
  }
  expect(() => assertRehearsalProviderRole(null)).toThrow("provider_role_changed");
});

test("rechecks headroom against changing provider session counts", () => {
  expect(() => assertRehearsalSessionHeadroom(4, 1200)).not.toThrow();
  expect(() => assertRehearsalSessionHeadroom(5, 1200)).toThrow("headroom_insufficient");
  expect(() => assertRehearsalSessionHeadroom(5, 1100)).not.toThrow();
  expect(() => assertRehearsalSessionHeadroom(4, 1201)).toThrow("headroom_insufficient");
  expect(() => assertRehearsalSessionHeadroom(0, 1200)).toThrow("headroom_insufficient");
});

test("refuses duplicate or invalid connection identities", () => {
  expect(() => assertRehearsalSessions([...provider, operator], "operator", [3, 3])).toThrow(
    "input_unproven",
  );
  expect(() => assertRehearsalSessions([...provider, operator, operator], "operator", [3])).toThrow(
    "input_unproven",
  );
  expect(() => assertRehearsalSessions([...provider, operator], "operator", [0])).toThrow(
    "input_unproven",
  );
});
